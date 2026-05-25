/**
 * ThePirataFilmes provider (BR indexer).
 *
 * Public API: https://www.thepiratafilmes.online/api/search?imdbid=tt...
 * Returns JSON with { title, magnet_link, info_hash, seed_count, size, category, ... }.
 *
 * Reference: github.com/black070131/index-web
 */
import axios from 'axios';
import { decode } from 'magnet-uri';
import type { NormalizedStream } from './types';
import { withBreaker } from './circuit-breaker';

const BASES = (process.env.PIRATAFILMES_BASE || [
    'https://www.thepiratafilmes.online',
    'https://catalago.online'
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Stremio/4.4 MicoLeaoV2';

interface PirataResult {
    title?: string;
    original_title?: string;
    info_hash?: string;
    magnet_link?: string;
    trackers?: string[];
    size?: string;
    seed_count?: number;
    audio?: string[];
    imdb?: string;
    category?: string;
}

function parseSize(s: string | undefined): number | undefined {
    if (!s) return undefined;
    const m = /([\d.]+)\s*(GB|MB|KB)/i.exec(s);
    if (!m) return undefined;
    const n = parseFloat(m[1]);
    const u = m[2].toUpperCase();
    if (u === 'GB') return Math.round(n * 1024 * 1024 * 1024);
    if (u === 'MB') return Math.round(n * 1024 * 1024);
    return Math.round(n * 1024);
}

function toNormalized(r: PirataResult): NormalizedStream | null {
    let infoHash = r.info_hash?.toLowerCase();
    let trackers = r.trackers || [];
    if (!infoHash && r.magnet_link) {
        try {
            const dec = decode(r.magnet_link);
            if (dec.infoHash) infoHash = dec.infoHash.toLowerCase();
            if (Array.isArray(dec.announce)) trackers = dec.announce;
        } catch { /* ignore */ }
    }
    if (!infoHash || !r.title) return null;
    return {
        title: r.title,
        infoHash,
        sources: trackers,
        seeders: r.seed_count || 0,
        size: parseSize(r.size),
        provider: 'thepiratafilmes',
        languages: r.audio || []
    };
}

/**
 * Fetch from ThePirataFilmes API. Tries multiple mirrors. Wrapped in a
 * circuit breaker so repeated failures (mirror outages) don't keep paying
 * timeout on every request.
 */
export async function fetchFromThePirataFilmes(imdbId: string): Promise<NormalizedStream[]> {
    return withBreaker('thepiratafilmes', async () => {
        for (const base of BASES) {
            const url = `${base}/api/search?imdbid=${encodeURIComponent(imdbId)}`;
            try {
                const res = await axios.get(url, {
                    timeout: 7000,
                    headers: { 'User-Agent': UA, Accept: 'application/json' }
                });
                const results: PirataResult[] = Array.isArray(res.data?.results) ? res.data.results : [];
                const normalized = results
                    .map(toNormalized)
                    .filter((s): s is NormalizedStream => s !== null);
                if (normalized.length > 0) {
                    console.log(`[thepiratafilmes] ${base}: ${normalized.length} streams for ${imdbId}`);
                    return normalized;
                }
            } catch (err: any) {
                console.error(`[thepiratafilmes] ${base} failed status=${err.response?.status}: ${err.message || err}`);
            }
        }
        return [];
    });
}
