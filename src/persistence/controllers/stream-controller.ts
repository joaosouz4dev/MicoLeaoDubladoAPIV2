import Stream, { IStream } from '../models/stream';
import StreamDao from './stream-dao';
import { fetchSeeders } from '../services/tracker-scraper';
import { scrapeAndProxyTorrentio } from '../services/torrentio-proxy';
import { ensureMetaCached } from '../services/cinemeta';
import { ContentType } from '../models/stremio';

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_THRESHOLD_MS = parseInt(process.env.SEEDERS_REFRESH_MS || `${ONE_MONTH_MS}`, 10);

/**
 * Upper layer over StreamDao.
 *
 * Responsibilities:
 *  - Fetch streams from the DAO
 *  - Fall back to Torrentio proxy when the local cache is empty, filtering for PT-BR
 *  - Refresh stale seeder counts on demand (tracker scrape) past the configured threshold
 *  - Format stream titles with seeder counts before returning them upstream
 *
 * The seeders refresh and Torrentio fetch are best-effort: failures preserve cached
 * data and let the next request try again.
 */
export default class StreamController {
    private dao: StreamDao;

    constructor(dao?: StreamDao) {
        this.dao = dao || new StreamDao();
    }

    /**
     * Return streams for a Stremio streamId.
     *
     * Falls back to Torrentio (filtered for PT-BR) when the local cache has nothing,
     * persisting the discovered streams in the background to grow our cache organically.
     */
    async getByStreamId(streamId: string, type?: ContentType): Promise<Partial<IStream>[]> {
        const cached = await this.dao.getByStreamId(streamId);
        if (cached.length > 0) {
            await Promise.all(cached.map((s) => this.refreshIfStale(s)));
            return cached.map((s) => this.formatTitle(s));
        }

        // Empty cache — try Torrentio as a fallback and persist what we find.
        const inferredType: 'movie' | 'series' = type === 'series' || streamId.includes(':') ? 'series' : 'movie';
        const fromTorrentio = await scrapeAndProxyTorrentio(inferredType, streamId);
        if (fromTorrentio.length === 0) return [];

        // Fire-and-forget Cinemeta lookup so the meta lands in our catalog.
        const imdbId = streamId.split(':')[0];
        ensureMetaCached(inferredType, imdbId).catch((err) =>
            console.error(`[stream-controller] meta cache failed: ${err}`)
        );

        return fromTorrentio.map((s) => this.formatTitlePlain(s));
    }

    private async refreshIfStale(stream: IStream): Promise<void> {
        const updatedAt = stream.updatedAt ? stream.updatedAt.getTime() : 0;
        if (Date.now() - updatedAt < REFRESH_THRESHOLD_MS) return;

        const liveSeeders = await fetchSeeders(stream.infoHash, stream.sources || []);
        if (liveSeeders === null) return;

        stream.seeders = liveSeeders;
        stream.updatedAt = new Date();
        try {
            await Stream.updateOne(
                { _id: stream._id },
                { $set: { seeders: liveSeeders, updatedAt: stream.updatedAt } }
            ).exec();
        } catch (err) {
            console.error(`Failed to persist refreshed seeders for ${stream.infoHash}: ${err}`);
        }
    }

    private formatTitle(stream: IStream): IStream {
        const base = stream.title || '';
        const tag = `👥 ${stream.seeders ?? 0}`;
        if (base.includes('👥')) return stream;
        stream.title = base ? `${base}\n${tag}` : tag;
        return stream;
    }

    private formatTitlePlain(stream: Partial<IStream>): Partial<IStream> {
        const base = stream.title || '';
        const tag = `👥 ${stream.seeders ?? 0}`;
        if (base.includes('👥')) return stream;
        return { ...stream, title: base ? `${base}\n${tag}` : tag };
    }
}
