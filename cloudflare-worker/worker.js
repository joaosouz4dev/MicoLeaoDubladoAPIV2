/**
 * Cloudflare Worker — Torrentio proxy.
 *
 * Forwards /stream/<type>/<id>.json and /manifest.json to torrentio.strem.fun
 * with a browser-like UA. Useful when running the addon from a cloud IP that
 * Torrentio blocks directly.
 *
 * NOTE: Torrentio has an aggressive bot-detection layer (Cloudflare itself).
 * It blocks ALL non-residential IP ranges, including Cloudflare Workers.
 * In practice this proxy WILL return 403/blocked HTML for most requests.
 * The addon's primary source is torrent-indexer.darklyn.org, which works
 * directly from Vercel — the worker is kept as a best-effort fallback.
 *
 * Deploy: see cloudflare-worker/README.md
 */

const UPSTREAM = 'https://torrentio.strem.fun';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // Friendly landing for browser visits
        if (url.pathname === '/' || url.pathname === '') {
            return new Response(landingHtml(), {
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }

        // Optional shared-secret check (only for non-landing requests)
        if (env.WORKER_SECRET) {
            const provided = request.headers.get('x-worker-secret');
            if (provided !== env.WORKER_SECRET) {
                return new Response('Forbidden', { status: 403 });
            }
        }

        const upstreamUrl = new URL(UPSTREAM);
        upstreamUrl.pathname = url.pathname;
        upstreamUrl.search = url.search;

        const init = {
            method: request.method,
            headers: {
                'User-Agent': BROWSER_UA,
                'Accept': 'application/json',
                'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
            },
            cf: { cacheTtl: 60, cacheEverything: false }
        };

        try {
            const upstream = await fetch(upstreamUrl.toString(), init);
            const headers = new Headers(upstream.headers);
            headers.set('Access-Control-Allow-Origin', '*');
            headers.set('Cache-Control', 'public, max-age=60');
            return new Response(upstream.body, {
                status: upstream.status,
                statusText: upstream.statusText,
                headers
            });
        } catch (err) {
            return new Response(JSON.stringify({ error: String(err) }), {
                status: 502,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
};

function landingHtml() {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Mico Torrentio Proxy</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0a0f1f; color: #e7e9f3;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; margin: 0; padding: 24px;
    line-height: 1.5;
  }
  .card {
    background: rgba(22, 27, 45, 0.85);
    border: 1px solid rgba(125, 166, 255, 0.12);
    border-radius: 16px; padding: 32px; max-width: 480px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.4);
  }
  h1 { margin: 0 0 8px; font-size: 22px; }
  p { color: #8b93b0; margin: 12px 0; font-size: 14px; }
  code {
    background: #0a0d18; padding: 2px 8px; border-radius: 4px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px;
    color: #7da6ff;
  }
  a { color: #7da6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="card">
  <h1>🦁 Mico Torrentio Proxy</h1>
  <p>Este é um worker do Cloudflare que faz proxy para o Torrentio. Não é uma página normal — ele só responde a chamadas de API.</p>
  <p>Exemplo de uso:</p>
  <p><code>/stream/movie/tt0816692.json</code></p>
  <p>Parte do projeto <a href="https://github.com/joaosouz4dev/MicoLeaoDubladoAPIV2" target="_blank">Mico Leão Dublado V2</a>.</p>
</div>
</body>
</html>`;
}
