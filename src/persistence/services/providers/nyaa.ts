/**
 * Nyaa.si provider.
 *
 * Anime dublado / PT-BR releases live on Nyaa with explicit [DUAL]/[PT-BR]/
 * (Dublado) tags. The site exposes an RSS feed (no JSON API) but the XML is
 * trivial to parse and includes `<nyaa:infoHash>` and `<nyaa:seeders>` —
 * everything we need.
 *
 * Reference: https://nyaa.si/?page=rss
 */
import axios from 'axios';
import type { NormalizedStream } from './types';
import { withBreaker } from './circuit-breaker';
import { lookupTitles, tmdbAvailable } from '../tmdb';
import { fetchCinemeta } from '../cinemeta';

const BASE = process.env.NYAA_BASE || 'https://nyaa.si';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Stremio/4.4 MicoLeaoV2';
const TIMEOUT_MS = 7000;

const PT_BR_MARKERS = [
    /\bdubl(ado|agem)\b/i,
    /\bpt-?br\b/i,
    /\bportugu(ê|e)s\b/i,
    /\bbrazilian\b/i,
    /\bdual[-\s]?(audio|áudio)\b/i
];

function isPtBr(text: string): boolean {
    return PT_BR_MARKERS.some((re) => re.test(text));
}

function parseSize(s: string | undefined): number | undefined {
    if (!s) return undefined;
    const m = /([\d.]+)\s*(GiB|MiB|GB|MB|KiB|KB)/i.exec(s);
    if (!m) return undefined;
    const n = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    if (u === 'gib' || u === 'gb') return Math.round(n * 1024 * 1024 * 1024);
    if (u === 'mib' || u === 'mb') return Math.round(n * 1024 * 1024);
    return Math.round(n * 1024);
}

/**
 * Minimal Nyaa RSS parser. We don't need a full XML lib — the format is
 * stable and we only want a fixed set of fields per `<item>`.
 */
function parseRss(xml: string): NormalizedStream[] {
    const items: NormalizedStream[] = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml)) !== null) {
        const body = m[1];
        const title = pickText(body, /<title>([\s\S]*?)<\/title>/);
        const infoHash = pickText(body, /<nyaa:infoHash>([\s\S]*?)<\/nyaa:infoHash>/);
        const seedersStr = pickText(body, /<nyaa:seeders>([\s\S]*?)<\/nyaa:seeders>/);
        const sizeStr = pickText(body, /<nyaa:size>([\s\S]*?)<\/nyaa:size>/);
        if (!title || !infoHash) continue;
        if (!isPtBr(title)) continue;
        items.push({
            title,
            infoHash: infoHash.toLowerCase(),
            sources: [],
            seeders: seedersStr ? parseInt(seedersStr, 10) || 0 : 0,
            size: parseSize(sizeStr),
            provider: 'nyaa',
            languages: ['pt-BR']
        });
    }
    return items;
}

function pickText(body: string, re: RegExp): string | undefined {
    const m = re.exec(body);
    if (!m) return undefined;
    return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

async function searchNyaa(query: string): Promise<NormalizedStream[]> {
    // c=1_0 → all anime categories (RAW, English, ...). We'd rather filter on
    // title since dubbed Brazilian releases land in 1_2 (English-translated) or
    // 1_3 (raw) depending on uploader convention.
    const url = `${BASE}/?page=rss&q=${encodeURIComponent(query)}&c=1_0&f=0`;
    try {
        const res = await axios.get(url, { timeout: TIMEOUT_MS, headers: { 'User-Agent': UA } });
        const xml = typeof res.data === 'string' ? res.data : '';
        const items = parseRss(xml);
        console.log(`[nyaa] "${query}" → ${items.length} PT-BR items`);
        return items;
    } catch (err: any) {
        const status = err.response?.status;
        console.error(`[nyaa] failed status=${status}: ${err.message || err}`);
        return [];
    }
}

/**
 * Fetch anime streams for the given IMDb id. Strategy:
 *   - Resolve PT-BR + original titles (via TMDB → Cinemeta fallback)
 *   - For series with a specific episode, append "S{xx}E{yy}" so we don't
 *     return whole-season packs when the user is asking for one episode
 *   - Hit /?page=rss for each candidate, dedupe by infoHash
 *
 * The PT-BR filter happens during XML parsing, so we never return non-dubbed
 * Japanese-only torrents.
 */
export async function fetchFromNyaa(
    imdbId: string,
    type: 'movie' | 'series' = 'movie',
    streamId?: string
): Promise<NormalizedStream[]> {
    return withBreaker('nyaa', async () => {
        let ptBr: string | undefined;
        let original: string | undefined;
        if (tmdbAvailable()) {
            const t = await lookupTitles(imdbId, type);
            ptBr = t.ptBr;
            original = t.original;
        }
        if (!ptBr && !original) {
            const cm = await fetchCinemeta(type, imdbId);
            ptBr = cm?.name;
        }
        if (!ptBr && !original) return [];

        const baseCandidates = [original, ptBr].filter((t): t is string => !!t);

        let suffixes: string[] = [''];
        if (type === 'series' && streamId) {
            const parts = streamId.split(':');
            const s = parts[1] ? pad(parseInt(parts[1], 10)) : undefined;
            const e = parts[2] ? pad(parseInt(parts[2], 10)) : undefined;
            if (s && e) suffixes = [`S${s}E${e}`, ''];
        }

        const queries = baseCandidates.flatMap((base) =>
            suffixes.map((suf) => (suf ? `${base} ${suf} dublado` : `${base} dublado`))
        );
        // De-dupe queries while preserving order
        const seenQ = new Set<string>();
        const tries = queries.filter((q) => {
            const k = q.toLowerCase();
            if (seenQ.has(k)) return false;
            seenQ.add(k);
            return true;
        });

        const allResults: NormalizedStream[] = [];
        const seenHash = new Set<string>();
        for (const q of tries.slice(0, 3)) {
            const items = await searchNyaa(q);
            for (const it of items) {
                if (seenHash.has(it.infoHash)) continue;
                seenHash.add(it.infoHash);
                allResults.push(it);
            }
            if (allResults.length >= 15) break;
        }
        return allResults;
    });
}

function pad(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}
