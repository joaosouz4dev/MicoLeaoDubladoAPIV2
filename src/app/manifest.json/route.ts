import { manifest } from '../../persistence/models/stub/manifest';

export const dynamic = 'force-dynamic';

/**
 * Manifest is static metadata about the addon — served from the TS literal
 * directly so it always reflects the deployed code without a DB round-trip,
 * and so JSON bundling can't mangle UTF-8 (had a bug where emojis came out
 * as Latin-1 bytes, causing Stremio to silently drop catalogs).
 *
 * We hand-build the Response with an explicit `charset=utf-8` Content-Type
 * for the same reason — `NextResponse.json` omits the charset on some
 * Vercel runtimes.
 */
export async function GET() {
    return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=300'
        }
    });
}
