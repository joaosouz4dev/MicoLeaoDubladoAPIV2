/**
 * Pretty-formatter for Stremio Stream objects.
 *
 * Stremio displays a stream as:
 *   [name]    [title]
 *   left col  right col (multiline, supports emojis)
 *
 * Goal here is to look like Torrentio/Comet:
 *   name  → "🦁 Mico\n1080p"   (or "[RD ⚡] Mico\n1080p" for Debrid)
 *   title → release name + "🎥 codec • HDR | 🔊 audio"
 *                        + "🏷️ release group"
 *                        + "👥 N · 📦 size"
 *                        + "🌐 language flags"
 *
 * The release title is parsed (regex over the well-known scene-naming tokens)
 * into a `ParsedRelease` and rebuilt into a structured display.
 */

export interface ParsedRelease {
    quality?: string;       // 4K, 1080p, 720p, 480p, ...
    hdr?: string[];         // HDR, DV, HDR10+, ...
    codec?: string;         // x265 / HEVC / x264 / AV1
    audio?: string[];       // Dolby Digital, DTS, AAC, ...
    source?: string;        // BluRay, WEB-DL, WEBRip, HDTC, ...
    releaseGroup?: string;  // SF, STARCK, BLUDV, ...
    languages: string[];    // explicit language tags found in the title
    isDual: boolean;        // dual-audio / multi-audio
    isDubbed: boolean;      // dublado / portugu(es)
}

const QUALITY_RE = /\b(2160p|4K|1080p|720p|480p|360p)\b/i;
const HDR_RE = /\b(HDR10\+?|HDR|DV|Dolby\s*Vision)\b/gi;
const CODEC_RE = /\b(x265|HEVC|H\.?265|x264|H\.?264|AV1|VP9|XviD)\b/i;
const SOURCE_RE = /\b(BluRay|BDRip|WEB-?DL|WEB-?Rip|HDRip|DVDRip|HDTC|HDTS|CAM(Rip)?|TS|TC|REMUX)\b/i;
const GROUP_RE = /[-\s]\b(SF|STARCK|STARCKFILMES|BLUDV|COMANDO|RARBG|YIFY|EVO|GalaxyRG|FGT|MIRCrew|TGx|CMRG|PSA|TEPES|ION10|NOGRP|RICK|MeM)\b/i;
const AUDIO_RE = /\b(Dolby\s*Digital\s*Plus|DD\+|DDP|Dolby\s*Digital|DD|AC3|EAC3|E-AC-3|DTS-HD|DTS-X|DTS|TrueHD|Atmos|FLAC|AAC|MP3|5\.1|7\.1|2\.0)\b/gi;
const DUB_RE = /\bdubl(ado|agem)\b|\bdublado\b/i;
const DUAL_RE = /\b(dual[-\s]?(audio|áudio)|multi[-\s]?audio|2\.audios?)\b/i;
const PT_BR_RE = /\b(pt-?br|portugu(ê|e)s|brazilian|brasileiro|nacional)\b/i;
const EN_RE = /\b(english|inglês|ingles|legendado)\b/i;
const ES_RE = /\b(spanish|español|espanhol|castellano|latino)\b/i;

/**
 * Tokenize a release title into structured fields. Returns null for none
 * (everything is "best-effort" — unknown values are simply omitted).
 */
export function parseRelease(rawTitle: string): ParsedRelease {
    const t = rawTitle || '';

    const quality = QUALITY_RE.exec(t)?.[1]?.toUpperCase();
    const hdr = Array.from(t.matchAll(HDR_RE)).map((m) => m[1]).map(normalizeHdr);
    const codec = normalizeCodec(CODEC_RE.exec(t)?.[1]);
    const source = SOURCE_RE.exec(t)?.[1];
    const releaseGroupMatch = GROUP_RE.exec(t);
    const releaseGroup = releaseGroupMatch?.[1];

    const audioRaw = Array.from(t.matchAll(AUDIO_RE)).map((m) => m[1]);
    const audio = dedupe(audioRaw.map(normalizeAudio));

    const isDubbed = DUB_RE.test(t);
    const isDual = DUAL_RE.test(t) || (PT_BR_RE.test(t) && EN_RE.test(t));

    const languages: string[] = [];
    if (PT_BR_RE.test(t)) languages.push('pt-BR');
    if (EN_RE.test(t)) languages.push('en');
    if (ES_RE.test(t)) languages.push('es');

    return {
        quality,
        hdr: hdr.length > 0 ? dedupe(hdr) : undefined,
        codec,
        audio: audio.length > 0 ? audio : undefined,
        source,
        releaseGroup,
        languages,
        isDual,
        isDubbed
    };
}

