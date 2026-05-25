/**
 * Brazilian torrent indexer provider.
 *
 * Calls https://torrent-indexer.darklyn.org — a community indexer that aggregates
 * BR sources (comando-torrents, bludv, starck-filmes, etc.) and exposes JSON.
 *
 * Each result has an explicit `audio` array (e.g. ["Português", "Inglês"]) which
 * we trust as authoritative — no fragile title regex needed for the language check.
 *
 * Reference: github.com/felipemarinho97/torrent-indexer
 */
import axios from 'axios';
import { decode } from 'magnet-uri';
import type { NormalizedStream } from './types';
import { fetchCinemeta } from '../cinemeta';

const BASE = process.env.TORRENT_INDEXER_BASE || 'https://torrent-indexer.darklyn.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Stremio/4.4 MicoLeaoV2';

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
    // Fallback to title sniff (some sources don't fill audio array)
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

function toNormalized(r: IndexerResult): NormalizedStream | null {
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
        provider: 'torrent-indexer',
        languages: r.audio || []
    };
}

/**
 * Fetch streams from torrent-indexer for a given IMDb id.
 *
 * The /search endpoint accepts ?q=<title> (it ignores imdb=), so we first
 * resolve the title via Cinemeta and use it as the query. Then we filter
 * results by PT-BR audio markers.
 */
export async function fetchFromTorrentIndexer(
    imdbId: string,
    type: 'movie' | 'series' = 'movie'
): Promise<NormalizedStream[]> {
    const meta = await fetchCinemeta(type, imdbId);
    if (!meta?.name) {
        console.warn(`[torrent-indexer] no title from Cinemeta for ${imdbId}`);
        return [];
    }
    const title = meta.name;
    const url = `${BASE}/search?q=${encodeURIComponent(title)}&filter_results=true&sortBy=seed_count&audio=por,brazilian`;
    try {
        const res = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': UA, Accept: 'application/json' } });
        const results: IndexerResult[] = Array.isArray(res.data?.results) ? res.data.results : [];
        console.log(`[torrent-indexer] q="${title}" → ${results.length} raw`);
        return results
            .filter(hasPtBrAudio)
            .map(toNormalized)
            .filter((s): s is NormalizedStream => s !== null);
    } catch (err: any) {
        console.error(`[torrent-indexer] failed: ${err.message || err}`);
        return [];
    }
}
