/**
 * Tracker scraping service for fetching live seeders counts.
 *
 * Uses the BitTorrent tracker scrape protocol. Tries each tracker URL (HTTP/HTTPS/UDP)
 * from the magnet's announce list until one responds, with a short per-tracker timeout.
 *
 * Falls back gracefully: returns null when no tracker responds — caller should keep
 * the cached value rather than treating absence of data as zero seeders.
 */
import { URL } from 'url';
import http from 'http';
import https from 'https';
import dgram from 'dgram';
import crypto from 'crypto';

const PER_TRACKER_TIMEOUT_MS = 4000;
const MAX_TRACKERS_TO_TRY = 6;

export interface ScrapeResult {
    seeders: number;
    leechers?: number;
    completed?: number;
}

/**
 * Try to scrape a single tracker URL.
 * Supports udp://, http://, https:// schemes.
 */
async function scrapeTracker(trackerUrl: string, infoHashHex: string): Promise<ScrapeResult | null> {
    try {
        const parsed = new URL(trackerUrl);
        if (parsed.protocol === 'udp:') {
            return await scrapeUdp(parsed, infoHashHex);
        } else if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return await scrapeHttp(parsed, infoHashHex);
        }
    } catch {
        return null;
    }
    return null;
}

async function scrapeHttp(url: URL, infoHashHex: string): Promise<ScrapeResult | null> {
    // Convert "announce" path to "scrape" path per BEP 48
    if (!url.pathname.includes('announce')) return null;
    const scrapePath = url.pathname.replace('announce', 'scrape');
    const infoHashBytes = Buffer.from(infoHashHex, 'hex');
    const escaped = encodeURIComponent(infoHashBytes.toString('binary'));
    const fullUrl = `${url.protocol}//${url.host}${scrapePath}?info_hash=${escaped}`;

    return new Promise((resolve) => {
        const client = url.protocol === 'https:' ? https : http;
        const req = client.get(fullUrl, { timeout: PER_TRACKER_TIMEOUT_MS }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                try {
                    const body = Buffer.concat(chunks);
                    const parsed = parseBencodeScrape(body, infoHashBytes);
                    resolve(parsed);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

/**
 * Minimal bencode parser scoped to the scrape response shape:
 * d5:filesd20:<infohash>d8:completei<N>e10:downloadedi<N>e10:incompletei<N>eeee
 */
function parseBencodeScrape(buf: Buffer, infoHashBytes: Buffer): ScrapeResult | null {
    const idx = buf.indexOf(infoHashBytes);
    if (idx === -1) return null;
    const rest = buf.subarray(idx + 20).toString('binary');
    const completeMatch = /8:completei(-?\d+)e/.exec(rest);
    const incompleteMatch = /10:incompletei(-?\d+)e/.exec(rest);
    const downloadedMatch = /10:downloadedi(-?\d+)e/.exec(rest);
    if (!completeMatch) return null;
    return {
        seeders: parseInt(completeMatch[1], 10),
        leechers: incompleteMatch ? parseInt(incompleteMatch[1], 10) : undefined,
        completed: downloadedMatch ? parseInt(downloadedMatch[1], 10) : undefined
    };
}

async function scrapeUdp(url: URL, infoHashHex: string): Promise<ScrapeResult | null> {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        let settled = false;
        const finish = (result: ScrapeResult | null) => {
            if (settled) return;
            settled = true;
            try { socket.close(); } catch { /* noop */ }
            resolve(result);
        };
        const timeout = setTimeout(() => finish(null), PER_TRACKER_TIMEOUT_MS);

        // Step 1: connect request
        const transactionId = crypto.randomBytes(4);
        const connectReq = Buffer.alloc(16);
        connectReq.writeUInt32BE(0x417, 0);
        connectReq.writeUInt32BE(0x27101980, 4);
        connectReq.writeUInt32BE(0, 8);
        transactionId.copy(connectReq, 12);

        socket.on('error', () => { clearTimeout(timeout); finish(null); });
        socket.on('message', (msg) => {
            try {
                if (msg.length >= 16 && msg.readUInt32BE(0) === 0) {
                    // connect response
                    const connId = msg.subarray(8, 16);
                    const scrapeTxn = crypto.randomBytes(4);
                    const ih = Buffer.from(infoHashHex, 'hex');
                    const scrapeReq = Buffer.concat([
                        connId,
                        Buffer.from([0, 0, 0, 2]),
                        scrapeTxn,
                        ih
                    ]);
                    socket.send(scrapeReq, parseInt(url.port || '80', 10), url.hostname, (err) => {
                        if (err) { clearTimeout(timeout); finish(null); }
                    });
                } else if (msg.length >= 20 && msg.readUInt32BE(0) === 2) {
                    // scrape response: action(4) txn(4) seeders(4) completed(4) leechers(4)
                    const seeders = msg.readUInt32BE(8);
                    const completed = msg.readUInt32BE(12);
                    const leechers = msg.readUInt32BE(16);
                    clearTimeout(timeout);
                    finish({ seeders, leechers, completed });
                }
            } catch {
                clearTimeout(timeout);
                finish(null);
            }
        });

        const port = parseInt(url.port || '80', 10);
        socket.send(connectReq, port, url.hostname, (err) => {
            if (err) { clearTimeout(timeout); finish(null); }
        });
    });
}

/**
 * Fetch live seeders for an infoHash by scraping the provided trackers.
 * Returns the highest seeder count seen across trackers, or null if no tracker responded.
 *
 * @param infoHashHex  40-char hex info hash
 * @param trackers     announce URLs from the magnet's sources
 */
export async function fetchSeeders(infoHashHex: string, trackers: string[]): Promise<number | null> {
    const candidates = trackers
        .map((s) => s.startsWith('tracker:') ? s.slice('tracker:'.length) : s)
        .filter((s) => /^(udp|http|https):\/\//.test(s))
        .slice(0, MAX_TRACKERS_TO_TRY);
    if (candidates.length === 0) return null;

    const results = await Promise.all(
        candidates.map((t) => scrapeTracker(t, infoHashHex).catch(() => null))
    );
    const seederCounts = results
        .filter((r): r is ScrapeResult => r !== null)
        .map((r) => r.seeders);
    if (seederCounts.length === 0) return null;
    return Math.max(...seederCounts);
}
