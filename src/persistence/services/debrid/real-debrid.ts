/**
 * Real-Debrid client.
 *
 * Flow:
 *  1. addMagnet     POST /torrents/addMagnet           → torrent id
 *  2. selectFiles   POST /torrents/selectFiles/{id}    (select all)
 *  3. info          GET  /torrents/info/{id}           → wait for downloaded link
 *  4. unrestrict    POST /unrestrict/link              → playable URL
 *
 * Reference: https://api.real-debrid.com/
 */
import axios from 'axios';

const BASE_URL = 'https://api.real-debrid.com/rest/1.0';
const POLL_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 1500;

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

export async function resolveRealDebrid(
    apikey: string,
    infoHash: string,
    sources: string[] = []
): Promise<RealDebridStream | null> {
    const headers = { Authorization: `Bearer ${apikey}` };

    try {
        const addRes = await axios.post(
            `${BASE_URL}/torrents/addMagnet`,
            new URLSearchParams({ magnet: buildMagnet(infoHash, sources) }).toString(),
            { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        const torrentId: string = addRes.data.id;
        if (!torrentId) return null;

        await axios.post(
            `${BASE_URL}/torrents/selectFiles/${torrentId}`,
            new URLSearchParams({ files: 'all' }).toString(),
            { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let links: string[] = [];
        let filename: string | undefined;
        let filesize: number | undefined;
        while (Date.now() < deadline) {
            const info = await axios.get(`${BASE_URL}/torrents/info/${torrentId}`, { headers });
            if (info.data && Array.isArray(info.data.links) && info.data.links.length > 0) {
                links = info.data.links;
                filename = info.data.filename;
                filesize = info.data.bytes;
                break;
            }
            if (info.data && info.data.status && /error|magnet_error|virus|dead/.test(info.data.status)) {
                return null;
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        if (links.length === 0) return null;

        const unrestricted = await axios.post(
            `${BASE_URL}/unrestrict/link`,
            new URLSearchParams({ link: links[0] }).toString(),
            { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        if (!unrestricted.data || !unrestricted.data.download) return null;
        return { url: unrestricted.data.download, filename, filesize };
    } catch (err: any) {
        console.error(`Real-Debrid error: ${err.message || err}`);
        return null;
    }
}
