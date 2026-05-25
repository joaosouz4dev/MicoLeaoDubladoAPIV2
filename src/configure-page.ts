/**
 * HTML for the /configure page. Lets the user pick a Debrid provider and supply an apikey,
 * then generates a per-user manifest URL of the form:
 *
 *     <host>/<provider>-<apikey>/manifest.json
 *
 * Stremio will then include that prefix on every subsequent /stream/... request, so the
 * config travels with each request — no server-side session needed.
 */
export function renderConfigurePage(host: string): string {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Mico Leão Dublado — Configurar</title>
<style>
  :root { color-scheme: dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1320; color: #e7e9f3;
    display: flex; flex-direction: column; align-items: center;
    min-height: 100vh; margin: 0; padding: 32px 16px;
  }
  .card {
    background: #161b2d; border-radius: 12px; padding: 28px;
    max-width: 460px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.4);
  }
  h1 { margin: 0 0 12px; font-size: 22px; }
  p { color: #a1a8c2; line-height: 1.4; }
  label { display: block; margin-top: 18px; font-weight: 600; font-size: 14px; }
  select, input[type="text"] {
    width: 100%; box-sizing: border-box; padding: 10px 12px; margin-top: 6px;
    background: #0f1320; color: #e7e9f3; border: 1px solid #2a3050;
    border-radius: 8px; font-size: 14px;
  }
  button {
    margin-top: 22px; width: 100%; padding: 12px; border: none;
    background: linear-gradient(135deg, #4f7cff, #7d4fff);
    color: white; font-weight: 600; font-size: 15px; border-radius: 8px;
    cursor: pointer;
  }
  button:hover { opacity: 0.9; }
  .install { margin-top: 16px; word-break: break-all; font-size: 13px; color: #a1a8c2; }
  .install a { color: #7da6ff; }
  .install code { background: #0a0d18; padding: 6px 8px; border-radius: 6px; display: block; margin-top: 6px; }
  .hint { font-size: 12px; color: #6c7591; margin-top: 6px; }
</style>
</head>
<body>
  <div class="card">
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:8px">
      <img src="/logo.jpg" alt="Mico Leão Dublado" style="width:56px;height:56px;border-radius:10px;object-fit:cover" />
      <div>
        <h1 style="margin:0">Mico Leão Dublado <span style="color:#7da6ff">V2</span></h1>
        <div style="font-size:12px;color:#6c7591">Stremio addon · open-source</div>
      </div>
    </div>
    <p>Configure um provedor Debrid para streams cacheados (sem torrent local).</p>

    <label for="provider">Provedor</label>
    <select id="provider">
      <option value="">Nenhum (torrents diretos)</option>
      <option value="realdebrid">Real-Debrid</option>
      <option value="torbox">TorBox</option>
    </select>

    <label for="apikey">API key</label>
    <input id="apikey" type="text" placeholder="Cole sua API key" autocomplete="off" />
    <div class="hint">
      Real-Debrid: <a href="https://real-debrid.com/apitoken" target="_blank">real-debrid.com/apitoken</a> ·
      TorBox: <a href="https://torbox.app/settings" target="_blank">torbox.app/settings</a>
    </div>

    <button id="generate">Gerar link de instalação</button>

    <div class="install" id="install" style="display:none">
      <p>Clique para instalar no Stremio:</p>
      <a id="installLink" href="#">Instalar no Stremio</a>
      <code id="manifestUrl"></code>
    </div>
  </div>

  <footer style="margin-top:24px;color:#6c7591;font-size:13px;text-align:center;max-width:460px">
    <p style="margin:0 0 8px">
      <a href="https://github.com/joaosouz4dev/MicoLeaoDubladoAPIV2" target="_blank" style="color:#7da6ff;text-decoration:none">
        ⭐ github.com/joaosouz4dev/MicoLeaoDubladoAPIV2
      </a>
    </p>
    <p style="margin:0;font-size:11px">
      Sucessor independente de
      <a href="https://github.com/victorgveloso/MicoLeaoDubladoAPI" target="_blank" style="color:#6c7591">victorgveloso/MicoLeaoDubladoAPI</a>
      · Apache 2.0
    </p>
  </footer>

<script>
  const host = ${JSON.stringify(host)};
  document.getElementById('generate').addEventListener('click', () => {
    const provider = document.getElementById('provider').value.trim();
    const apikey = document.getElementById('apikey').value.trim();
    let manifestUrl;
    if (provider && apikey) {
      manifestUrl = host + '/' + provider + '-' + encodeURIComponent(apikey) + '/manifest.json';
    } else {
      manifestUrl = host + '/manifest.json';
    }
    const stremioUrl = manifestUrl.replace(/^https?:\\/\\//, 'stremio://');
    const installBox = document.getElementById('install');
    installBox.style.display = 'block';
    document.getElementById('installLink').href = stremioUrl;
    document.getElementById('manifestUrl').textContent = manifestUrl;
  });
</script>
</body>
</html>`;
}
