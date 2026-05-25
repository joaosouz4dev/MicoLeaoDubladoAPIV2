import { NextRequest, NextResponse } from 'next/server';
import { ensureDb } from '../../../../_lib/db';
import StreamController from '../../../../../persistence/controllers/stream-controller';
import { parseDebridConfig, resolveDebridStreams } from '../../../../../persistence/services/debrid';

export const dynamic = 'force-dynamic';

/**
 * Stream endpoint with Debrid config in the URL prefix.
 *
 *   /<provider>-<apikey>/stream/movie/<imdbId>.json
 *   /<provider>-<apikey>/stream/series/<imdbId:season:episode>.json
 *
 * On Debrid failure the raw torrent streams are returned as a fallback so the user
 * still has something playable.
 */
export async function GET(
    _req: NextRequest,
    ctx: { params: Promise<{ config: string; type: string; id: string }> }
) {
    const { config, type, id } = await ctx.params;
    const streamId = id.replace(/\.json$/, '');
    const debridConfig = parseDebridConfig(decodeURIComponent(config));

    try {
        await ensureDb();
        const controller = new StreamController();
        const streams = await controller.getByStreamId(streamId);

        if (debridConfig) {
            try {
                const debridStreams = await resolveDebridStreams(streams, debridConfig);
                if (debridStreams.length > 0) return NextResponse.json({ streams: debridStreams });
            } catch (debridErr) {
                console.error(`Debrid resolution failed (${type}/${streamId}): ${debridErr}`);
            }
        }
        return NextResponse.json({ streams });
    } catch (err) {
        console.error(`Stream handler error (${type}/${streamId}): ${err}`);
        return NextResponse.json({ streams: [] });
    }
}
