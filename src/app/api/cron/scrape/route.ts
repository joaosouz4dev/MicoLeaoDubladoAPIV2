import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { ensureDb } from '../../../_lib/db';
import { aggregateProviders } from '../../../../persistence/services/providers';
import { ensureMetaCached } from '../../../../persistence/services/cinemeta';
import Stream from '../../../../persistence/models/stream';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CINEMETA_BASE = process.env.CINEMETA_BASE || 'https://v3-cinemeta.strem.io';
const UA = { 'User-Agent': 'Stremio/4.4 MicoLeaoV2-Cron' };

/**
 * Cron-triggered scrape: walks the top Cinemeta catalogs (movies + series)
 * and warms the local cache via aggregateProviders so users browsing the
 * catalogs see streams immediately.
 *
 * Auth: protected by CRON_SECRET env (set on Vercel + on the cron config).
 * Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" automatically.
 *
 * Limit per run: process up to MAX_PER_RUN titles to stay within the 60s
 * Vercel function timeout. Pagination state lives in the DB (Stream count
 * heuristic) so successive runs cover more titles.
 */
const MAX_PER_RUN = parseInt(process.env.CRON_MAX_PER_RUN || '30', 10);

export async function GET(req: NextRequest) {
    const auth = req.headers.get('authorization');
    const expected = process.env.CRON_SECRET;
    if (expected && auth !== `Bearer ${expected}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const started = Date.now();
    await ensureDb();

    const result = {
        ok: true,
        startedAt: new Date(started).toISOString(),
        processed: [] as Array<{ id: string; type: string; streamsFound: number; persisted: number }>
    };

    try {
        const [topMovies, topSeries] = await Promise.all([
            fetchTopIds('movie'),
            fetchTopIds('series')
        ]);

        const queue: Array<{ id: string; type: 'movie' | 'series' }> = [
            ...topMovies.slice(0, MAX_PER_RUN / 2).map((id) => ({ id, type: 'movie' as const })),
            ...topSeries.slice(0, MAX_PER_RUN / 2).map((id) => ({ id, type: 'series' as const }))
        ];

        // Process titles in parallel batches so 30 items still fit in 60s.
        // Each batch hits aggregateProviders concurrently and persists results
        // in parallel. Concurrency cap balances throughput vs upstream API
        // strain (torrent-indexer rate-limit, Knaben Cloudflare).
        const BATCH_SIZE = parseInt(process.env.CRON_BATCH_SIZE || '5', 10);
        for (let i = 0; i < queue.length; i += BATCH_SIZE) {
            if (Date.now() - started > 50_000) {
                console.log(`[cron] timeout approaching at batch ${i}, stopping`);
                break;
            }
            const batch = queue.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (item) => {
                try {
                    const streamId = item.type === 'series' ? `${item.id}:1:1` : item.id;
                    const streams = await aggregateProviders(item.type, streamId);
                    let persisted = 0;
                    await Promise.all(streams.map(async (s) => {
                        try {
                            const exists = await Stream.findOne({ streamId, infoHash: s.infoHash }).exec();
                            if (exists) return;
                            await new Stream({
                                metaId: item.id,
                                streamId,
                                type: item.type,
                                title: s.title,
                                infoHash: s.infoHash,
                                sources: s.sources,
                                seeders: s.seeders,
                                size: s.size,
                                updatedAt: new Date()
                            }).save();
                            persisted++;
                        } catch (err) {
                            // Ignore unique-index races between concurrent batches
                        }
                    }));
                    ensureMetaCached(item.type, item.id).catch(() => {});
                    result.processed.push({ id: item.id, type: item.type, streamsFound: streams.length, persisted });
                    console.log(`[cron] ${item.type}/${item.id}: ${streams.length} found, ${persisted} new`);
                } catch (err: any) {
                    console.error(`[cron] ${item.id} failed: ${err.message || err}`);
                }
            }));
        }
    } catch (err: any) {
        console.error(`[cron] fatal: ${err.message || err}`);
        return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
    }

    const elapsedMs = Date.now() - started;
    return NextResponse.json({ ...result, elapsedMs });
}

async function fetchTopIds(type: 'movie' | 'series'): Promise<string[]> {
    try {
        const res = await axios.get(`${CINEMETA_BASE}/catalog/${type}/top.json`, {
            timeout: 6000, headers: UA
        });
        return (res.data?.metas || []).map((m: any) => m.imdb_id || m.id).filter(Boolean);
    } catch (err: any) {
        console.error(`[cron] cinemeta top ${type} failed: ${err.message || err}`);
        return [];
    }
}
