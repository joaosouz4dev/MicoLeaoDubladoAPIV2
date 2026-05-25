/**
 * TorBox client.
 *
 * Resolves a torrent to a playable HTTP URL — only when TorBox already has
 * it cached. Non-cached torrents are dropped (and the queued entry deleted)
 * so the user's account isn't polluted.
 *
 * Cache detection
 * ===============
 * TorBox's `/torrents/checkcached` endpoint is reliable; we use it as a fast
 * gate. Only if cached do we proceed with createtorrent + mylist + requestdl.
 *
 * Even when checkcached says yes, we still verify the torrent reached
 * `cached === true` after createtorrent — paranoid but ensures we never
 * advertise a download that won't play.
 *
 * Reference: https://api-docs.torbox.app/
 */
import axios from 'axios';

const BASE_URL = 'https://api.torbox.app/v1/api';
const FAST_POLL_TIMEOUT_MS = 5000;
const FAST_POLL_INTERVAL_MS = 700;

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

async function deleteTorrent(apikey: string, torrentId: number | string): Promise<void> {
    try {
        await axios.post(
            `${BASE_URL}/torrents/controltorrent`,
            new URLSearchParams({ torrent_id: String(torrentId), operation: 'delete' }).toString(),
            {
                headers: {
                    Authorization: `Bearer ${apikey}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 4000
            }
        );
    } catch (err: any) {
        console.error(`[torbox] delete ${torrentId} failed: ${err.message || err}`);
    }
}

export async function resolveTorBox(
    apikey: string,
    infoHash: string,
    sources: string[] = []
): Promise<TorBoxStream | null> {
    const cached = await isCached(apikey, infoHash);
    if (!cached) {
        console.log(`[torbox] ${infoHash} not in cache, skipping`);
        return null;
    }

    const headers = { Authorization: `Bearer ${apikey}` };
    let torrentId: number | string | undefined;

    try {
        const form = new URLSearchParams();
        form.append('magnet', buildMagnet(infoHash, sources));
        const createRes = await axios.post(
            `${BASE_URL}/torrents/createtorrent`,
            form.toString(),
            { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
        );
        torrentId = createRes.data?.data?.torrent_id ?? createRes.data?.data?.id;
        if (torrentId === undefined) {
            console.error(`[torbox] createtorrent returned no id`);
            return null;
        }

        const deadline = Date.now() + FAST_POLL_TIMEOUT_MS;
        let fileId: number | undefined;
        let filename: string | undefined;
        let filesize: number | undefined;
        let lastStatus = '';
        while (Date.now() < deadline) {
            const list = await axios.get(`${BASE_URL}/torrents/mylist`, {
                headers,
                params: { id: torrentId, bypass_cache: true },
                timeout: 4000
            });
            const torrent = Array.isArray(list.data?.data) ? list.data.data[0] : list.data?.data;
            lastStatus = torrent?.download_state || torrent?.state || '';
            const isReady = torrent && (torrent.cached === true || lastStatus === 'completed' || lastStatus === 'downloaded');
            if (isReady && Array.isArray(torrent.files) && torrent.files.length > 0) {
                const videoFiles = torrent.files.filter((f: any) => VIDEO_EXTENSIONS.test(f.name || ''));
                const pool = videoFiles.length > 0 ? videoFiles : torrent.files;
                const biggest = pool.reduce((a: any, b: any) => (a.size > b.size ? a : b));
                fileId = biggest.id;
                filename = biggest.name;
                filesize = biggest.size;
                break;
            }
            await new Promise((r) => setTimeout(r, FAST_POLL_INTERVAL_MS));
        }

        if (fileId === undefined) {
            console.log(`[torbox] ${infoHash} not ready (status=${lastStatus}), deleting`);
            await deleteTorrent(apikey, torrentId);
            return null;
        }

        const dl = await axios.get(`${BASE_URL}/torrents/requestdl`, {
            headers,
            params: { token: apikey, torrent_id: torrentId, file_id: fileId },
            timeout: 8000
        });
        const url = dl.data?.data;
        if (typeof url !== 'string' || !url) {
            console.error(`[torbox] requestdl returned no url`);
            return null;
        }
        return { url, filename, filesize };
    } catch (err: any) {
        const status = err.response?.status;
        const body = typeof err.response?.data === 'object' ? JSON.stringify(err.response.data) : err.response?.data;
        console.error(`[torbox] error status=${status} body=${body}: ${err.message || err}`);
        if (torrentId !== undefined) await deleteTorrent(apikey, torrentId);
        return null;
    }
}
