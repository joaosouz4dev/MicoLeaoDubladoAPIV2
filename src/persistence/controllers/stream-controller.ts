import Stream, { IStream } from '../models/stream';
import StreamDao from './stream-dao';
import { fetchSeeders } from '../services/tracker-scraper';
import { aggregateProviders, NormalizedStream } from '../services/providers';
import { ensureMetaCached } from '../services/cinemeta';
import { ContentType } from '../models/stremio';

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_THRESHOLD_MS = parseInt(process.env.SEEDERS_REFRESH_MS || `${ONE_MONTH_MS}`, 10);

/**
 * Upper layer over StreamDao.
 *
 * Strategy: DB-first, scrape-on-miss, write-back.
 *   1. Hit the local cache. If we have streams for this id, return them and
 *      refresh stale seeder counts in the background.
 *   2. On cache miss, ask the aggregator (torrent-indexer + Torrentio) in
 *      parallel. Persist the union in the DB so the next request is fast.
 *   3. Always best-effort: any failure preserves cached data and lets the
 *      next request try again.
 */
export default class StreamController {
    private dao: StreamDao;

    constructor(dao?: StreamDao) {
        this.dao = dao || new StreamDao();
    }

    async getByStreamId(streamId: string, type?: ContentType): Promise<Partial<IStream>[]> {
        const cached = await this.dao.getByStreamId(streamId);
        if (cached.length > 0) {
            await Promise.all(cached.map((s) => this.refreshIfStale(s)));
            return cached.map((s) => this.formatTitle(s));
        }

        const inferredType: 'movie' | 'series' =
            type === 'series' || streamId.includes(':') ? 'series' : 'movie';

        const aggregated = await aggregateProviders(inferredType, streamId);
        if (aggregated.length === 0) return [];

        // Persist in the background — don't slow down the response
        this.persist(aggregated, streamId, inferredType).catch((err) =>
            console.error(`[stream-controller] persist failed: ${err}`)
        );

        // Fire Cinemeta lookup so the catalog also gets populated
        const imdbId = streamId.split(':')[0];
        ensureMetaCached(inferredType, imdbId).catch((err) =>
            console.error(`[stream-controller] meta cache failed: ${err}`)
        );

        return aggregated.map((s) => this.formatNormalized(s, streamId, inferredType));
    }

    private async persist(streams: NormalizedStream[], streamId: string, type: 'movie' | 'series'): Promise<void> {
        const [metaId, seasonStr, episodeStr] = streamId.split(':');
        const season = seasonStr ? parseInt(seasonStr, 10) : undefined;
        const episode = episodeStr ? parseInt(episodeStr, 10) : undefined;
        await Promise.all(streams.map(async (s) => {
            try {
                const exists = await Stream.findOne({ metaId, infoHash: s.infoHash }).exec();
                if (exists) return;
                await new Stream({
                    metaId,
                    streamId,
                    type,
                    title: s.title,
                    infoHash: s.infoHash,
                    sources: s.sources,
                    seeders: s.seeders,
                    size: s.size,
                    season,
                    episode,
                    updatedAt: new Date()
                }).save();
            } catch (err) {
                console.error(`[stream-controller] persist ${s.infoHash}: ${err}`);
            }
        }));
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
            console.error(`[stream-controller] refresh persist: ${err}`);
        }
    }

    private formatTitle(stream: IStream): IStream {
        const base = stream.title || '';
        const tag = `👥 ${stream.seeders ?? 0}`;
        if (base.includes('👥')) return stream;
        stream.title = base ? `${base}\n${tag}` : tag;
        return stream;
    }

    private formatNormalized(s: NormalizedStream, streamId: string, type: 'movie' | 'series'): Partial<IStream> {
        const [metaId] = streamId.split(':');
        const title = `${s.title}\n👥 ${s.seeders} · ${s.provider}`;
        return {
            metaId,
            streamId,
            type,
            title,
            infoHash: s.infoHash,
            sources: s.sources,
            seeders: s.seeders,
            size: s.size
        };
    }
}
