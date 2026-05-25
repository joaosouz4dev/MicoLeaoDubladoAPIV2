import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import axios from 'axios';
import { connect } from '../../config';
import Stream from '../../persistence/models/stream';
import Meta from '../../persistence/models/meta';
import manifest from '../../persistence/models/stub/manifest.json';
import { getBreakerStates } from '../../persistence/services/providers/circuit-breaker';
import { listStremioAddonSources } from '../../persistence/services/providers/stremio-addon';
import { stremthruHealth, stremthruBaseUrl } from '../../persistence/services/debrid/stremthru';

export const dynamic = 'force-dynamic';

interface Check {
    ok: boolean;
    latencyMs?: number;
    detail?: string;
    status?: number;
}

/**
 * Health/diagnostic endpoint.
 *
 * Renders an HTML dashboard by default; returns JSON when the client asks
 * for it (Accept: application/json or ?format=json). Safe to expose publicly —
 * no secret values are leaked, only presence flags.
 */
export async function GET(req: NextRequest) {
    const wantsJson = req.headers.get('accept')?.includes('application/json')
        || req.nextUrl.searchParams.get('format') === 'json';

    const data = await collectStatus();

    if (wantsJson) {
        return NextResponse.json(data, {
            status: data.ok ? 200 : 503,
            headers: { 'Cache-Control': 'no-store' }
        });
    }
    return new Response(renderHtml(data), {
        status: data.ok ? 200 : 503,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}

async function collectStatus() {
    const data: any = {
        ok: true,
        timestamp: new Date().toISOString(),
        version: manifest.version,
        addon: { id: manifest.id, name: manifest.name },
        env: {
            MONGODB_URI: !!process.env.MONGODB_URI,
            TORRENTIO_BASE: process.env.TORRENTIO_BASE || '(default list)',
            WORKER_SECRET: !!process.env.WORKER_SECRET,
            CRON_SECRET: !!process.env.CRON_SECRET,
            SEEDERS_REFRESH_MS: process.env.SEEDERS_REFRESH_MS || 'default (30d)',
            VERCEL_REGION: process.env.VERCEL_REGION || 'unknown',
            NODE_ENV: process.env.NODE_ENV
        },
        checks: {} as Record<string, Check & Record<string, any>>
    };

    // MongoDB
    const dbStart = Date.now();
    try {
        await connect();
        const state = mongoose.connection.readyState;
        const stateLabel = ['disconnected', 'connected', 'connecting', 'disconnecting'][state] || `unknown(${state})`;
        const [streamCount, metaCount] = await Promise.all([
            Stream.estimatedDocumentCount().exec(),
            Meta.estimatedDocumentCount().exec()
        ]);
        data.checks.mongodb = {
            ok: state === 1,
            state: stateLabel,
            host: mongoose.connection.host || null,
            database: mongoose.connection.name || null,
            streams: streamCount,
            metas: metaCount,
            latencyMs: Date.now() - dbStart
        };
    } catch (err: any) {
        data.checks.mongodb = {
            ok: false,
            detail: String(err?.message || err),
            latencyMs: Date.now() - dbStart
        };
    }

    // Upstream addons
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Stremio/4.4';
    const upstreams = [
        { name: 'torrentio', url: 'https://torrentio.strem.fun/manifest.json' },
        { name: 'mediafusion', url: 'https://mediafusion.elfhosted.com/manifest.json' }
    ];
    if (process.env.TORRENTIO_BASE && process.env.TORRENTIO_BASE.includes('workers.dev')) {
        upstreams.unshift({ name: 'cloudflare-worker', url: process.env.TORRENTIO_BASE + '/manifest.json' });
    }
    for (const u of upstreams) {
        const start = Date.now();
        try {
            const r = await axios.get(u.url, {
                timeout: 5000,
                headers: {
                    'User-Agent': ua,
                    ...(process.env.WORKER_SECRET && u.name === 'cloudflare-worker'
                        ? { 'x-worker-secret': process.env.WORKER_SECRET }
                        : {})
                }
            });
            data.checks[u.name] = { ok: r.status === 200, latencyMs: Date.now() - start };
        } catch (err: any) {
            data.checks[u.name] = {
                ok: false,
                status: err.response?.status,
                detail: err.message || String(err),
                latencyMs: Date.now() - start
            };
        }
    }

    // StremThru
    const stStart = Date.now();
    try {
        const ok = await stremthruHealth();
        data.checks.stremthru = { ok, base: stremthruBaseUrl(), latencyMs: Date.now() - stStart };
    } catch (err: any) {
        data.checks.stremthru = { ok: false, detail: err?.message || String(err), latencyMs: Date.now() - stStart };
    }

    // Cinemeta
    const cmStart = Date.now();
    try {
        const r = await axios.get('https://v3-cinemeta.strem.io/manifest.json', {
            timeout: 5000,
            headers: { 'User-Agent': ua }
        });
        data.checks.cinemeta = { ok: r.status === 200, latencyMs: Date.now() - cmStart };
    } catch (err: any) {
        data.checks.cinemeta = { ok: false, detail: err.message || String(err), latencyMs: Date.now() - cmStart };
    }

    // Circuit breaker states
    data.breakers = getBreakerStates();
    data.stremioAddonSources = listStremioAddonSources();

    // Manifest sanity
    data.checks.manifest = {
        ok: !!manifest.id && !!manifest.catalogs?.length,
        catalogs: manifest.catalogs.map((c: any) => `${c.name} (${c.id})`).join(', '),
        resources: manifest.resources.join(', ')
    };

    data.ok = Object.values(data.checks).every((c: any) => c.ok !== false || c === data.checks.torrentio);
    return data;
}

function renderHtml(d: any): string {
    const checks = d.checks;
    const ok = d.ok;
    const upstreamOk = checks['cloudflare-worker']?.ok || checks.torrentio?.ok || checks.mediafusion?.ok;
    const summary = ok
        ? '<span class="badge badge-ok">Sistema operacional</span>'
        : '<span class="badge badge-warn">Atenção necessária</span>';

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="refresh" content="30" />
<title>Status — Mico Leão Dublado V2</title>
<link rel="icon" type="image/jpeg" href="/favicon.jpg" />
<style>
  :root {
    color-scheme: dark;
    --bg: #0a0f1f; --card: rgba(22, 27, 45, 0.85); --card-border: rgba(125, 166, 255, 0.12);
    --text: #e7e9f3; --muted: #8b93b0; --dim: #5a6280;
    --accent: #7da6ff; --success: #4fd9a0; --warn: #ffb84f; --error: #ff6b6b;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    background-image: radial-gradient(circle at 15% 10%, rgba(125,166,255,0.12), transparent 40%),
                      radial-gradient(circle at 85% 90%, rgba(180,125,255,0.10), transparent 40%);
    color: var(--text);
    margin: 0; padding: 32px 16px;
    line-height: 1.5;
  }
  .container { max-width: 800px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 8px; }
  header img { width: 48px; height: 48px; border-radius: 10px; object-fit: cover; }
  h1 { margin: 0; font-size: 22px; letter-spacing: -0.01em; }
  .subtitle { color: var(--dim); font-size: 13px; margin-top: 2px; }
  .summary { margin: 20px 0 28px; }
  .badge {
    display: inline-block; padding: 6px 14px; border-radius: 999px;
    font-size: 13px; font-weight: 700; letter-spacing: 0.02em;
  }
  .badge-ok { background: rgba(79, 217, 160, 0.15); color: var(--success); border: 1px solid rgba(79, 217, 160, 0.3); }
  .badge-warn { background: rgba(255, 184, 79, 0.15); color: var(--warn); border: 1px solid rgba(255, 184, 79, 0.3); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
  .card {
    background: var(--card); backdrop-filter: blur(20px);
    border: 1px solid var(--card-border); border-radius: 12px; padding: 18px;
  }
  .card h2 {
    margin: 0 0 12px; font-size: 13px; font-weight: 700;
    color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em;
    display: flex; align-items: center; gap: 8px;
  }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .dot.ok { background: var(--success); box-shadow: 0 0 8px rgba(79, 217, 160, 0.6); }
  .dot.bad { background: var(--error); box-shadow: 0 0 8px rgba(255, 107, 107, 0.6); }
  .dot.warn { background: var(--warn); }
  .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; }
  .row + .row { border-top: 1px solid rgba(255,255,255,0.05); }
  .row .key { color: var(--muted); }
  .row .val { color: var(--text); font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
  .row .val.dim { color: var(--dim); }
  .stat { font-size: 28px; font-weight: 700; color: var(--accent); }
  .stat-label { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px; }
  .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .latency { font-size: 11px; color: var(--dim); margin-left: auto; }
  details { margin-top: 16px; }
  details summary { cursor: pointer; color: var(--muted); font-size: 13px; padding: 8px 0; }
  details pre {
    background: rgba(10, 13, 24, 0.8); padding: 12px; border-radius: 8px;
    overflow-x: auto; font-size: 11px; color: var(--muted);
    border: 1px solid var(--card-border);
  }
  footer { margin-top: 32px; text-align: center; color: var(--dim); font-size: 12px; }
  footer a { color: var(--accent); text-decoration: none; }
  .timestamp { color: var(--dim); font-size: 12px; }
  .refresh-hint { color: var(--dim); font-size: 11px; margin-left: 8px; }
</style>
</head>
<body>
<div class="container">
  <header>
    <img src="/logo.jpg" alt="" />
    <div>
      <h1>Status do Sistema</h1>
      <div class="subtitle">${d.addon.name} · v${d.version}</div>
    </div>
  </header>

  <div class="summary">
    ${summary}
    <span class="timestamp">· última verificação ${new Date(d.timestamp).toLocaleString('pt-BR')}</span>
    <span class="refresh-hint">(atualiza em 30s)</span>
  </div>

  <div class="grid">
    ${renderStatCard('MongoDB Atlas', checks.mongodb, [
        ['Estado', checks.mongodb.state || '—'],
        ['Host', truncate(checks.mongodb.host, 40)],
        ['Database', checks.mongodb.database || '—'],
        ['Latência', checks.mongodb.latencyMs != null ? `${checks.mongodb.latencyMs}ms` : '—']
    ])}

    <div class="card">
      <h2><span class="dot ${checks.mongodb.ok ? 'ok' : 'bad'}"></span>Conteúdo em cache</h2>
      <div class="stats-grid">
        <div>
          <div class="stat">${checks.mongodb.metas ?? 0}</div>
          <div class="stat-label">Títulos (metas)</div>
        </div>
        <div>
          <div class="stat">${checks.mongodb.streams ?? 0}</div>
          <div class="stat-label">Streams</div>
        </div>
      </div>
    </div>

    ${checks['cloudflare-worker'] ? renderStatCard('Cloudflare Worker (Torrentio Proxy)', checks['cloudflare-worker'], [
        ['Status HTTP', checks['cloudflare-worker'].status ?? (checks['cloudflare-worker'].ok ? '200' : '—')],
        ['Latência', checks['cloudflare-worker'].latencyMs != null ? `${checks['cloudflare-worker'].latencyMs}ms` : '—'],
        ['Detalhe', checks['cloudflare-worker'].detail || (checks['cloudflare-worker'].ok ? 'OK' : '—')]
    ]) : `<div class="card">
      <h2><span class="dot warn"></span>Cloudflare Worker</h2>
      <div class="row"><span class="key">Status</span><span class="val dim">Não configurado</span></div>
      <div class="row"><span class="key">Como ativar</span><span class="val dim">Deploy o worker em cloudflare-worker/ e defina TORRENTIO_BASE</span></div>
    </div>`}

    ${renderStatCard('Torrentio (direto)', checks.torrentio, [
        ['Status HTTP', checks.torrentio?.status ?? (checks.torrentio?.ok ? '200' : '—')],
        ['Latência', checks.torrentio?.latencyMs != null ? `${checks.torrentio.latencyMs}ms` : '—'],
        ['Detalhe', checks.torrentio?.ok ? 'OK' : 'Bloqueia IPs cloud (use o Worker)']
    ])}

    ${renderStatCard('MediaFusion', checks.mediafusion, [
        ['Status HTTP', checks.mediafusion?.status ?? (checks.mediafusion?.ok ? '200' : '—')],
        ['Latência', checks.mediafusion?.latencyMs != null ? `${checks.mediafusion.latencyMs}ms` : '—']
    ])}

    ${renderStatCard('Cinemeta', checks.cinemeta, [
        ['Latência', checks.cinemeta?.latencyMs != null ? `${checks.cinemeta.latencyMs}ms` : '—'],
        ['Uso', 'Metadados e fallback de catálogo']
    ])}

    ${renderStatCard('StremThru (Debrid proxy)', checks.stremthru, [
        ['Backend', truncate(checks.stremthru?.base, 40)],
        ['Latência', checks.stremthru?.latencyMs != null ? `${checks.stremthru.latencyMs}ms` : '—']
    ])}

    ${renderBreakers(d.breakers)}

    <div class="card">
      <h2><span class="dot ok"></span>Fontes Stremio</h2>
      ${(d.stremioAddonSources || []).length === 0
          ? '<div class="row"><span class="key">Estado</span><span class="val dim">Nenhuma configurada</span></div>'
          : (d.stremioAddonSources as string[]).map((name) =>
              `<div class="row"><span class="key">${escapeHtml(name)}</span><span class="val dim">addon Stremio</span></div>`
            ).join('')}
    </div>

    <div class="card">
      <h2><span class="dot ${checks.manifest.ok ? 'ok' : 'bad'}"></span>Manifest</h2>
      <div class="row"><span class="key">Catálogos</span><span class="val">${escapeHtml(checks.manifest.catalogs)}</span></div>
      <div class="row"><span class="key">Recursos</span><span class="val">${escapeHtml(checks.manifest.resources)}</span></div>
    </div>
  </div>

  <details>
    <summary>Variáveis de ambiente</summary>
    <pre>${escapeHtml(JSON.stringify(d.env, null, 2))}</pre>
  </details>

  <details>
    <summary>JSON completo</summary>
    <pre>${escapeHtml(JSON.stringify(d, null, 2))}</pre>
  </details>

  <footer>
    <a href="/configure">Configurar addon</a> · <a href="https://github.com/joaosouz4dev/MicoLeaoDubladoAPIV2" target="_blank">GitHub</a>
  </footer>
</div>
</body>
</html>`;
}

function renderBreakers(breakers: any[] | undefined): string {
    if (!breakers || breakers.length === 0) {
        return `<div class="card">
          <h2><span class="dot ok"></span>Circuit breakers</h2>
          <div class="row"><span class="key">Estado</span><span class="val dim">Nenhum disparado</span></div>
        </div>`;
    }
    const anyOpen = breakers.some((b) => b.openFor != null);
    const rows = breakers.map((b) => {
        const status = b.openFor != null
            ? `aberto há ${b.openFor}s`
            : b.failures > 0 ? `${b.failures} falhas` : 'ok';
        return `<div class="row"><span class="key">${escapeHtml(b.name)}</span><span class="val">${escapeHtml(status)}</span></div>`;
    }).join('');
    return `<div class="card">
      <h2><span class="dot ${anyOpen ? 'warn' : 'ok'}"></span>Circuit breakers</h2>
      ${rows}
    </div>`;
}

function renderStatCard(title: string, check: Check & Record<string, any> | undefined, rows: [string, any][]) {
    if (!check) {
        return `<div class="card"><h2><span class="dot warn"></span>${escapeHtml(title)}</h2><div class="row"><span class="key">—</span></div></div>`;
    }
    const dotClass = check.ok ? 'ok' : 'bad';
    return `<div class="card">
      <h2><span class="dot ${dotClass}"></span>${escapeHtml(title)}</h2>
      ${rows.map(([k, v]) => `<div class="row"><span class="key">${escapeHtml(k)}</span><span class="val">${escapeHtml(String(v ?? '—'))}</span></div>`).join('')}
    </div>`;
}

function truncate(s: string | null | undefined, n: number): string {
    if (!s) return '—';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