function normalizeHdr(s: string): string {
    const x = s.toUpperCase().replace(/\s+/g, '');
    if (x === 'DOLBYVISION') return 'DV';
    return x;
}

function normalizeCodec(s: string | undefined): string | undefined {
    if (!s) return undefined;
    const u = s.toUpperCase().replace(/[.\s]/g, '');
    if (u === 'HEVC' || u === 'H265' || u === 'X265') return 'HEVC';
    if (u === 'H264' || u === 'X264') return 'x264';
    return u;
}

function normalizeAudio(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

function dedupe<T>(arr: T[]): T[] {
    return Array.from(new Set(arr));
}

// -------- format ----------

const FLAGS: Record<string, string> = {
    'pt-BR': '🇧🇷',
    en: '🇺🇸',
    es: '🇪🇸'
};

export interface StreamFormatInput {
    rawTitle: string;
    seeders: number;
    sizeBytes?: number;
    provider: string;          // 'torrent-indexer', 'guindex', 'thepiratafilmes', ...
    debrid?: {
        provider: 'realdebrid' | 'torbox';
        cached: boolean;       // true ⇒ instant streaming; false ⇒ would queue (we skip these)
    };
}

export interface FormattedStream {
    name: string;
    title: string;
}

/**
 * Build the Stremio-display strings for a stream.
 *
 * `name` is the small left-column label. Keep it ≤ 2 lines, brand + quality.
 * `title` is the multiline right-column blob. Order chosen to roughly match
 *         Torrentio/Comet so users have a familiar layout:
 *           line 1: release title (truncated if huge)
 *           line 2: 🎥 codec • HDR | 🔊 audio
 *           line 3: 🏷️ release group  (only when known)
 *           line 4: 👥 seeders · 📦 size  ([⚡ Cache] for Debrid)
 *           line 5: 🌐 language flags
 */
export function formatStream(input: StreamFormatInput): FormattedStream {
    const p = parseRelease(input.rawTitle);

    const brand = input.debrid
        ? `[${input.debrid.provider === 'realdebrid' ? 'RD' : 'TB'} ⚡] Mico`
        : '🦁 Mico';
    const qualityLabel = p.quality || 'SD';
    const name = `${brand}\n${qualityLabel}`;

    const lines: string[] = [];
    lines.push(truncate(stripNoise(input.rawTitle), 70));

    const techParts: string[] = [];
    if (p.codec || (p.hdr && p.hdr.length > 0)) {
        const left = [p.codec, ...(p.hdr || [])].filter(Boolean).join(' • ');
        if (left) techParts.push(`🎥 ${left}`);
    }
    if (p.audio && p.audio.length > 0) {
        techParts.push(`🔊 ${p.audio.slice(0, 2).join(' ')}`);
    }
    if (techParts.length > 0) lines.push(techParts.join(' | '));

    if (p.releaseGroup) lines.push(`🏷️ ${p.releaseGroup}`);

    const meta: string[] = [];
    meta.push(`👥 ${input.seeders ?? 0}`);
    if (input.sizeBytes) meta.push(`📦 ${formatBytes(input.sizeBytes)}`);
    if (input.debrid?.cached) meta.push(`⚡ Cache`);
    lines.push(meta.join(' · '));

    const flags = (p.languages || []).map((l) => FLAGS[l] || '').filter(Boolean).join('/');
    if (flags) lines.push(`🌐 ${flags}`);

    // Append source provider so users know where it came from (small, last)
    lines.push(`via ${input.provider}`);

    return { name, title: lines.join('\n') };
}

function truncate(s: string, n: number): string {
    if (!s) return '';
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function stripNoise(s: string): string {
    return s
        .replace(/\b(www\.[^\s]+)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    return `${bytes} B`;
}

/**
 * Numeric quality rank for sorting (higher = better).
 */
export function qualityRank(quality?: string): number {
    if (!quality) return 0;
    const q = quality.toUpperCase();
    if (q === '4K' || q === '2160P') return 4;
    if (q === '1080P') return 3;
    if (q === '720P') return 2;
    if (q === '480P') return 1;
    return 0;
}
