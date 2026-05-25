/**
 * Torrentio provider (via Cloudflare Worker when TORRENTIO_BASE points to one).
 *
 * Torrentio blocks Vercel IPs directly. Deploy cloudflare-worker/ and set
 * TORRENTIO_BASE to the worker URL.
 */
import axios from 'axios';
import type { NormalizedStream } from './types';

const UPSTREAM_BASES = (process.env.TORRENTIO_BASE || 'https://torrentio.strem.fun')
    .split(',').map((s) => s.trim()).filter(Boolean);

const HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Stremio/4.4'
};
if (process.env.WORKER_SECRET) HEADERS['x-worker-secret'] = process.env.WORKER_SECRET;

const PT_BR_MARKERS = [
    /\bdubl(ado|agem)\b/i,
    /🇧🇷/,
    /\bpt-?br\b/i,
    /\bportugu(ê|e)s\b.*\bbrasil(eiro)?\b/i,
    /\bbrazilian\b/i,
    /\bmulti(audio)?\b.*\bpt\b/i
];

function isPtBr(title: string): boolean {
    return PT_BR_MARKERS.some((re) => re.test(title));
}

function parseSeeders(title: string): number {
    const m = /👤\s*(\d+)/.exec(title);
    return m ? parseInt(m[1], 10) : 0;
}

function parseSize(title: string): number | undefined {
    const m = /💾\s*([\d.]+)\s*(GB|MB)/i.exec(title);
    if (!m) return undefined;
    const n = parseFloat(m[1]);
    return m[2].toUpperCase() === 'GB' ? n * 1024 * 1024 * 1024 : n * 1024 * 1024;
}

export async function fetchFromTorrentio(type: 'movie' | 'series', stremioId: string): Promise<NormalizedStream[]> {
    for (const base of UPSTREAM_BASES) {
        const url = `${base}/stream/${type}/${encodeURIComponent(stremioId)}.json`;
        try {
            const res = await axios.get(url, { timeout: 8000, headers: HEADERS });
            const raw = Array.isArray(res.data?.streams) ? res.data.streams : [];
            const filtered: NormalizedStream[] = raw
                .filter((s: any) => s.infoHash && isPtBr(s.title || s.name || ''))
                .map((s: any) => ({
                    title: (s.title || s.name || '').replace(/^Torrentio\s*[\r\n]+/i, '').trim(),
                    infoHash: s.infoHash.toLowerCase(),
                    sources: s.sources || [],
                    seeders: parseSeeders(s.title || ''),
                    size: parseSize(s.title || ''),
                    provider: 'torrentio'
                }));
            if (filtered.length > 0) {
                console.log(`[torrentio] ${base}: ${filtered.length} PT-BR streams for ${stremioId}`);
                return filtered;
            }
        } catch (err: any) {
            console.error(`[torrentio] ${base} failed status=${err.response?.status}: ${err.message || err}`);
        }
    }
    return [];
}
