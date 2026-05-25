import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import axios from 'axios';
import { connect } from '../../config';
import Stream from '../../persistence/models/stream';
import Meta from '../../persistence/models/meta';
import manifest from '../../persistence/models/stub/manifest.json';

export const dynamic = 'force-dynamic';

/**
 * Health/diagnostic endpoint.
 *
 * Reports per-subsystem status with timings so we can tell at a glance whether
 * the DB is reachable, env vars are wired, and the upstream Torrentio/Cinemeta
 * services are responding. Designed to be safe to expose publicly: no secrets
 * are leaked — only counts and reachability flags.
 */
export async function GET(_req: NextRequest) {
    const result: any = {
        ok: true,
        timestamp: new Date().toISOString(),
        version: manifest.version,
        addon: { id: manifest.id, name: manifest.name },
        checks: {}
    };

    // 1. Env vars (presence only, never values)
    result.checks.env = {
        MONGODB_URI: !!process.env.MONGODB_URI,
        DB_HOST: !!process.env.DB_HOST,
        SEEDERS_REFRESH_MS: process.env.SEEDERS_REFRESH_MS || 'default (30d)',
        VERCEL_REGION: process.env.VERCEL_REGION || 'unknown',
        NODE_ENV: process.env.NODE_ENV
    };

    // 2. MongoDB
    const dbStart = Date.now();
    try {
        await connect();
        const state = mongoose.connection.readyState;
        const stateLabel = ['disconnected', 'connected', 'connecting', 'disconnecting'][state] || `unknown(${state})`;
        const [streamCount, metaCount] = await Promise.all([
            Stream.estimatedDocumentCount().exec(),
            Meta.estimatedDocumentCount().exec()
        ]);
        result.checks.mongodb = {
            ok: state === 1,
            state: stateLabel,
            host: mongoose.connection.host || null,
            database: mongoose.connection.name || null,
            counts: { streams: streamCount, metas: metaCount },
            latencyMs: Date.now() - dbStart
        };
    } catch (err: any) {
        result.ok = false;
        result.checks.mongodb = {
            ok: false,
            error: String(err?.message || err),
            latencyMs: Date.now() - dbStart
        };
    }

    // 3. Upstream addon mirrors — Torrentio blocks Vercel IPs (403), so we
    //    also probe KnightCrawler / MediaFusion which we use as fallbacks.
    const upstreams = [
        { name: 'torrentio', url: 'https://torrentio.strem.fun/manifest.json' },
        { name: 'knightcrawler', url: 'https://knightcrawler.elfhosted.com/manifest.json' },
        { name: 'mediafusion', url: 'https://mediafusion.elfhosted.com/manifest.json' }
    ];
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Stremio/4.4';
    result.checks.upstreams = {};
    for (const u of upstreams) {
        const start = Date.now();
        try {
            const r = await axios.get(u.url, { timeout: 5000, headers: { 'User-Agent': ua } });
            result.checks.upstreams[u.name] = { ok: r.status === 200, latencyMs: Date.now() - start };
        } catch (err: any) {
            result.checks.upstreams[u.name] = {
                ok: false,
                status: err.response?.status,
                error: String(err?.message || err),
                latencyMs: Date.now() - start
            };
        }
    }

    // 4. Cinemeta reachability
    const cinemetaStart = Date.now();
    try {
        const r = await axios.get('https://v3-cinemeta.strem.io/manifest.json', { timeout: 5000 });
        result.checks.cinemeta = { ok: r.status === 200, latencyMs: Date.now() - cinemetaStart };
    } catch (err: any) {
        result.checks.cinemeta = {
            ok: false,
            error: String(err?.message || err),
            latencyMs: Date.now() - cinemetaStart
        };
    }

    // 5. Manifest stub sanity
    result.checks.manifest = {
        ok: !!manifest.id && !!manifest.catalogs?.length,
        catalogs: manifest.catalogs.map((c: any) => ({ id: c.id, name: c.name })),
        resources: manifest.resources
    };

    result.ok = result.ok
        && result.checks.mongodb?.ok !== false
        && result.checks.manifest.ok;

    return NextResponse.json(result, {
        status: result.ok ? 200 : 503,
        headers: { 'Cache-Control': 'no-store' }
    });
}
