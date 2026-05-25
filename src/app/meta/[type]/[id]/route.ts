import { NextRequest, NextResponse } from 'next/server';
import { ensureDb } from '../../../_lib/db';
import MetaDAO from '../../../../persistence/controllers/meta-dao';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
    const { id } = await ctx.params;
    const cleanId = id.replace(/\.json$/, '');
    try {
        await ensureDb();
        const meta = await new MetaDAO().getById(cleanId);
        if (!meta) return NextResponse.json({ meta: null }, { status: 404 });
        return NextResponse.json({ meta });
    } catch (err) {
        console.error(`Meta handler error (${cleanId}): ${err}`);
        return NextResponse.json({ meta: null }, { status: 500 });
    }
}
