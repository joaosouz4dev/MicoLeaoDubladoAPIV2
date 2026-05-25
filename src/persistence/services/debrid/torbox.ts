/**
 * TorBox client.
 *
 * Two-mode flow:
 *  1. Check /torrents/checkcached/<hash> — if TorBox already has this torrent,
 *     we get a hit and proceed immediately.
 *  2a. Cached: createtorrent + mylist (fast poll) + requestdl → playable URL.
 *  2b. Not cached: return null so the caller can fall back to the raw torrent
 *      stream. Triggering a TorBox download would take minutes and Vercel's
 *      60s function limit makes it impossible to wait synchronously.
 *
 * Reference: https://api-docs.torbox.app/
 */
import axios from 'axios';

const BASE_URL = 'https://api.torbox.app/v1/api';
const POLL_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 1000;

const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|m4v|mov|wmv|flv|webm|ts|m2ts)$/i;

export interface TorBoxStream {
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
 * Ask TorBox whether the torrent is already cached. Endpoint accepts a comma-
 * separated list of hashes; we only check one at a time here.
 */
async function isCached(apikey: string, infoHash: string): Promise<boolean> {
    try {
        const res = await axios.get(
            `${BASE_URL}/torrents/checkcached`,
            {
                headers: { Authorization: `Bearer ${apikey}` },
                params: { hash: infoHash, format: 'object' },
                timeout: 5000
            }
        );
        const data = res.data?.data;
        if (!data) return false;
        if (Array.isArray(data)) return data.length > 0;
        return !!data[infoHash] || !!data[infoHash.toLowerCase()];
    } catch (err: any) {
        console.error(`[torbox] checkcached failed: ${err.message || err}`);
        return false;
    }
}

export async function resolveTorBox(
    apikey: string,
    infoHash: string,
    sources: string[] = []
): Promise<TorBoxStream | null> {
    const cached = await isCached(apikey, infoHash);
    if (!cached) {
        console.log(`[torbox] ${infoHash} not in TorBox cache, skipping`);
        return null;
    }

    const headers = { Authorization: `Bearer ${apikey}` };
    try {
        const form = new URLSearchParams();
        form.append('magnet', buildMagnet(infoHash, sources));
        const createRes = await axios.post(
            `${BASE_URL}/torrents/createtorrent`,
            form.toString(),
            { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        );
        const torrentId: number | undefined = createRes.data?.data?.torrent_id ?? createRes.data?.data?.id;
        if (torrentId === undefined) return null;

        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let fileId: number | undefined;
        let filename: string | undefined;
        let filesize: number | undefined;
        while (Date.now() < deadline) {
            const list = await axios.get(`${BASE_URL}/torrents/mylist`, {
                headers,
                params: { id: torrentId, bypass_cache: true },
                timeout: 5000
            });
            const torrent = Array.isArray(list.data?.data) ? list.data.data[0] : list.data?.data;
            if (torrent && Array.isArray(torrent.files) && torrent.files.length > 0) {
                // Prefer the biggest video file; fall back to biggest of any kind
                const videoFiles = torrent.files.filter((f: any) => VIDEO_EXTENSIONS.test(f.name || ''));
                const pool = videoFiles.length > 0 ? videoFiles : torrent.files;
                const biggest = pool.reduce((a: any, b: any) => (a.size > b.size ? a : b));
                fileId = biggest.id;
                filename = biggest.name;
                filesize = biggest.size;
                break;
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        if (fileId === undefined) {
            console.error(`[torbox] poll timeout, torrent ${torrentId} didn't produce files`);
            return null;
        }

        const dl = await axios.get(`${BASE_URL}/torrents/requestdl`, {
            headers,
            params: { token: apikey, torrent_id: torrentId, file_id: fileId },
            timeout: 10000
        });
        const url = dl.data?.data;
        if (typeof url !== 'string' || !url) return null;
        return { url, filename, filesize };
    } catch (err: any) {
        const status = err.response?.status;
        const body = typeof err.response?.data === 'object' ? JSON.stringify(err.response.data) : err.response?.data;
        console.error(`[torbox] error status=${status} body=${body}: ${err.message || err}`);
        return null;
    }
}
