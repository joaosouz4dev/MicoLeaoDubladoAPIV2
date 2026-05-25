/**
 * Real-Debrid client.
 *
 * Resolves a torrent to a playable HTTP URL via Real-Debrid.
 *
 * Two-mode flow:
 *  1. Check /torrents/instantAvailability/<hash> — if Real-Debrid already
 *     has this torrent cached, we get back a list of "variants" (file
 *     combinations) immediately.
 *  2a. Cached: addMagnet + selectFiles(<video file ids>) + info → unrestrict
 *      → playable URL. Fast (~3-5s).
 *  2b. Not cached: return null so the caller can fall back to the raw
 *      torrent stream. We DO NOT trigger a download — Stremio would time
 *      out waiting for RD to finish, and Vercel's 60s function limit makes
 *      it worse.
 *
 * Reference: https://api.real-debrid.com/
 */
import axios from 'axios';

const BASE_URL = 'https://api.real-debrid.com/rest/1.0';
const POLL_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 1000;

const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|m4v|mov|wmv|flv|webm|ts|m2ts)$/i;

export interface RealDebridStream {
    url: string;
    filename?: string;
    filesize?: number;
}

function buildMagnet(infoHash: string, sources: string[] = []): string {
    const trackers = sources
        .map((s) => s.startsWith('tracker:') ? s.slice('tracker:'.length) : s)
        .filter((s) => /^(udp|http|https):\/\//.test(s))
        .map((s) => `&tr=${encodeURIComponent(s)}`)
        .join('');
    return `magnet:?xt=urn:btih:${infoHash}${trackers}`;
}

/**
 * Ask Real-Debrid whether the torrent is already cached on their side.
 * The response is an object keyed by hash; an empty object means "not cached".
 *
 * The returned variants describe which file subsets can be served instantly.
 * We don't need to act on them — knowing the hash is cached is enough, since
 * addMagnet+selectFiles will resolve immediately for cached content.
 */
async function isInstantlyAvailable(apikey: string, infoHash: string): Promise<boolean> {
    try {
        const res = await axios.get(
            `${BASE_URL}/torrents/instantAvailability/${infoHash}`,
            { headers: { Authorization: `Bearer ${apikey}` }, timeout: 5000 }
        );
        const data = res.data?.[infoHash];
        if (!data) return false;
        // RD shape: `{ rd: [ { fileId: {filename, filesize}, ... }, ... ] }`
        // OR an empty array when not cached.
        if (Array.isArray(data) && data.length === 0) return false;
        if (data.rd && Array.isArray(data.rd) && data.rd.length > 0) return true;
        return false;
    } catch (err: any) {
        console.error(`[real-debrid] instantAvailability failed: ${err.message || err}`);
        return false;
    }
}

export async function resolveRealDebrid(
    apikey: string,
    infoHash: string,
    sources: string[] = []
): Promise<RealDebridStream | null> {
    // Fail fast for non-cached torrents — Stremio can't wait 30+ minutes
    // for RD to fetch a non-cached release.
    const cached = await isInstantlyAvailable(apikey, infoHash);
    if (!cached) {
        console.log(`[real-debrid] ${infoHash} not in RD cache, skipping`);
        return null;
    }

    const headers = { Authorization: `Bearer ${apikey}` };

    try {
        const addRes = await axios.post(
            `${BASE_URL}/torrents/addMagnet`,
            new URLSearchParams({ magnet: buildMagnet(infoHash, sources) }).toString(),
            { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        );
        const torrentId: string = addRes.data.id;
        if (!torrentId) return null;

        // First info call: list all files, pick the video ones
        const firstInfo = await axios.get(`${BASE_URL}/torrents/info/${torrentId}`, { headers, timeout: 5000 });
        const allFiles: Array<{ id: number; path: string; bytes: number }> = firstInfo.data?.files || [];
        const videoFileIds = allFiles
            .filter((f) => VIDEO_EXTENSIONS.test(f.path))
            .map((f) => f.id);
        const selectIds = videoFileIds.length > 0 ? videoFileIds.join(',') : 'all';

        await axios.post(
            `${BASE_URL}/torrents/selectFiles/${torrentId}`,
            new URLSearchParams({ files: selectIds }).toString(),
            { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        );

        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let links: string[] = [];
        let filename: string | undefined;
        let filesize: number | undefined;
        while (Date.now() < deadline) {
            const info = await axios.get(`${BASE_URL}/torrents/info/${torrentId}`, { headers, timeout: 5000 });
            if (info.data && Array.isArray(info.data.links) && info.data.links.length > 0) {
                links = info.data.links;
                filename = info.data.filename;
                filesize = info.data.bytes;
                break;
            }
            if (info.data && info.data.status && /error|magnet_error|virus|dead/.test(info.data.status)) {
                console.error(`[real-debrid] torrent failed: status=${info.data.status}`);
                return null;
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        if (links.length === 0) {
            console.error(`[real-debrid] poll timeout, torrent ${torrentId} didn't produce links`);
            return null;
        }

        // Pick the largest file's link (usually the main video for single-file packs)
        const linkToUnrestrict = links[0];
        const unrestricted = await axios.post(
            `${BASE_URL}/unrestrict/link`,
            new URLSearchParams({ link: linkToUnrestrict }).toString(),
            { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        );
        if (!unrestricted.data || !unrestricted.data.download) return null;
        return { url: unrestricted.data.download, filename, filesize };
    } catch (err: any) {
        const status = err.response?.status;
        const body = typeof err.response?.data === 'object' ? JSON.stringify(err.response.data) : err.response?.data;
        console.error(`[real-debrid] error status=${status} body=${body}: ${err.message || err}`);
        return null;
    }
}
