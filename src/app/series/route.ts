import { NextRequest, NextResponse } from 'next/server';
import { ensureDb } from '../_lib/db';
import disassembleSeries from '../../persistence/controllers/series-assembler';
import MetaDAO from '../../persistence/controllers/meta-dao';
import StreamDAO from '../../persistence/controllers/stream-dao';
import SeriesDTO from '../../persistence/models/transfer-objects/series';
import { IStream } from '../../persistence/models/stream';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
    try {
        await ensureDb();
        const body = (await req.json()) as SeriesDTO;
        const { meta, streams } = disassembleSeries(body);
        const metaDao = new MetaDAO();
        const streamDao = new StreamDAO();
        await metaDao.addIfAbsent(meta);
        await Promise.all(streams.map((s: IStream) => streamDao.addIfAbsent(s)));
        return new NextResponse(null, { status: 200 });
    } catch (err: any) {
        console.error(`POST /series error: ${err.message || err}`);
        return new NextResponse(null, { status: 400 });
    }
}
