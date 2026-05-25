import { NextResponse } from 'next/server';
import manifest from '../../../persistence/models/stub/manifest.json';

export const dynamic = 'force-dynamic';

/**
 * Per-user manifest. The [config] segment carries the Debrid provider/apikey but the
 * manifest itself is identical — Stremio uses the URL prefix to route subsequent
 * stream requests back through the same /[config] path so the config travels with them.
 */
export async function GET() {
    return NextResponse.json(manifest);
}
