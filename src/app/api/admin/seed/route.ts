import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { ensureDb } from '../../../_lib/db';
import { aggregateProviders } from '../../../../persistence/services/providers';
import { ensureMetaCached } from '../../../../persistence/services/cinemeta';
import Stream from '../../../../persistence/models/stream';
import { discoverPopularBR, tmdbAvailable } from '../../../../persistence/services/tmdb';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CINEMETA_BASE = process.env.CINEMETA_BASE || 'https://v3-cinemeta.strem.io';
const UA = { 'User-Agent': 'Stremio/4.4 MicoLeaoV2-Seed' };

/**
 * Admin seed endpoint — bulk-warm the cache with a curated source list.
 *
 * Unlike the /api/cron/scrape job (small, 30 titles per run, scheduled), this
 * endpoint accepts ?pages=N and walks several pages of popular BR titles in
 * one shot. It's meant to be called manually right after deploy when the
 * cache is empty, then never again — the regular cron keeps it fresh.
 *
 * Sources tried in order:
 *   1. TMDB discover BR (region=BR, language=pt-BR, popularity desc) — best
 *      signal for content Brazilian audiences actually want. Requires
 *      TMDB_API_KEY.
 *   2. Cinemeta top — global popularity, fallback when TMDB is unavailable.
 *
 * Auth: Bearer CRON_SECRET. Limits per Vercel function timeout to ~50s and
 * processes in concurrent batches.
 *
 * Query params:
 *   - ?pages=3   → walk 3 pages of each source (movies + series). Default 1.
 *   - ?type=movie|series → only seed one type. Default both.
 */
export async function GET(req: NextRequest) {
    const auth = req.headers.get('authorization');
    const expected = process.env.CRON_SECRET;
    if (!expected || auth !== `Bearer ${expected}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const pages = Math.min(parseInt(req.nextUrl.searchParams.get('pages') || '2', 10), 5);
    const onlyType = req.nextUrl.searchParams.get('type') as 'movie' | 'series' | null;

    const started = Date.now();
    await ensureDb();

    const result: any = {
        ok: true,
        pages,
        startedAt: new Date(started).toISOString(),
        processed: 0,
        persisted: 0,
        skipped: 0,
        timedOut: false
    };

    try {
        const types: Array<'movie' | 'series'> = onlyType ? [onlyType] : ['movie', 'series'];
        const queue: Array<{ id: string; type: 'movie' | 'series' }> = [];

        for (const type of types) {
            for (let page = 1; page <= pages; page++) {
                const ids = await fetchSeedIds(type, page);
                for (const id of ids) queue.push({ id, type });
            }
        }

        // Dedupe (TMDB pages may overlap with Cinemeta top)
        const seen = new Set<string>();
        const uniq = queue.filter((q) => {
            const k = `${q.type}:${q.id}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
        console.log(`[seed] queue size: ${uniq.length}`);

        const BATCH_SIZE = 5;
        for (let i = 0; i < uniq.length; i += BATCH_SIZE) {
            if (Date.now() - started > 50_000) {
                console.log(`[seed] timeout, stopping at batch ${i}/${uniq.length}`);
                result.timedOut = true;
                break;
            }
            const batch = uniq.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (item) => {
                try {
                    // Skip if we already have streams cached for this title
                    const existing = await Stream.countDocuments({ metaId: item.id }).limit(1).exec();
                    if (existing > 0) {
                        result.skipped++;
                        return;
                    }

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
                        } catch { /* unique race, ignore */ }
                    }));
                    ensureMetaCached(item.type, item.id).catch(() => {});
                    result.processed++;
                    result.persisted += persisted;
                } catch (err: any) {
                    console.error(`[seed] ${item.id} failed: ${err.message || err}`);
                }
            }));
        }
    } catch (err: any) {
        console.error(`[seed] fatal: ${err.message || err}`);
        return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
    }

    result.elapsedMs = Date.now() - started;
    return NextResponse.json(result);
}

/**
 * Fetch a page of IMDb ids to seed. Prefers TMDB (region BR) when available,
 * falls back to Cinemeta top.
 */
async function fetchSeedIds(type: 'movie' | 'series', page: number): Promise<string[]> {
    if (tmdbAvailable()) {
        const popular = await discoverPopularBR(type, page).catch(() => []);
        const ids = popular.map((m: any) => m.imdb_id || m.id).filter(Boolean);
        if (ids.length > 0) return ids;
    }
    // Cinemeta fallback (note: Cinemeta paginates via /skip=)
    try {
        const skip = (page - 1) * 100;
        const url = `${CINEMETA_BASE}/catalog/${type}/top${skip > 0 ? `/skip=${skip}.json` : '.json'}`;
        const res = await axios.get(url, { timeout: 6000, headers: UA });
        return (res.data?.metas || []).map((m: any) => m.imdb_id || m.id).filter(Boolean);
    } catch (err: any) {
        console.error(`[seed] cinemeta page ${page} ${type}: ${err.message || err}`);
        return [];
    }
}
