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
import { buildQueryVariants, QueryContext } from './query-builder';
import { withBreaker } from './circuit-breaker';

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
 * Fetch streams from torrent-indexer for a given Stremio id (movie or episode).
 *
 * Strategy:
 *   1. Resolve query context (PT-BR + original titles, year, season/episode)
 *      from TMDB / Cinemeta
 *   2. Generate up to ~12 query variants via buildQueryVariants
 *   3. Try /search?q=<variant> in order until one returns results
 *   4. If still empty, fan out to each sub-indexer with the first variant
 *   5. The whole call is wrapped in a circuit breaker so failures don't
 *      block subsequent requests
 */
export async function fetchFromTorrentIndexer(
    imdbId: string,
    type: 'movie' | 'series' = 'movie',
    streamId?: string
): Promise<NormalizedStream[]> {
    return withBreaker('torrent-indexer', () => fetchInner(imdbId, type, streamId));
}

async function fetchInner(
    imdbId: string,
    type: 'movie' | 'series',
    streamId?: string
): Promise<NormalizedStream[]> {
    const ctx = await resolveQueryContext(imdbId, type, streamId);
    if (!ctx.ptBr && !ctx.original) {
        console.warn(`[torrent-indexer] no title resolved for ${imdbId}`);
        return [];
    }
    const variants = buildQueryVariants(ctx);
    if (variants.length === 0) return [];
    console.log(`[torrent-indexer] ${imdbId}: ${variants.length} query variants`);

    const audioFilter = '&audio=por,brazilian';

    // 1. Unified search — try each variant until one hits
    for (const v of variants) {
        const q = encodeURIComponent(v);
        const found = await fetchOne(
            `${BASE}/search?q=${q}&filter_results=true&sortBy=seed_count${audioFilter}`,
            'torrent-indexer'
        );
        if (found.length > 0) {
            console.log(`[torrent-indexer] "${v}" via /search: ${found.length} PT-BR streams`);
            return found;
        }
    }

    // 2. Per-sub-indexer fan-out with the first (most specific) variant
    const fallback = variants[0];
    const q = encodeURIComponent(fallback);
    console.log(`[torrent-indexer] /search empty for ${imdbId}, fanning out with "${fallback}"`);
    const settled = await Promise.allSettled(
        SUB_INDEXERS.map((name) =>
            fetchOne(`${BASE}/indexers/${name}?q=${q}&filter_results=true&sortBy=seed_count${audioFilter}`, `ti:${name}`)
        )
    );
    const all: NormalizedStream[] = [];
    for (const r of settled) {
        if (r.status === 'fulfilled') all.push(...r.value);
    }
    console.log(`[torrent-indexer] "${fallback}" via sub-indexers: ${all.length} PT-BR streams`);
    return all;
}

/**
 * Resolve all the fields the query builder needs: PT-BR title (via TMDB when
 * available), original title, year, and — for series — season/episode parsed
 * from the Stremio id (format "ttXXXX:S:E").
 */
async function resolveQueryContext(
    imdbId: string,
    type: 'movie' | 'series',
    streamId?: string
): Promise<QueryContext> {
    const ctx: QueryContext = {};
    if (streamId && type === 'series') {
        const parts = streamId.split(':');
        if (parts[1]) ctx.season = parseInt(parts[1], 10) || undefined;
        if (parts[2]) ctx.episode = parseInt(parts[2], 10) || undefined;
    }
    if (tmdbAvailable()) {
        const t = await lookupTitles(imdbId, type);
        ctx.ptBr = t.ptBr;
        ctx.original = t.original;
    }
    if (!ctx.ptBr && !ctx.original) {
        const cm = await fetchCinemeta(type, imdbId);
        ctx.ptBr = cm?.name;
        if (cm?.releaseInfo) ctx.year = cm.releaseInfo.slice(0, 4);
    }
    return ctx;
}
