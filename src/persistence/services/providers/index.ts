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

export async function aggregateProviders(
    type: 'movie' | 'series',
    stremioId: string
): Promise<NormalizedStream[]> {
    // 1. Short-lived cache check
    try {
        const cached = await SearchCache.findOne({ streamId: stremioId }).exec();
        if (cached && cached.expiresAt.getTime() > Date.now() && Array.isArray(cached.payload)) {
            console.log(`[providers] cache hit ${stremioId}: ${cached.payload.length} streams`);
            return cached.payload;
        }
    } catch (err) {
        console.error(`[providers] cache lookup failed: ${err}`);
    }

    // 2. Fan out to providers
    const imdbId = stremioId.split(':')[0];
    const settled = await Promise.allSettled([
        fetchFromTorrentIndexer(imdbId, type),
        fetchFromTorrentio(type, stremioId),
        fetchFromThePirataFilmes(imdbId)
    ]);
    const all: NormalizedStream[] = [];
    for (const s of settled) {
        if (s.status === 'fulfilled') all.push(...s.value);
    }

    // Dedupe by infoHash, prefer entry with higher seeders
    const byHash = new Map<string, NormalizedStream>();
    for (const s of all) {
        const existing = byHash.get(s.infoHash);
        if (!existing || s.seeders > existing.seeders) byHash.set(s.infoHash, s);
    }
    const merged = Array.from(byHash.values()).sort((a, b) => b.seeders - a.seeders);
    console.log(`[providers] ${stremioId}: ${merged.length} unique streams (${all.length} raw)`);

    // 3. Memoize (best-effort)
    SearchCache.updateOne(
        { streamId: stremioId },
        { $set: { streamId: stremioId, payload: merged, expiresAt: new Date(Date.now() + SEARCH_CACHE_TTL_MS) } },
        { upsert: true }
    ).exec().catch((err) => console.error(`[providers] cache write failed: ${err}`));

    return merged;
}
