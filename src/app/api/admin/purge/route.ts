import { NextRequest, NextResponse } from 'next/server';
import { ensureDb } from '../../../_lib/db';
import Stream from '../../../../persistence/models/stream';
import SearchCache from '../../../../persistence/models/search-cache';
import DebridCache from '../../../../persistence/models/debrid-cache';

export const dynamic = 'force-dynamic';

/**
 * Admin endpoint: purge cache entries for a given Stremio id (or all).
 *
 * Used to recover from buggy cache writes — e.g. when a series episode lookup
 * stored a season-pack with the wrong streamId, leaving subsequent requests
 * for that episode stuck returning irrelevant rows.
 *
 * Auth: Bearer CRON_SECRET. Without it, request is rejected so this can't be
 * weaponized against the deployment.
 *
 * Query params:
 *   - ?metaId=tt1234   → purge by IMDb id (matches series + all episodes)
 *   - ?streamId=tt1234:2:5 → purge that specific stream id
 *   - ?all=1           → purge everything (use with care; the cron will
 *                        repopulate the trending titles within 6h)
 */
export async function POST(req: NextRequest) {
    const auth = req.headers.get('authorization');
    const expected = process.env.CRON_SECRET;
    if (!expected || auth !== `Bearer ${expected}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = req.nextUrl;
    const metaId = searchParams.get('metaId');
    const streamId = searchParams.get('streamId');
    const all = searchParams.get('all') === '1';

    await ensureDb();

    const result: any = { metaId, streamId, all };
    try {
        if (all) {
            const r1 = await Stream.deleteMany({}).exec();
            const r2 = await SearchCache.deleteMany({}).exec();
            const r3 = await DebridCache.deleteMany({}).exec();
            result.deleted = { streams: r1.deletedCount, searchCache: r2.deletedCount, debridCache: r3.deletedCount };
        } else if (streamId) {
            const r1 = await Stream.deleteMany({ streamId }).exec();
            const r2 = await SearchCache.deleteMany({ streamId }).exec();
            result.deleted = { streams: r1.deletedCount, searchCache: r2.deletedCount };
        } else if (metaId) {
            const r1 = await Stream.deleteMany({ metaId }).exec();
            const r2 = await SearchCache.deleteMany({ streamId: { $regex: `^${escapeRegex(metaId)}` } }).exec();
            result.deleted = { streams: r1.deletedCount, searchCache: r2.deletedCount };
        } else {
            return NextResponse.json({ error: 'Specify metaId, streamId, or all=1' }, { status: 400 });
        }
        return NextResponse.json({ ok: true, ...result });
    } catch (err: any) {
        return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
    }
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
