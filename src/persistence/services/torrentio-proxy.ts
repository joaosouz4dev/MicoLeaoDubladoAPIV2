/**
 * Torrentio proxy + scraper.
 *
 * Fetches streams from Torrentio's public endpoint, filters for Portuguese-dubbed
 * releases, normalizes them into our IStream shape, and (best-effort) writes them
 * to the local DB so the catalog/stream caches grow organically as users browse.
 *
 * Reference: https://torrentio.strem.fun/
 */
import axios from 'axios';
import Stream, { IStream } from '../models/stream';

/**
 * Torrentio (and similar addons) block requests from cloud-provider IP ranges
 * with HTTP 403. We try a list of compatible endpoints in order; the first one
 * that responds wins. KnightCrawler is a community fork with the same /stream
 * shape and is generally more permissive.
 */
const UPSTREAM_BASES = (process.env.TORRENTIO_BASE || [
    'https://torrentio.strem.fun',
    'https://knightcrawler.elfhosted.com',
    'https://mediafusion.elfhosted.com'
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const REQUEST_HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Stremio/4.4',
    'Accept': 'application/json',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
};
if (process.env.WORKER_SECRET) {
    REQUEST_HEADERS['x-worker-secret'] = process.env.WORKER_SECRET;
}

interface TorrentioStream {
    name?: string;
    title?: string;
    infoHash?: string;
    fileIdx?: number;
    sources?: string[];
    behaviorHints?: { bingeGroup?: string };
}

/**
 * Match strings that strongly indicate Portuguese-Brazilian audio.
 * Torrentio puts the language tag in the title (multiline) — we sniff for any
 * of the well-known markers used by release groups and Torrentio itself.
 */
const PT_BR_MARKERS = [
    /\bdubl(ado|agem)\b/i,
    /\bdublado pt-?br\b/i,
    /🇧🇷/,
    /\bmulti(audio)?\b.*\bpt-?br\b/i,
    /\bpt-?br\b/i,
    /\bportugu(e|ê)s.*brasil(eiro)?\b/i,
    /\bbrazilian\b.*\b(dub|portuguese)\b/i,
    /\blat(ino)?\b.*\bportugu(e|ê)s\b/i
];

function isPortugueseDub(stream: TorrentioStream): boolean {
    const haystack = `${stream.title || ''}\n${stream.name || ''}`;
    return PT_BR_MARKERS.some((re) => re.test(haystack));
}

/**
 * Fetch streams from Torrentio for a given Stremio id.
 * Returns the raw Torrentio payload — no filtering.
 */
async function fetchTorrentioRaw(type: 'movie' | 'series', stremioId: string): Promise<TorrentioStream[]> {
    for (const base of UPSTREAM_BASES) {
        const url = `${base}/stream/${type}/${encodeURIComponent(stremioId)}.json`;
        try {
            const res = await axios.get(url, { timeout: 8000, headers: REQUEST_HEADERS });
            const streams = Array.isArray(res.data?.streams) ? res.data.streams : [];
            console.log(`[torrentio] ${base} → ${streams.length} streams for ${stremioId}`);
            if (streams.length > 0) return streams;
        } catch (err: any) {
            const status = err.response?.status;
            console.error(`[torrentio] ${base} failed status=${status}: ${err.message || err}`);
        }
    }
    return [];
}

/**
 * Convert a Torrentio stream into our IStream shape.
 * The id is the Stremio convention: "ttXXXXX" for movies, "ttXXXXX:S:E" for episodes.
 */
function toIStream(t: TorrentioStream, type: 'movie' | 'series', stremioId: string): Partial<IStream> | null {
    if (!t.infoHash) return null;
    const seedersMatch = /👤\s*(\d+)/.exec(t.title || '');
    const sizeMatch = /💾\s*([\d.]+)\s*(GB|MB)/i.exec(t.title || '');
    let size: number | undefined;
    if (sizeMatch) {
        const n = parseFloat(sizeMatch[1]);
        size = sizeMatch[2].toUpperCase() === 'GB' ? n * 1024 * 1024 * 1024 : n * 1024 * 1024;
    }

    let metaId = stremioId;
    let season: number | undefined;
    let episode: number | undefined;
    if (type === 'series') {
        const parts = stremioId.split(':');
        metaId = parts[0];
        season = parts[1] ? parseInt(parts[1], 10) : undefined;
        episode = parts[2] ? parseInt(parts[2], 10) : undefined;
    }

    return {
        metaId,
        streamId: stremioId,
        type,
        title: cleanTitle(t.title || t.name || ''),
        infoHash: t.infoHash.toLowerCase(),
        sources: t.sources || [],
        seeders: seedersMatch ? parseInt(seedersMatch[1], 10) : 0,
        fileIdx: t.fileIdx,
        size,
        season,
        episode,
        updatedAt: new Date()
    } as Partial<IStream>;
}

function cleanTitle(s: string): string {
    return s.replace(/^Torrentio\s*[\n\r]+/i, '').trim();
}

/**
 * Persist a batch of streams idempotently (skip if {metaId, infoHash} already exists).
 * Failures per stream are logged and swallowed so the request can still return.
 */
async function persistStreams(streams: Partial<IStream>[]): Promise<void> {
    await Promise.all(streams.map(async (s) => {
        if (!s.metaId || !s.infoHash) return;
        try {
            const exists = await Stream.findOne({ metaId: s.metaId, infoHash: s.infoHash }).exec();
            if (exists) return;
            await new Stream(s).save();
        } catch (err) {
            console.error(`[torrentio] persist failed for ${s.infoHash}: ${err}`);
        }
    }));
}

/**
 * Fetch from Torrentio, filter for PT-BR, normalize, persist in the background, and
 * return the resulting IStream-shaped objects.
 *
 * Returned streams are NOT saved Mongoose documents — they're plain objects safe
 * to send to the client directly. The persistence happens async (fire-and-forget)
 * so the request latency isn't hurt by DB writes.
 */
export async function scrapeAndProxyTorrentio(type: 'movie' | 'series', stremioId: string): Promise<Partial<IStream>[]> {
    const raw = await fetchTorrentioRaw(type, stremioId);
    if (raw.length === 0) return [];

    const ptbr = raw.filter(isPortugueseDub);
    if (ptbr.length === 0) {
        console.log(`[torrentio] ${stremioId}: 0 PT-BR streams out of ${raw.length}`);
        return [];
    }

    const normalized = ptbr
        .map((t) => toIStream(t, type, stremioId))
        .filter((s): s is Partial<IStream> => s !== null);

    persistStreams(normalized).catch((err) => console.error(`[torrentio] background persist error: ${err}`));

    console.log(`[torrentio] ${stremioId}: ${normalized.length} PT-BR streams cached`);
    return normalized;
}
