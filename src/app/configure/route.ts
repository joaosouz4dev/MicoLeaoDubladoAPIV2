import { NextRequest } from 'next/server';
import { renderConfigurePage } from '../../configure-page';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    const host = req.headers.get('host') || 'localhost:3000';
    const proto = req.headers.get('x-forwarded-proto') || (host.startsWith('localhost') ? 'http' : 'https');
    const baseUrl = `${proto}://${host}`;
    return new Response(renderConfigurePage(baseUrl), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}
