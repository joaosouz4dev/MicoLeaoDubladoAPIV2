/**
 * Multi-provider aggregator with short-lived response cache.
 *
 * Queries every configured provider in parallel and merges results, deduping
 * by infoHash. The first provider to report a given infoHash wins (its title,
 * seeders, etc. are kept). Aggregated response is memoized in MongoDB for
 * SEARCH_CACHE_TTL_MS so bursts of identical Stremio requests don't hammer
 * upstream indexers.
 */
import { fetchFromTorrentIndexer } from './torrent-indexer';
import { fetchFromTorrentio } from './torrentio';
import { fetchFromThePirataFilmes } from './thepiratafilmes';
import SearchCache from '../../models/search-cache';
import type { NormalizedStream } from './types';

export type { NormalizedStream } from './types';

const SEARCH_CACHE_TTL_MS = parseInt(process.env.SEARCH_CACHE_TTL_MS || `${30 * 60 * 1000}`, 10);

/**
 * Two-phase cache: a hit younger than STALE_AFTER_MS is returned immediately
 * without revalidation. A hit older than that (but still within TTL) is
 * returned AND a background revalidation is kicked off. This is essentially
 * stale-while-revalidate.
 *
 * Default: revalidate when the cache entry is ≥50% through its TTL.
 */
const STALE_AFTER_MS = parseInt(process.env.SEARCH_CACHE_STALE_MS || `${SEARCH_CACHE_TTL_MS / 2}`, 10);

/**
 * Torrentio blocks cloud IPs (Vercel, Cloudflare, AWS, ...) at the network
 * level. Skip it unless TORRENTIO_BASE explicitly points to a custom proxy
 * the operator has confirmed works.
 */
const TORRENTIO_ENABLED = !!process.env.TORRENTIO_BASE
    && !process.env.TORRENTIO_BASE.includes('torrentio.strem.fun');

const inflight = new Map<string, Promise<NormalizedStream[]>>();

export async function aggregateProviders(
    type: 'movie' | 'series',
    stremioId: string
): Promise<NormalizedStream[]> {
    // 1. Short-lived cache lookup
    let cached: any = null;
    try {
        cached = await SearchCache.findOne({ streamId: stremioId }).exec();
    } catch (err) {
        console.error(`[providers] cache lookup failed: ${err}`);
    }

    if (cached && Array.isArray(cached.payload)) {
        const expiresIn = cached.expiresAt.getTime() - Date.now();
        if (expiresIn > 0) {
            const ageMs = SEARCH_CACHE_TTL_MS - expiresIn;
            const isStale = ageMs > STALE_AFTER_MS;
            if (isStale) {
                // Stale-but-valid: return cached AND revalidate in background
                console.log(`[providers] cache STALE hit ${stremioId} (age ${Math.floor(ageMs / 1000)}s) — revalidating async`);
                triggerRevalidation(type, stremioId);
            } else {
                console.log(`[providers] cache hit ${stremioId} (age ${Math.floor(ageMs / 1000)}s)`);
            }
            return cached.payload;
        }
    }

    // 2. Cache miss — block on the providers
    return fetchAndCache(type, stremioId);
}

/**
 * Fan out to all enabled providers, dedupe, write back to the cache.
 * Coalesces concurrent calls for the same streamId via the in-process
 * `inflight` map so a burst of requests only does one upstream call.
 */
async function fetchAndCache(type: 'movie' | 'series', stremioId: string): Promise<NormalizedStream[]> {
    const existing = inflight.get(stremioId);
    if (existing) return existing;

    const work = (async () => {
        const imdbId = stremioId.split(':')[0];
        const promises: Promise<NormalizedStream[]>[] = [
            fetchFromTorrentIndexer(imdbId, type, stremioId),
            fetchFromThePirataFilmes(imdbId)
        ];
        if (TORRENTIO_ENABLED) promises.push(fetchFromTorrentio(type, stremioId));
        const settled = await Promise.allSettled(promises);
        const all: NormalizedStream[] = [];
        for (const s of settled) {
            if (s.status === 'fulfilled') all.push(...s.value);
        }

        const byHash = new Map<string, NormalizedStream>();
        for (const s of all) {
            const existing = byHash.get(s.infoHash);
            if (!existing || s.seeders > existing.seeders) byHash.set(s.infoHash, s);
        }
        const merged = Array.from(byHash.values()).sort((a, b) => b.seeders - a.seeders);
        console.log(`[providers] ${stremioId}: ${merged.length} unique streams (${all.length} raw)`);

        SearchCache.updateOne(
            { streamId: stremioId },
            { $set: { streamId: stremioId, payload: merged, expiresAt: new Date(Date.now() + SEARCH_CACHE_TTL_MS) } },
            { upsert: true }
        ).exec().catch((err) => console.error(`[providers] cache write failed: ${err}`));

        return merged;
    })();

    inflight.set(stremioId, work);
    try {
        return await work;
    } finally {
        inflight.delete(stremioId);
    }
}

/**
 * Fire-and-forget cache revalidation. Errors are logged but never thrown.
 */
function triggerRevalidation(type: 'movie' | 'series', stremioId: string) {
    fetchAndCache(type, stremioId).catch((err) =>
        console.error(`[providers] revalidation failed for ${stremioId}: ${err}`)
    );
}
