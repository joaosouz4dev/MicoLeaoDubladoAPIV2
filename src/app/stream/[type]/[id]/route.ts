import { NextRequest, NextResponse } from 'next/server';
import { ensureDb } from '../../../_lib/db';
import StreamController from '../../../../persistence/controllers/stream-controller';
import { ContentType } from '../../../../persistence/models/stremio';

export const dynamic = 'force-dynamic';

/**
 * Stream endpoint — no Debrid config. Returns raw torrent streams.
 *
 *   /stream/movie/<imdbId>.json
 *   /stream/series/<imdbId:season:episode>.json
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
    const { type, id } = await ctx.params;
    const streamId = id.replace(/\.json$/, '');
    try {
        await ensureDb();
        const controller = new StreamController();
        const streams = await controller.getByStreamId(streamId);
        return NextResponse.json({ streams });
    } catch (err) {
        console.error(`Stream handler error (${type}/${streamId}): ${err}`);
        return NextResponse.json({ streams: [] });
    }
}
