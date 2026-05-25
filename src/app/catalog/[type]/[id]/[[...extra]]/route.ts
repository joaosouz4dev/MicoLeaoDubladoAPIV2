import { NextRequest, NextResponse } from 'next/server';
import { ensureDb } from '../../../../_lib/db';
import { handleCatalog } from '../../../../../persistence/controllers/catalog-controller';
import { ContentType } from '../../../../../persistence/models/stremio';

export const dynamic = 'force-dynamic';

/**
 * Stremio catalog endpoint.
 *
 *   /catalog/movie/<catalogId>.json
 *   /catalog/movie/<catalogId>/search=foo&skip=100.json
 */
export async function GET(
    _req: NextRequest,
    ctx: { params: Promise<{ type: string; id: string; extra?: string[] }> }
) {
    const { type, id, extra } = await ctx.params;
    try {
        await ensureDb();
        const cleanedId = id.replace(/\.json$/, '');
        const extraStr = (extra || []).join('/').replace(/\.json$/, '');
        const extraParams = parseExtra(extraStr);
        const result = await handleCatalog({
            type: type as ContentType,
            id: cleanedId,
            extra: extraParams
        });
        return NextResponse.json(result);
    } catch (err) {
        console.error(`Catalog handler error (${type}/${id}): ${err}`);
        return NextResponse.json({ metas: [] });
    }
}

function parseExtra(extraStr: string): { search: string; genre: string; skip: number } {
    const out = { search: '', genre: '', skip: 0 };
    if (!extraStr) return out;
    const pairs = extraStr.split('&');
    for (const pair of pairs) {
        const [k, v] = pair.split('=').map(decodeURIComponent);
        if (k === 'search') out.search = v || '';
        else if (k === 'genre') out.genre = v || '';
        else if (k === 'skip') out.skip = parseInt(v || '0', 10) || 0;
    }
    return out;
}
