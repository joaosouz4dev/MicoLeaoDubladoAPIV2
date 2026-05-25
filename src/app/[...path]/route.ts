import { NextRequest, NextResponse } from 'next/server';
import { ensureDb } from '../_lib/db';
import StreamController from '../../persistence/controllers/stream-controller';
import { handleCatalog } from '../../persistence/controllers/catalog-controller';
import MetaDAO from '../../persistence/controllers/meta-dao';
import disassembleMovie from '../../persistence/controllers/movie-assembler';
import disassembleSeries from '../../persistence/controllers/series-assembler';
import StreamDAO from '../../persistence/controllers/stream-dao';
import { parseDebridConfig, resolveDebridStreams, DebridConfig } from '../../persistence/services/debrid';
import { ContentType } from '../../persistence/models/stremio';
import manifest from '../../persistence/models/stub/manifest.json';
import MovieDTO from '../../persistence/models/transfer-objects/movie';
import SeriesDTO from '../../persistence/models/transfer-objects/series';
import { IStream } from '../../persistence/models/stream';

export const dynamic = 'force-dynamic';

/**
 * Single catch-all route that dispatches Stremio Addon SDK URLs.
 *
 * Stremio expects these shapes — optionally prefixed by a config segment:
 *   /manifest.json
 *   /catalog/<type>/<id>.json
 *   /catalog/<type>/<id>/<extra>.json     (e.g. genre=Action&skip=100)
 *   /stream/<type>/<id>.json
 *   /meta/<type>/<id>.json
 *   /<config>/manifest.json               (config = "<provider>-<apikey>")
 *   /<config>/stream/<type>/<id>.json
 *
 * A single catch-all is more forgiving than nested optional dynamic segments,
 * which interact awkwardly with Stremio's trailing-".json" convention.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
    const { path } = await ctx.params;
    const segments = path.map((s) => decodeURIComponent(s));

    console.log(`[router] GET /${segments.join('/')}`);

    const debridConfig = sniffDebridConfig(segments);
    const route = debridConfig ? segments.slice(1) : segments;

    try {
        if (route.length === 1 && stripJson(route[0]) === 'manifest') {
            return NextResponse.json(manifest);
        }

        const resource = route[0];
        if (resource === 'catalog') return await handleCatalogRoute(route);
        if (resource === 'stream')  return await handleStreamRoute(route, debridConfig);
        if (resource === 'meta')    return await handleMetaRoute(route);

        return NextResponse.json({ error: 'Not found', path: route }, { status: 404 });
    } catch (err: any) {
        console.error(`[router] error on /${segments.join('/')}: ${err?.stack || err}`);
        return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
    }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
    const { path } = await ctx.params;
    const segments = path.map((s) => decodeURIComponent(s));
    console.log(`[router] POST /${segments.join('/')}`);

    try {
        await ensureDb();
        const body = await req.json();
        if (segments[0] === 'movie') {
            const { meta, streams } = disassembleMovie(body as MovieDTO);
            await new MetaDAO().addIfAbsent(meta);
            const dao = new StreamDAO();
            await Promise.all(streams.map((s: IStream) => dao.addIfAbsent(s)));
            return new NextResponse(null, { status: 200 });
        }
        if (segments[0] === 'series') {
            const { meta, streams } = disassembleSeries(body as SeriesDTO);
            await new MetaDAO().addIfAbsent(meta);
            const dao = new StreamDAO();
            await Promise.all(streams.map((s: IStream) => dao.addIfAbsent(s)));
            return new NextResponse(null, { status: 200 });
        }
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    } catch (err: any) {
        console.error(`[router] POST error: ${err?.stack || err}`);
        return NextResponse.json({ error: String(err?.message || err) }, { status: 400 });
    }
}

function stripJson(s: string): string {
    return s.endsWith('.json') ? s.slice(0, -5) : s;
}

/**
 * If the first segment looks like "<provider>-<apikey>" (and not a known
 * resource name), treat it as a Debrid config prefix.
 */
function sniffDebridConfig(segments: string[]): DebridConfig | null {
    if (segments.length === 0) return null;
    const first = segments[0];
    if (['manifest.json', 'catalog', 'stream', 'meta', 'movie', 'series', 'configure'].includes(first)) return null;
    return parseDebridConfig(first);
}

async function handleCatalogRoute(route: string[]) {
    if (route.length < 3) return NextResponse.json({ metas: [] });
    await ensureDb();
    const type = route[1] as ContentType;
    const id = stripJson(route[2]);
    const extraStr = route.length > 3 ? stripJson(route.slice(3).join('/')) : stripJson(route[2]) === route[2] ? '' : '';
    const extra = parseExtra(route.length > 3 ? stripJson(route.slice(3).join('/')) : '');
    const result = await handleCatalog({ type, id, extra });
    return NextResponse.json(result);
}

async function handleStreamRoute(route: string[], debridConfig: DebridConfig | null) {
    if (route.length < 3) return NextResponse.json({ streams: [] });
    await ensureDb();
    const type = route[1] as ContentType;
    const cleanId = stripJson(route[2]);
    const idToUse = cleanId.includes(':') ? cleanId : stripJson(route.slice(2).join(':'));

    const streams = await new StreamController().getByStreamId(idToUse, type);

    if (debridConfig) {
        try {
            const debridStreams = await resolveDebridStreams(streams, debridConfig);
            if (debridStreams.length > 0) return NextResponse.json({ streams: debridStreams });
        } catch (err) {
            console.error(`[stream] debrid failed: ${err}`);
        }
    }
    // Strip Mongoose-specific keys; Stremio only needs the well-known fields.
    const trimmed = streams.map((s: any) => ({
        name: s.name,
        title: s.title,
        infoHash: s.infoHash,
        fileIdx: s.fileIdx,
        sources: s.sources,
        behaviorHints: s.behaviorHints
    }));
    return NextResponse.json({ streams: trimmed });
}

async function handleMetaRoute(route: string[]) {
    if (route.length < 3) return NextResponse.json({ meta: null }, { status: 404 });
    await ensureDb();
    const id = stripJson(route[2]);
    const meta = await new MetaDAO().getById(id);
    if (!meta) return NextResponse.json({ meta: null }, { status: 404 });
    return NextResponse.json({ meta });
}

function parseExtra(extraStr: string): { search: string; genre: string; skip: number } {
    const out = { search: '', genre: '', skip: 0 };
    if (!extraStr) return out;
    for (const pair of extraStr.split('&')) {
        const [k, v] = pair.split('=').map((p) => p ? decodeURIComponent(p) : '');
        if (k === 'search') out.search = v;
        else if (k === 'genre') out.genre = v;
        else if (k === 'skip') out.skip = parseInt(v || '0', 10) || 0;
    }
    return out;
}
