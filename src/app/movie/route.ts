import { NextRequest, NextResponse } from 'next/server';
import { ensureDb } from '../_lib/db';
import disassembleMovie from '../../persistence/controllers/movie-assembler';
import MetaDAO from '../../persistence/controllers/meta-dao';
import StreamDAO from '../../persistence/controllers/stream-dao';
import MovieDTO from '../../persistence/models/transfer-objects/movie';
import { IStream } from '../../persistence/models/stream';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
    try {
        await ensureDb();
        const body = (await req.json()) as MovieDTO;
        const { meta, streams } = disassembleMovie(body);
        const metaDao = new MetaDAO();
        const streamDao = new StreamDAO();
        await metaDao.addIfAbsent(meta);
        await Promise.all(streams.map((s: IStream) => streamDao.addIfAbsent(s)));
        return new NextResponse(null, { status: 200 });
    } catch (err: any) {
        console.error(`POST /movie error: ${err.message || err}`);
        return new NextResponse(null, { status: 400 });
    }
}
