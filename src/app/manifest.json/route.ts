import { NextResponse } from 'next/server';
import { ensureDb } from '../_lib/db';
import ManifestDAO from '../../persistence/controllers/manifest-dao';
import defaultManifest from '../../persistence/models/stub/manifest.json';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        await ensureDb();
        const manifest = await new ManifestDAO().get();
        return NextResponse.json(manifest.toObject ? manifest.toObject() : manifest);
    } catch (err) {
        console.error(`Manifest fallback: ${err}`);
        return NextResponse.json(defaultManifest);
    }
}
