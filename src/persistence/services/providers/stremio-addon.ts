/**
 * Generic Stremio addon consumer.
 *
 * Any addon that follows the standard /stream/<type>/<id>.json contract can
 * be plugged in as a source. Each source is just a base URL — the prefix
 * config (e.g. /<provider>-<apikey>) goes into the URL itself.
 *
 * Configured via STREMIO_ADDON_SOURCES env (comma-separated). Each entry may
 * optionally be prefixed with `name|` to give it a stable label, e.g.:
 *
 *   guindex|https://guindex-stremio.vercel.app
 *   mico-classic|https://my-mico-deploy.vercel.app
 *
 * The aggregator already dedupes by infoHash, so adding the same content
 * twice across sources just picks the entry with higher seeders.
 */
import axios from 'axios';
import { decode } from 'magnet-uri';
import type { NormalizedStream } from './types';
import { withBreaker } from './circuit-breaker';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Stremio/4.4 MicoLeaoV2';
const TIMEOUT_MS = 7000;

interface AddonSource {
    name: string;
    baseUrl: string;
}

/**
 * Default sources. Treat these as community-maintained mirrors that may go
 * offline at any time; the circuit breaker handles outages gracefully.
 *
 * Override via STREMIO_ADDON_SOURCES env (comma-separated, optional `name|`
 * prefix). Set to empty string to disable.
 */
const DEFAULT_SOURCES: AddonSource[] = [
    { name: 'guindex', baseUrl: 'https://guindex-stremio.vercel.app' }
];

function parseSources(): AddonSource[] {
    const raw = process.env.STREMIO_ADDON_SOURCES;
    if (raw === undefined) return DEFAULT_SOURCES;
    if (raw.trim() === '') return [];
    return raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
        const sep = entry.indexOf('|');
        if (sep > 0) {
            return {
                name: entry.slice(0, sep).trim(),
                baseUrl: entry.slice(sep + 1).trim().replace(/\/$/, '')
            };
        }
        const url = entry.replace(/\/$/, '');
        const host = url.replace(/^https?:\/\//, '').split('/')[0];
        return { name: host, baseUrl: url };
    });
}

interface StremioStream {
    name?: string;
    title?: string;
    description?: string;
    infoHash?: string;
    fileIdx?: number;
    url?: string;
    sources?: string[];
    behaviorHints?: any;
}

const PT_BR_MARKERS = [
    /\bdubl(ado|agem)\b/i,
    /🇧🇷/,
    /\bpt-?br\b/i,
    /\bportugu(ê|e)s\b/i,
    /\bbrazilian\b/i,
    /\bdual\s*(áudio|audio)\b/i,
    /\bnacional\b/i
];

function isPtBr(s: StremioStream): boolean {
    const blob = `${s.name || ''}\n${s.title || ''}\n${s.description || ''}`;
    return PT_BR_MARKERS.some((re) => re.test(blob));
}

function parseSeedersFromTitle(title: string): number {
    // Common patterns: "👥 123", "Seeds: 123", "S: 123"
    const m = /(?:👥|seeds?|👤)\s*[:\s]?\s*(\d+)/i.exec(title);
    return m ? parseInt(m[1], 10) : 0;
}

function parseSizeFromTitle(title: string): number | undefined {
    const m = /(?:💾|size|tamanho)?\s*[:\s]?\s*([\d.]+)\s*(GB|MB)/i.exec(title);
    if (!m) return undefined;
    const n = parseFloat(m[1]);
    return m[2].toUpperCase() === 'GB' ? n * 1024 * 1024 * 1024 : n * 1024 * 1024;
}

function toNormalized(s: StremioStream, providerName: string): NormalizedStream | null {
    let infoHash = s.infoHash?.toLowerCase();
    let sources = s.sources || [];

    // Some addons return the magnet in `url` instead of split fields
    if (!infoHash && s.url && s.url.startsWith('magnet:')) {
        try {
            const dec = decode(s.url);
            if (dec.infoHash) infoHash = dec.infoHash.toLowerCase();
            if (Array.isArray(dec.announce)) sources = dec.announce;
        } catch { /* ignore */ }
    }
    if (!infoHash) return null;

    const title = (s.title || s.name || '').replace(/^[\w\-]*GuIndex\s*[\r\n]*/i, '').trim();
    return {
        title,
        infoHash,
        sources,
        seeders: parseSeedersFromTitle(`${s.title || ''} ${s.name || ''}`),
        size: parseSizeFromTitle(s.title || ''),
        provider: providerName,
        languages: []
    };
}

/**
 * Query a single Stremio addon for streams matching the given Stremio id.
 * Returns only entries that look PT-BR (other languages already arrive in
 * results from international addons; we filter to keep the catalog focused).
 */
async function fetchOne(source: AddonSource, type: 'movie' | 'series', stremioId: string): Promise<NormalizedStream[]> {
    const url = `${source.baseUrl}/stream/${type}/${encodeURIComponent(stremioId)}.json`;
    try {
        const res = await axios.get(url, {
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': UA, Accept: 'application/json' }
        });
        const raw: StremioStream[] = Array.isArray(res.data?.streams) ? res.data.streams : [];
        const ptbr = raw.filter(isPtBr);
        const normalized = ptbr
            .map((s) => toNormalized(s, source.name))
            .filter((s): s is NormalizedStream => s !== null);
        console.log(`[stremio:${source.name}] ${stremioId}: ${normalized.length} PT-BR of ${raw.length}`);
        return normalized;
    } catch (err: any) {
        const status = err.response?.status;
        console.error(`[stremio:${source.name}] failed status=${status}: ${err.message || err}`);
        return [];
    }
}

/**
 * Fan out to every configured Stremio addon source in parallel. Each source
 * has its own circuit breaker, so an outage on one doesn't block the others.
 */
export async function fetchFromStremioAddons(
    type: 'movie' | 'series',
    stremioId: string
): Promise<NormalizedStream[]> {
    const sources = parseSources();
    if (sources.length === 0) return [];

    const settled = await Promise.allSettled(
        sources.map((src) =>
            withBreaker(`stremio:${src.name}`, () => fetchOne(src, type, stremioId))
        )
    );
    const all: NormalizedStream[] = [];
    for (const r of settled) {
        if (r.status === 'fulfilled') all.push(...r.value);
    }
    return all;
}

/**
 * Diagnostic helper for /status — list the addon sources we're configured
 * to consume (names only, never the apikey-bearing prefixes).
 */
export function listStremioAddonSources(): string[] {
    return parseSources().map((s) => s.name);
}
