import { IStream } from '../../models/stream';
import { resolveRealDebrid } from './real-debrid';
import { resolveTorBox } from './torbox';
import { formatStream } from '../stream-formatter';

export type DebridProvider = 'realdebrid' | 'torbox';

export interface DebridConfig {
    provider: DebridProvider;
    apikey: string;
}

/**
 * Resolve a list of torrent streams into playable HTTP URLs via the configured
 * Debrid provider.
 *
 * Only cached torrents survive — the debrid clients return null for non-cached
 * content so we don't trigger background downloads that would time out the
 * Stremio request.
 *
 * Returned streams use the pretty Mico formatter so users see a Torrentio/Comet-
 * style layout (`[RD ⚡] Mico\n1080p` on the left, structured tech info on the
 * right). `bingeGroup` keeps Stremio's auto-play picking the same release across
 * episodes.
 */
export async function resolveDebridStreams(streams: Partial<IStream>[], config: DebridConfig): Promise<any[]> {
    const resolved = await Promise.all(
        streams.map(async (s) => {
            const result = await resolveOne(s, config);
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
                    bingeGroup: `mico-${config.provider}-${(s.infoHash || '').slice(0, 8)}`
                }
            };
        })
    );
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
