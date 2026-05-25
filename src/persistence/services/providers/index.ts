/**
 * Multi-provider aggregator.
 *
 * Queries every configured provider in parallel and merges results, deduping
 * by infoHash. The first provider to report a given infoHash wins (its title,
 * seeders, etc. are kept).
 */
import { fetchFromTorrentIndexer } from './torrent-indexer';
import { fetchFromTorrentio } from './torrentio';
import type { NormalizedStream } from './types';

export type { NormalizedStream } from './types';

export async function aggregateProviders(
    type: 'movie' | 'series',
    stremioId: string
): Promise<NormalizedStream[]> {
    const imdbId = stremioId.split(':')[0];
    const settled = await Promise.allSettled([
        fetchFromTorrentIndexer(imdbId, type),
        fetchFromTorrentio(type, stremioId)
    ]);

    const all: NormalizedStream[] = [];
    for (const s of settled) {
        if (s.status === 'fulfilled') all.push(...s.value);
    }

    // Dedupe by infoHash, prefer the one with higher seeders
    const byHash = new Map<string, NormalizedStream>();
    for (const s of all) {
        const existing = byHash.get(s.infoHash);
        if (!existing || (s.seeders > existing.seeders)) {
            byHash.set(s.infoHash, s);
        }
    }
    const merged = Array.from(byHash.values()).sort((a, b) => b.seeders - a.seeders);
    console.log(`[providers] ${stremioId}: ${merged.length} unique streams (${all.length} raw)`);
    return merged;
}
