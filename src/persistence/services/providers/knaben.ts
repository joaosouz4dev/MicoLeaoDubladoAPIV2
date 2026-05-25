/**
 * Knaben meta-indexer provider.
 *
 * api.knaben.org aggregates 50+ trackers (ThePirateBay, Nyaa, 1337x, ...) and
 * surfaces results with a uniform JSON shape. Crucially:
 *   - Returns `magnetUrl` and `hash` ready to consume — no scraping
 *   - Works from cloud IPs (Vercel) despite being behind Cloudflare
 *   - Covers niches our other BR providers miss (anime dublado from Nyaa,
 *     dorama, niche releases that didn't make it to comando_torrents/bludv)
 *
 * Reference: https://knaben.org/api/v1/
 */
import axios from 'axios';
import { decode } from 'magnet-uri';
import type { NormalizedStream } from './types';
import { withBreaker } from './circuit-breaker';
import { lookupTitles, tmdbAvailable } from '../tmdb';
import { fetchCinemeta } from '../cinemeta';
import { buildQueryVariants } from './query-builder';

const BASE = process.env.KNABEN_BASE || 'https://api.knaben.org/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Stremio/4.4 MicoLeaoV2';
const TIMEOUT_MS = 7000;
const MAX_HITS = 100;

interface KnabenHit {
    title?: string;
    hash?: string;
    magnetUrl?: string;
    bytes?: number;
    seeders?: number;
    peers?: number;
    category?: string;
    categoryId?: number[];
    tracker?: string;
    cachedOrigin?: string;
}

const PT_BR_MARKERS = [
    /\bdubl(ado|agem)\b/i,
    /\bdual[-\s]?(audio|áudio)\b/i,
    /🇧🇷/,
    /\bpt-?br\b/i,
    /\bportugu(ê|e)s\b/i,
    /\bbrazilian\b/i,
    /\bnacional\b/i
];

function isPtBr(title: string): boolean {
    return PT_BR_MARKERS.some((re) => re.test(title));
}

function toNormalized(hit: KnabenHit): NormalizedStream | null {
    let infoHash = hit.hash?.toLowerCase();
    let trackers: string[] = [];
    if (!infoHash && hit.magnetUrl) {
        try {
            const dec = decode(hit.magnetUrl);
            if (dec.infoHash) infoHash = dec.infoHash.toLowerCase();
            if (Array.isArray(dec.announce)) trackers = dec.announce;
        } catch { /* ignore */ }
    } else if (hit.magnetUrl) {
        try {
            const dec = decode(hit.magnetUrl);
            if (Array.isArray(dec.announce)) trackers = dec.announce;
        } catch { /* ignore */ }
    }
    if (!infoHash || !hit.title) return null;
    return {
        title: hit.title,
        infoHash,
        sources: trackers,
        seeders: hit.seeders || 0,
        size: hit.bytes,
        provider: 'knaben',
        languages: []
    };
}

/**
 * Knaben search. Body: { query, size, order_by, order_direction, categories[] }.
 * We don't constrain categories to allow both movies (3001000) and anime (5070000)
 * to come back from the same query — the title-level PT-BR filter handles the rest.
 */
async function searchKnaben(query: string): Promise<NormalizedStream[]> {
    try {
        const res = await axios.post(
            BASE,
            {
                query,
                size: MAX_HITS,
                order_by: 'seeders',
                order_direction: 'desc',
                hide_unsafe: true,
                hide_xxx: true
            },
            { timeout: TIMEOUT_MS, headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' } }
        );
        const hits: KnabenHit[] = Array.isArray(res.data?.hits) ? res.data.hits : [];
        const filtered = hits
            .filter((h) => h.title && isPtBr(h.title))
            .map(toNormalized)
            .filter((s): s is NormalizedStream => s !== null);
        console.log(`[knaben] "${query}" → ${filtered.length} PT-BR of ${hits.length}`);
        return filtered;
    } catch (err: any) {
        const status = err.response?.status;
        console.error(`[knaben] search failed status=${status}: ${err.message || err}`);
        return [];
    }
}

export async function fetchFromKnaben(
    imdbId: string,
    type: 'movie' | 'series' = 'movie',
    streamId?: string
): Promise<NormalizedStream[]> {
    return withBreaker('knaben', async () => {
        // Resolve a usable title (TMDB pt-BR > Cinemeta)
        let ptBr: string | undefined;
        let original: string | undefined;
        if (tmdbAvailable()) {
            const t = await lookupTitles(imdbId, type);
            ptBr = t.ptBr;
            original = t.original;
        }
        if (!ptBr && !original) {
            const cm = await fetchCinemeta(type, imdbId);
            ptBr = cm?.name;
        }
        if (!ptBr && !original) return [];

        let season: number | undefined;
        let episode: number | undefined;
        if (streamId && type === 'series') {
            const parts = streamId.split(':');
            if (parts[1]) season = parseInt(parts[1], 10) || undefined;
            if (parts[2]) episode = parseInt(parts[2], 10) || undefined;
        }

        const variants = buildQueryVariants({ ptBr, original, season, episode });
        // Knaben's full-text search is broader than the BR indexers — most of
        // the time the first 1-2 variants are enough. Limit fan-out to keep
        // the request latency tight.
        const tries = variants.slice(0, 3);
        const allResults: NormalizedStream[] = [];
        const seen = new Set<string>();
        for (const v of tries) {
            const hits = await searchKnaben(v);
            for (const h of hits) {
                if (seen.has(h.infoHash)) continue;
                seen.add(h.infoHash);
                allResults.push(h);
            }
            if (allResults.length >= 15) break;
        }
        return allResults;
    });
}
