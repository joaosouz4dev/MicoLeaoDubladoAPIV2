import { IStream } from '../../models/stream';
import { resolveRealDebrid } from './real-debrid';
import { resolveTorBox } from './torbox';

export type DebridProvider = 'realdebrid' | 'torbox';

export interface DebridConfig {
    provider: DebridProvider;
    apikey: string;
}

/**
 * Resolve a list of torrent streams into playable HTTP URLs via the configured Debrid provider.
 *
 * Each stream is processed in parallel. Streams that fail to resolve are dropped from the
 * returned list — Stremio will then show only the successful Debrid links.
 */
export async function resolveDebridStreams(streams: IStream[], config: DebridConfig): Promise<any[]> {
    const resolved = await Promise.all(
        streams.map(async (s) => {
            const result = await resolveOne(s, config);
            if (!result) return null;
            return {
                title: `${s.title}\n[${config.provider}]`,
                url: result.url,
                name: providerName(config.provider),
                behaviorHints: { notWebReady: false }
            };
        })
    );
    return resolved.filter((s): s is any => s !== null);
}

async function resolveOne(stream: IStream, config: DebridConfig) {
    const { infoHash, sources } = stream;
    if (config.provider === 'realdebrid') {
        return resolveRealDebrid(config.apikey, infoHash, sources || []);
    }
    if (config.provider === 'torbox') {
        return resolveTorBox(config.apikey, infoHash, sources || []);
    }
    return null;
}

function providerName(p: DebridProvider): string {
    if (p === 'realdebrid') return 'MLD+RD';
    if (p === 'torbox') return 'MLD+TB';
    return 'MLD';
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
