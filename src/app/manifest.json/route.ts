import { NextResponse } from 'next/server';
import manifest from '../../persistence/models/stub/manifest.json';

export const dynamic = 'force-dynamic';

/**
 * Manifest is static metadata about the addon — served from the JSON stub directly
 * so it always reflects the deployed code without needing a DB round-trip.
 */
export async function GET() {
    return NextResponse.json(manifest);
}
