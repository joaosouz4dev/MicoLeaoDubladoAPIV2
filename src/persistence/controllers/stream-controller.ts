import Stream, { IStream } from '../models/stream';
import StreamDao from './stream-dao';
import { fetchSeeders } from '../services/tracker-scraper';

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_THRESHOLD_MS = parseInt(process.env.SEEDERS_REFRESH_MS || `${ONE_MONTH_MS}`, 10);

/**
 * Upper layer over StreamDao.
 *
 * Responsibilities:
 *  - Fetch streams from the DAO
 *  - Refresh stale seeder counts on demand (tracker scrape) past the configured threshold
 *  - Format stream titles with seeder counts before returning them upstream
 *
 * The seeders refresh is best-effort: if the tracker scrape fails or times out, the
 * cached value is preserved and `updatedAt` is left as-is so a future request will
 * try again.
 */
export default class StreamController {
    private dao: StreamDao;

    constructor(dao?: StreamDao) {
        this.dao = dao || new StreamDao();
    }

    /**
     * Return streams for a Stremio streamId, with seeders refreshed when stale and
     * titles formatted with seeder counts.
     */
    async getByStreamId(streamId: string): Promise<IStream[]> {
        const streams = await this.dao.getByStreamId(streamId);
        await Promise.all(streams.map((s) => this.refreshIfStale(s)));
        return streams.map((s) => this.formatTitle(s));
    }

    /**
     * Refresh seeders for a stream if `updatedAt` is older than the threshold.
     * Mutates the in-memory document and persists via $set.
     */
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

    /**
     * Append a seeders count tag to the stream title so it shows up in Stremio's UI.
     * Idempotent: skips if the tag is already present.
     */
    private formatTitle(stream: IStream): IStream {
        const baseTitle = stream.title || '';
        const tag = `👥 ${stream.seeders ?? 0}`;
        if (baseTitle.includes('👥')) return stream;
        stream.title = baseTitle ? `${baseTitle}\n${tag}` : tag;
        return stream;
    }
}
