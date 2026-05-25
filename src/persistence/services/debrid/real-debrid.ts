/**
 * Real-Debrid client.
 *
 * Resolves a torrent to a playable HTTP URL — only when Real-Debrid already
 * has it cached. Non-cached torrents are dropped so Stremio doesn't show
 * stale `[RD ⚡]` rows that would either timeout or queue a download on the
 * user's account.
 *
 * Cache detection (June 2025+ reality)
 * ====================================
 * Real-Debrid deprecated `/torrents/instantAvailability` in mid-2025:
 * it now returns `[]`/`{}` for everything, so we can't trust it as a
 * gate anymore.
 *
 * Workaround: add the magnet, check status within ~3s, and:
 *   - status === 'downloaded'  → cached, proceed with unrestrict
 *   - any other status         → not cached, DELETE the torrent and bail
 *
 * The DELETE is critical: without it, every non-cached request leaves a
 * "queued"/"compressing" torrent on the user's account that they have to
 * clean up manually.
 *
 * Reference: https://api.real-debrid.com/
 */
import axios from 'axios';

const BASE_URL = 'https://api.real-debrid.com/rest/1.0';
const FAST_POLL_TIMEOUT_MS = 4000;
const FAST_POLL_INTERVAL_MS = 800;

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

async function deleteTorrent(apikey: string, torrentId: string): Promise<void> {
    try {
        await axios.delete(`${BASE_URL}/torrents/delete/${torrentId}`, {
            headers: { Authorization: `Bearer ${apikey}` },
            timeout: 4000
        });
    } catch (err: any) {
        console.error(`[real-debrid] delete ${torrentId} failed: ${err.message || err}`);
    }
}

export async function resolveRealDebrid(
    apikey: string,
    infoHash: string,
    sources: string[] = []
): Promise<RealDebridStream | null> {
    const headers = { Authorization: `Bearer ${apikey}` };
    let torrentId: string | undefined;

    try {
        const addRes = await axios.post(
            `${BASE_URL}/torrents/addMagnet`,
            new URLSearchParams({ magnet: buildMagnet(infoHash, sources) }).toString(),
            { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
        );
        torrentId = addRes.data?.id;
        if (!torrentId) {
            console.error(`[real-debrid] addMagnet returned no id`);
            return null;
        }

        // First info — list files to know which IDs to select
        const firstInfo = await axios.get(`${BASE_URL}/torrents/info/${torrentId}`, { headers, timeout: 5000 });
        const status0: string = firstInfo.data?.status || '';
        const allFiles: Array<{ id: number; path: string; bytes: number }> = firstInfo.data?.files || [];

        if (status0 === 'magnet_error' || status0 === 'error' || status0 === 'virus' || status0 === 'dead') {
            console.error(`[real-debrid] ${infoHash} magnet error: ${status0}`);
            await deleteTorrent(apikey, torrentId);
            return null;
        }

        // Select video files (or all if no clear video file)
        const videoFileIds = allFiles
            .filter((f) => VIDEO_EXTENSIONS.test(f.path))
            .map((f) => f.id);
        const selectIds = videoFileIds.length > 0 ? videoFileIds.join(',') : 'all';

        await axios.post(
            `${BASE_URL}/torrents/selectFiles/${torrentId}`,
            new URLSearchParams({ files: selectIds }).toString(),
            { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
        );

        // Fast poll — cached torrents reach `downloaded` in < 1s after selectFiles.
        // Anything else (queued/downloading/compressing) means RD started a
        // background fetch we can't wait for.
        const deadline = Date.now() + FAST_POLL_TIMEOUT_MS;
        let downloadedInfo: any = null;
        let lastStatus = '';
        while (Date.now() < deadline) {
            const info = await axios.get(`${BASE_URL}/torrents/info/${torrentId}`, { headers, timeout: 4000 });
            lastStatus = info.data?.status || '';
            if (lastStatus === 'downloaded' && Array.isArray(info.data.links) && info.data.links.length > 0) {
                downloadedInfo = info.data;
                break;
            }
            if (/error|magnet_error|virus|dead/.test(lastStatus)) {
                console.error(`[real-debrid] ${infoHash} status=${lastStatus}`);
                await deleteTorrent(apikey, torrentId);
                return null;
            }
            await new Promise((r) => setTimeout(r, FAST_POLL_INTERVAL_MS));
        }

        if (!downloadedInfo) {
            // Not cached — RD is downloading it in background. Delete it so the
            // user's account isn't polluted with phantom torrents.
            console.log(`[real-debrid] ${infoHash} NOT cached (status=${lastStatus}), deleting`);
            await deleteTorrent(apikey, torrentId);
            return null;
        }

        // Unrestrict the first link (biggest file in single-file packs).
        const unrestricted = await axios.post(
            `${BASE_URL}/unrestrict/link`,
            new URLSearchParams({ link: downloadedInfo.links[0] }).toString(),
            { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
        );
        if (!unrestricted.data || !unrestricted.data.download) {
            console.error(`[real-debrid] unrestrict returned no download url`);
            return null;
        }
        return {
            url: unrestricted.data.download,
            filename: downloadedInfo.filename,
            filesize: downloadedInfo.bytes
        };
    } catch (err: any) {
        const status = err.response?.status;
        const body = typeof err.response?.data === 'object' ? JSON.stringify(err.response.data) : err.response?.data;
        console.error(`[real-debrid] error status=${status} body=${body}: ${err.message || err}`);
        if (torrentId) await deleteTorrent(apikey, torrentId);
        return null;
    }
}
