import { IStream } from '../../models/stream';
import DebridCache from '../../models/debrid-cache';
import { resolveRealDebrid } from './real-debrid';
import { resolveTorBox } from './torbox';
import { stremthruCheckMagnets, stremthruResolve, StremThruStoreName } from './stremthru';
import { formatStream } from '../stream-formatter';

export type DebridProvider = 'realdebrid' | 'torbox';

export interface DebridConfig {
    provider: DebridProvider;
    apikey: string;
}

/**
 * Debrid backend selection.
 *
 * Default is `direct` — calls Real-Debrid and TorBox APIs directly. Our
 * client code already handles "uncached → delete the queued torrent" so
 * the user's account stays clean.
 *
 * `stremthru` is opt-in only: the public hosted instance at elfhosted.com
 * is gated behind STREMTHRU_AUTH credentials which we don't have, and
 * silently returns 403 for all requests. Set DEBRID_BACKEND=stremthru
 * with STREMTHRU_AUTH=<your-basic-auth> only if you have a paid/self-hosted
 * StremThru instance.
 */
const DEBRID_BACKEND = (process.env.DEBRID_BACKEND || 'direct').toLowerCase();
const USE_STREMTHRU = DEBRID_BACKEND === 'stremthru';

const MAX_DEBRID_ATTEMPTS = parseInt(process.env.MAX_DEBRID_ATTEMPTS || '8', 10);
const DEBRID_CACHE_TTL_MS = parseInt(process.env.DEBRID_CACHE_TTL_MS || `${15 * 60 * 1000}`, 10);

/**
 * Resolve a list of torrent streams into playable HTTP URLs via the configured
 * Debrid provider.
 *
 * StremThru flow:
 *   1. Batch-check the candidate hashes in one call
 *   2. For hashes reported as cached, request a streaming link
 *   3. Persist cached/uncached outcomes to DebridCache (TTL 15min) so
 *      future requests can short-circuit known-not-cached hashes
 *
 * Returned streams use the pretty Mico formatter so users see a Torrentio/
 * Comet-style layout with the ⚡ Cache marker.
 */
export async function resolveDebridStreams(streams: Partial<IStream>[], config: DebridConfig): Promise<any[]> {
    const candidates = streams.filter((s) => !!s.infoHash).slice(0, MAX_DEBRID_ATTEMPTS);
    if (candidates.length === 0) return [];

    // 1. Consult our short-lived cache first — pull both "cached" and
    //    "uncached" verdicts. Anything cached we still re-resolve (URLs
    //    expire); anything uncached we skip the network entirely.
    const cacheKeys = candidates.map((s) => `${config.provider}:${s.infoHash!}`);
    const cacheHits = new Map<string, boolean>();
    try {
        const found = await DebridCache.find({ key: { $in: cacheKeys } }).exec();
        for (const r of found) {
            if (r.expiresAt.getTime() > Date.now()) cacheHits.set(r.key, r.cached);
        }
    } catch (err) {
        console.error(`[debrid] cache lookup failed: ${err}`);
    }

    // 2. Filter out known-uncached hashes; whatever's left we'll probe upstream
    const toProbe = candidates.filter((s) => cacheHits.get(`${config.provider}:${s.infoHash!}`) !== false);

    // 3. Probe — StremThru batches in one call; direct path one-by-one.
    let probedCached: Map<string, boolean> = new Map();
    if (USE_STREMTHRU && toProbe.length > 0) {
        const storeName = config.provider as StremThruStoreName;
        probedCached = await stremthruCheckMagnets(storeName, config.apikey, toProbe.map((s) => s.infoHash!.toLowerCase()));
    }

    // 4. Resolve cached hashes and emit Stremio streams
    const resolved = await Promise.all(candidates.map(async (s) => {
        const infoHash = s.infoHash!.toLowerCase();
        const cacheKey = `${config.provider}:${infoHash}`;
        const cachedFromDb = cacheHits.get(cacheKey);
        if (cachedFromDb === false) return null; // known not-cached

        let cached: boolean;
        if (USE_STREMTHRU) {
            cached = probedCached.get(infoHash) === true || cachedFromDb === true;
        } else {
            cached = cachedFromDb === true;
        }

        let result: { url: string; filename?: string; filesize?: number } | null = null;
        if (cached) {
            result = await resolveOne(s, config);
        }

        // Persist outcome (cached or not). When we got a successful resolve
        // we mark cached=true so future hits short-circuit to "resolve".
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
    if (USE_STREMTHRU) {
        return stremthruResolve(config.provider as StremThruStoreName, config.apikey, infoHash.toLowerCase());
    }
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
