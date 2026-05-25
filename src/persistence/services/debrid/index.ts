import { IStream } from '../../models/stream';
import DebridCache from '../../models/debrid-cache';
import { resolveRealDebrid } from './real-debrid';
import { resolveTorBox } from './torbox';
import { formatStream } from '../stream-formatter';

export type DebridProvider = 'realdebrid' | 'torbox';

export interface DebridConfig {
    provider: DebridProvider;
    apikey: string;
}

/**
 * Hard cap on Debrid attempts per request.
 *
 * Each attempt does addMagnet + selectFiles + polls + possibly delete on
 * Real-Debrid. With 20 candidate streams we'd burn ~100 API calls and
 * hit Vercel's 60s function timeout. Cap to the top N (already sorted by
 * quality+seeders upstream).
 */
const MAX_DEBRID_ATTEMPTS = parseInt(process.env.MAX_DEBRID_ATTEMPTS || '5', 10);

/**
 * Cache TTL for "is this hash cached on Debrid?" lookups.
 * Short because RD's cache state changes over time, but long enough to
 * absorb burst requests for the same content (Stremio refetches a lot).
 */
const DEBRID_CACHE_TTL_MS = parseInt(process.env.DEBRID_CACHE_TTL_MS || `${15 * 60 * 1000}`, 10);

/**
 * Resolve a list of torrent streams into playable HTTP URLs via the configured
 * Debrid provider.
 *
 * Optimizations:
 *   - Skip streams without infoHash up front (cheap filter)
 *   - Cap to MAX_DEBRID_ATTEMPTS (top-quality streams already first)
 *   - Consult DebridCache for "we already know this hash isn't cached"
 *     so repeat requests don't re-test
 *   - Run attempts in parallel
 *   - Persist outcome (cached vs not) regardless of success
 *
 * Returned streams use the pretty Mico formatter so users see a Torrentio/
 * Comet-style layout with the ⚡ Cache marker for confirmed cached releases.
 */
export async function resolveDebridStreams(streams: Partial<IStream>[], config: DebridConfig): Promise<any[]> {
    const candidates = streams.filter((s) => !!s.infoHash).slice(0, MAX_DEBRID_ATTEMPTS);

    const resolved = await Promise.all(candidates.map(async (s) => {
        const infoHash = s.infoHash!;
        const cacheKey = `${config.provider}:${infoHash}`;

        // 1. Cache lookup — known not-cached → skip without hitting Debrid
        try {
            const cached = await DebridCache.findOne({ key: cacheKey }).exec();
            if (cached && cached.expiresAt.getTime() > Date.now() && cached.cached === false) {
                return null;
            }
        } catch (err) {
            console.error(`[debrid] cache lookup failed: ${err}`);
        }

        // 2. Try resolve
        const result = await resolveOne(s, config);

        // 3. Persist outcome
        DebridCache.updateOne(
            { key: cacheKey },
            {
                $set: {
                    key: cacheKey,
                    cached: !!result,
                    filename: result?.filename,
                    filesize: result?.filesize,
                    expiresAt: new Date(Date.now() + DEBRID_CACHE_TTL_MS)
                }
            },
            { upsert: true }
        ).exec().catch((err) => console.error(`[debrid] cache write failed: ${err}`));

        if (!result) return null;

        const { name, title } = formatStream({
            rawTitle: s.title || '',
            seeders: s.seeders || 0,
            sizeBytes: (s as any).size,
            provider: (s as any).provider || 'cache',
            debrid: { provider: config.provider, cached: true }
        });
        return {
            name,
            title,
            url: result.url,
            behaviorHints: {
                notWebReady: false,
                bingeGroup: `mico-${config.provider}-${infoHash.slice(0, 8)}`
            }
        };
    }));

    return resolved.filter((s): s is any => s !== null);
}

async function resolveOne(stream: Partial<IStream>, config: DebridConfig) {
    const { infoHash, sources } = stream;
    if (!infoHash) return null;
    if (config.provider === 'realdebrid') {
        return resolveRealDebrid(config.apikey, infoHash, sources || []);
    }
    if (config.provider === 'torbox') {
        return resolveTorBox(config.apikey, infoHash, sources || []);
    }
    return null;
}

/**
 * Parse a "config segment" of the form `<provider>-<apikey>` from a Stremio URL prefix.
 * Returns null if the segment is missing or malformed.
 */
export function parseDebridConfig(segment?: string): DebridConfig | null {
    if (!segment) return null;
    const idx = segment.indexOf('-');
    if (idx <= 0) return null;
    const provider = segment.slice(0, idx).toLowerCase();
    const apikey = segment.slice(idx + 1);
    if (!apikey) return null;
    if (provider !== 'realdebrid' && provider !== 'torbox') return null;
    return { provider, apikey };
}
