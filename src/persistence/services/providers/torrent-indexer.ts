/**
 * Brazilian torrent indexer provider.
 *
 * Calls https://torrent-indexer.darklyn.org — a community indexer that aggregates
 * BR sources (comando-torrents, bludv, starck-filmes, etc.) and exposes JSON.
 *
 * Strategy:
 *   1. Resolve the title via Cinemeta (the /search endpoint ignores imdb=)
 *   2. Try the unified /search?q=<title> first (covers all sub-indexers)
 *   3. If that returns nothing, fan out to each sub-indexer individually
 *      (some are gated behind Cloudflare challenges that the aggregated
 *      endpoint sometimes bypasses)
 *   4. Filter by explicit `audio: ["Português", ...]` field — no fragile regex
 *
 * Reference: github.com/felipemarinho97/torrent-indexer
 */
import axios from 'axios';
import { decode } from 'magnet-uri';
import type { NormalizedStream } from './types';
import { fetchCinemeta } from '../cinemeta';
import { lookupTitles, tmdbAvailable } from '../tmdb';

const BASE = process.env.TORRENT_INDEXER_BASE || 'https://torrent-indexer.darklyn.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Stremio/4.4 MicoLeaoV2';
const TIMEOUT_MS = 7000;

/**
 * Sub-indexers exposed by the upstream. Order roughly by historical reliability.
 * Source: https://torrent-indexer.darklyn.org/indexers
 */
const SUB_INDEXERS = [
    'comando_torrents',
    'bludv',
    'starck-filmes',
    'torrent-dos-filmes',
    'filme_torrent',
    'rede_torrent',
    'vaca_torrent'
];

interface IndexerResult {
    title: string;
    original_title?: string;
    details?: string;
    year?: string;
    imdb?: string;
    audio?: string[];
    magnet_link?: string;
    info_hash?: string;
    trackers?: string[];
    size?: string;
    seed_count?: number;
    leech_count?: number;
    similarity?: number;
}

const PT_BR_AUDIO_MARKERS = ['portugu', 'pt-br', 'pt_br', 'brazilian'];

function hasPtBrAudio(r: IndexerResult): boolean {
    if (Array.isArray(r.audio)) {
        const joined = r.audio.join(' ').toLowerCase();
        if (PT_BR_AUDIO_MARKERS.some((m) => joined.includes(m))) return true;
    }
    const blob = `${r.title || ''} ${r.original_title || ''}`.toLowerCase();
    return /\bdubl|dual|pt-?br|portugu|brazilian/.test(blob);
}

function parseSize(s: string | undefined): number | undefined {
    if (!s) return undefined;
    const m = /([\d.]+)\s*(GB|MB|KB)/i.exec(s);
    if (!m) return undefined;
    const n = parseFloat(m[1]);
    const unit = m[2].toUpperCase();
    if (unit === 'GB') return Math.round(n * 1024 * 1024 * 1024);
    if (unit === 'MB') return Math.round(n * 1024 * 1024);
    return Math.round(n * 1024);
}

function toNormalized(r: IndexerResult, provider: string): NormalizedStream | null {
    let infoHash = r.info_hash?.toLowerCase();
    let trackers = r.trackers || [];
    if (!infoHash && r.magnet_link) {
        try {
            const dec = decode(r.magnet_link);
            if (dec.infoHash) infoHash = dec.infoHash.toLowerCase();
            if (Array.isArray(dec.announce)) trackers = dec.announce;
        } catch { /* ignore */ }
    }
    if (!infoHash) return null;
    return {
        title: r.title,
        infoHash,
        sources: trackers,
        seeders: r.seed_count || 0,
        size: parseSize(r.size),
        provider,
        languages: r.audio || []
    };
}

/**
 * Try a single endpoint of torrent-indexer (unified /search or per-indexer
 * /indexers/{name}) and return the PT-BR results.
 */
async function fetchOne(url: string, providerLabel: string): Promise<NormalizedStream[]> {
    try {
        const res = await axios.get(url, { timeout: TIMEOUT_MS, headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (typeof res.data === 'object' && res.data?.error) {
            console.warn(`[torrent-indexer:${providerLabel}] upstream error: ${res.data.error}`);
            return [];
        }
        const results: IndexerResult[] = Array.isArray(res.data?.results) ? res.data.results : [];
        return results
            .filter(hasPtBrAudio)
            .map((r) => toNormalized(r, providerLabel))
            .filter((s): s is NormalizedStream => s !== null);
    } catch (err: any) {
        console.error(`[torrent-indexer:${providerLabel}] ${err.message || err}`);
        return [];
    }
}

/**
 * Fetch streams from torrent-indexer for a given IMDb id.
 *
 * Order of attempts:
 *   1. Look up PT-BR title (via TMDB when available) + original title.
 *      BR torrents are usually named in PT-BR, so the PT-BR query hits.
 *      Some releases ship under the original title, so try both.
 *   2. Unified /search?q=<title>&audio=por for each title
 *   3. Per-sub-indexer fan-out as last resort
 */
export async function fetchFromTorrentIndexer(
    imdbId: string,
    type: 'movie' | 'series' = 'movie'
): Promise<NormalizedStream[]> {
    const titles = await resolveTitles(imdbId, type);
    if (titles.length === 0) {
        console.warn(`[torrent-indexer] no title resolved for ${imdbId}`);
        return [];
    }

    const audioFilter = '&audio=por,brazilian';

    // 1. Unified search — try each candidate title until one returns results
    for (const title of titles) {
        const q = encodeURIComponent(title);
        const found = await fetchOne(
            `${BASE}/search?q=${q}&filter_results=true&sortBy=seed_count${audioFilter}`,
            'torrent-indexer'
        );
        if (found.length > 0) {
            console.log(`[torrent-indexer] "${title}" via /search: ${found.length} PT-BR streams`);
            return found;
        }
    }

    // 2. Per-sub-indexer fan-out, with the first title only (to bound cost)
    const fallbackTitle = titles[0];
    const q = encodeURIComponent(fallbackTitle);
    console.log(`[torrent-indexer] /search empty for ${imdbId}, fanning out to sub-indexers with "${fallbackTitle}"`);
    const settled = await Promise.allSettled(
        SUB_INDEXERS.map((name) =>
            fetchOne(`${BASE}/indexers/${name}?q=${q}&filter_results=true&sortBy=seed_count${audioFilter}`, `ti:${name}`)
        )
    );
    const all: NormalizedStream[] = [];
    for (const r of settled) {
        if (r.status === 'fulfilled') all.push(...r.value);
    }
    console.log(`[torrent-indexer] "${fallbackTitle}" via sub-indexers: ${all.length} PT-BR streams`);
    return all;
}

/**
 * Resolve candidate titles for an IMDb id, in priority order.
 * TMDB (when configured) returns both PT-BR and original; otherwise we fall
 * back to Cinemeta's English name. We dedupe and skip empties.
 */
async function resolveTitles(imdbId: string, type: 'movie' | 'series'): Promise<string[]> {
    const candidates: (string | undefined)[] = [];
    if (tmdbAvailable()) {
        const t = await lookupTitles(imdbId, type);
        candidates.push(t.ptBr, t.original);
    }
    if (candidates.length === 0 || candidates.every((c) => !c)) {
        const cm = await fetchCinemeta(type, imdbId);
        candidates.push(cm?.name);
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of candidates) {
        if (!c) continue;
        const key = c.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c.trim());
    }
    return out;
}
