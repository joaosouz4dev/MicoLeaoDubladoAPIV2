/**
 * Cloudflare Worker — Torrentio proxy.
 *
 * Torrentio blocks Vercel IPs (HTTP 403). Cloudflare Worker IPs are residential-
 * adjacent and not on the blocklist, so we proxy through here.
 *
 * Deploy: see cloudflare-worker/README.md
 * Usage from the API: set TORRENTIO_BASE=https://<your-worker>.workers.dev
 *
 * The worker accepts the same paths as Torrentio (e.g. /stream/movie/tt0111161.json)
 * and forwards them to the upstream, returning the response transparently.
 *
 * Optional shared-secret guard: set WORKER_SECRET env var on both the worker and
 * the API; the API sends it as a header on every request.
 */

const UPSTREAM = 'https://torrentio.strem.fun';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export default {
    async fetch(request, env) {
        // Optional shared-secret check
        if (env.WORKER_SECRET) {
            const provided = request.headers.get('x-worker-secret');
            if (provided !== env.WORKER_SECRET) {
                return new Response('Forbidden', { status: 403 });
            }
        }

        const url = new URL(request.url);
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
            // Pass through with CORS so the addon can also be called from any client
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
