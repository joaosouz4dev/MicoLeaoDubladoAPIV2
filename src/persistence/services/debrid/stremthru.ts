/**
 * StremThru client — unified Debrid backend.
 *
 * StremThru (github.com/MunifTanjim/stremthru) is a Go proxy that fronts 9+
 * Debrid providers behind a single HTTP API. The hosted instance at
 * stremthru.elfhosted.com is free, requires no signup, and forwards the
 * user's existing RD/TorBox token via headers (we never store it).
 *
 * Why this beats hitting RD/TorBox directly:
 *   - `/v0/store/magnets/check` works around RD's dead instantAvailability:
 *     StremThru combines per-provider native checks with a crowdsourced
 *     cache hint pool, so we get a reliable "is this hash cached?" signal
 *     without spamming addMagnet.
 *   - Auto-cleanup: StremThru's RemoveMagnet contract is part of the same
 *     flow, no orphan "queued" torrents on the user's account.
 *   - Stable stream URLs via the proxy — the link we serve to Stremio stays
 *     valid past the raw RD link expiry.
 *   - Single client code path for all providers; provider-specific quirks
 *     live inside StremThru.
 *
 * Reference: https://github.com/MunifTanjim/stremthru
 *            https://docs.stremthru.13377001.xyz/
 */
import axios, { AxiosRequestConfig } from 'axios';

const BASE = (process.env.STREMTHRU_BASE_URL || 'https://stremthru.elfhosted.com').replace(/\/$/, '');
const STREMTHRU_AUTH = process.env.STREMTHRU_AUTH || ''; // optional, for self-hosted instances
const UA = 'MicoLeaoDubladoAPIV2/2.1';

export type StremThruStoreName = 'realdebrid' | 'torbox' | 'alldebrid' | 'premiumize' | 'debridlink' | 'offcloud' | 'pikpak' | 'easydebrid' | 'debrider';

export interface StremThruStream {
    url: string;
    filename?: string;
    filesize?: number;
}

export interface StremThruCheckResult {
    hash: string;
    cached: boolean;
}

function headers(storeName: StremThruStoreName, storeAuth: string): Record<string, string> {
    const h: Record<string, string> = {
        'User-Agent': UA,
        Accept: 'application/json',
        'X-StremThru-Store-Name': storeName,
        'X-StremThru-Store-Authorization': storeAuth
    };
    // The hosted ElfHosted instance is open; some self-hosted setups use
    // STREMTHRU_PROXY_AUTH to gate access. Forward when set.
    if (STREMTHRU_AUTH) h['Proxy-Authorization'] = `Basic ${STREMTHRU_AUTH}`;
    return h;
}

async function st<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, storeName: StremThruStoreName, storeAuth: string, body?: any): Promise<T | null> {
    const cfg: AxiosRequestConfig = {
        method,
        url: `${BASE}${path}`,
        headers: headers(storeName, storeAuth),
        timeout: 10000
    };
    if (body !== undefined) cfg.data = body;
    try {
        const res = await axios.request<{ data?: T; error?: any }>(cfg);
        if (res.data?.error) {
            console.error(`[stremthru] ${method} ${path} error:`, res.data.error);
            return null;
        }
        return (res.data?.data ?? (res.data as any)) as T;
    } catch (err: any) {
        const status = err.response?.status;
        const body = typeof err.response?.data === 'object' ? JSON.stringify(err.response.data) : err.response?.data;
        console.error(`[stremthru] ${method} ${path} status=${status} body=${body}: ${err.message || err}`);
        return null;
    }
}

/**
 * Batch-check whether a list of info-hashes is cached on the given store.
 * StremThru accepts repeated `magnet=` query params (one per hash) — the hash
 * alone is a valid "magnet" identifier for them.
 *
 * Returns a Map<hash, cached>. Hashes the server didn't respond about are
 * absent (treat as not-cached).
 */
export async function stremthruCheckMagnets(
    storeName: StremThruStoreName,
    storeAuth: string,
    infoHashes: string[]
): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (infoHashes.length === 0) return result;
    // /v0/store/magnets/check?magnet=hash1&magnet=hash2&...
    const params = new URLSearchParams();
    for (const h of infoHashes) params.append('magnet', h);
    const data = await st<any>('GET', `/v0/store/magnets/check?${params.toString()}`, storeName, storeAuth);
    if (!data) return result;
    // Response shape: { items: [{ hash, status: 'cached' | 'uncached', ... }] }
    const items = Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
    for (const it of items) {
        const hash = (it.hash || it.infohash || '').toLowerCase();
        if (!hash) continue;
        const cached = it.status === 'cached' || it.cached === true;
        result.set(hash, cached);
    }
    return result;
}

/**
 * Add a magnet + generate a streaming URL via StremThru.
 *
 * Internally StremThru does:
 *   1. Send the magnet to the chosen store (RD/TB/AD/...)
 *   2. Wait for it to enter `downloaded`/`cached` state (with timeout)
 *   3. Pick the largest video file
 *   4. Return a proxied URL that's stable across the RD link expiry window
 *
 * If the torrent isn't cached, StremThru returns the magnet in a transient
 * state and we get back `null` — same contract as our previous code, but
 * without the orphan-torrent problem (StremThru cleans up automatically
 * for uncached attempts when the request times out).
 */
export async function stremthruResolve(
    storeName: StremThruStoreName,
    storeAuth: string,
    infoHash: string
): Promise<StremThruStream | null> {
    const magnet = `magnet:?xt=urn:btih:${infoHash}`;

    // 1. Add the magnet (StremThru returns the magnet id + status)
    const addData = await st<any>('POST', '/v0/store/magnets', storeName, storeAuth, { magnet });
    if (!addData) return null;
    const magnetId: string | undefined = addData.id;
    const status: string | undefined = addData.status;
    if (!magnetId) return null;

    if (status && status !== 'downloaded' && status !== 'cached') {
        // Not instantly available — abort and let StremThru clean up.
        // Some installations need an explicit DELETE; safe to attempt.
        st('DELETE', `/v0/store/magnets/${encodeURIComponent(magnetId)}`, storeName, storeAuth).catch(() => {});
        return null;
    }

    // 2. Pick the biggest video file (StremThru returns `files`)
    const files: Array<{ index?: number; id?: string | number; name?: string; size?: number; link?: string }> = addData.files || [];
    if (files.length === 0) return null;
    const VIDEO_RE = /\.(mkv|mp4|avi|m4v|mov|webm|ts|m2ts)$/i;
    const videoFiles = files.filter((f) => VIDEO_RE.test(f.name || ''));
    const pool = videoFiles.length > 0 ? videoFiles : files;
    const biggest = pool.reduce((a, b) => ((a.size || 0) > (b.size || 0) ? a : b));

    // 3. Generate a stream URL for that file
    const linkInput = biggest.link;
    if (!linkInput) {
        console.error(`[stremthru] magnet ${magnetId} file has no link`);
        return null;
    }
    const linkData = await st<any>('POST', '/v0/store/link/generate', storeName, storeAuth, { link: linkInput });
    if (!linkData?.link) return null;

    return {
        url: linkData.link,
        filename: biggest.name,
        filesize: biggest.size
    };
}

/**
 * Health check — used by /status to show whether StremThru is reachable.
 */
export async function stremthruHealth(): Promise<boolean> {
    try {
        const res = await axios.get(`${BASE}/v0/health`, { timeout: 4000, headers: { 'User-Agent': UA } });
        return res.data?.data?.status === 'ok' || res.status === 200;
    } catch {
        return false;
    }
}

export function stremthruBaseUrl(): string {
    return BASE;
}
