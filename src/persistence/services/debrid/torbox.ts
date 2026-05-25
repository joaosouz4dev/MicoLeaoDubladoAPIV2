/**
 * TorBox client.
 *
 * Flow:
 *  1. createTorrent           POST /torrents/createtorrent    → torrent id
 *  2. mylist (poll)           GET  /torrents/mylist           → wait for cached file
 *  3. requestDownloadLink     GET  /torrents/requestdl        → playable URL
 *
 * Reference: https://api-docs.torbox.app/
 */
import axios from 'axios';

const BASE_URL = 'https://api.torbox.app/v1/api';
const POLL_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 1500;

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

export async function resolveTorBox(
    apikey: string,
    infoHash: string,
    sources: string[] = []
): Promise<TorBoxStream | null> {
    const headers = { Authorization: `Bearer ${apikey}` };
    try {
        const form = new URLSearchParams();
        form.append('magnet', buildMagnet(infoHash, sources));
        const createRes = await axios.post(
            `${BASE_URL}/torrents/createtorrent`,
            form.toString(),
            { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } }
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
                params: { id: torrentId, bypass_cache: true }
            });
            const torrent = Array.isArray(list.data?.data) ? list.data.data[0] : list.data?.data;
            if (torrent && Array.isArray(torrent.files) && torrent.files.length > 0) {
                const biggest = torrent.files.reduce((a: any, b: any) => (a.size > b.size ? a : b));
                fileId = biggest.id;
                filename = biggest.name;
                filesize = biggest.size;
                break;
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        if (fileId === undefined) return null;

        const dl = await axios.get(`${BASE_URL}/torrents/requestdl`, {
            headers,
            params: { token: apikey, torrent_id: torrentId, file_id: fileId }
        });
        const url = dl.data?.data;
        if (typeof url !== 'string' || !url) return null;
        return { url, filename, filesize };
    } catch (err: any) {
        console.error(`TorBox error: ${err.message || err}`);
        return null;
    }
}
