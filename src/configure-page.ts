/**
 * HTML for the /configure page.
 *
 * Lets the user pick a Debrid provider and supply an apikey, then generates a
 * per-user manifest URL of the form:
 *
 *     <host>/<provider>-<apikey>/manifest.json
 *
 * Stremio includes that prefix on every subsequent /stream/... request, so the
 * config travels with each request — no server-side session needed.
 *
 * When the page is reached via `/<provider>-<apikey>/configure` (Stremio's
 * "edit config" deep link), `initial` arrives populated and the page boots
 * in edit mode: the provider chip is pre-selected and the apikey input is
 * pre-filled so the user can rotate the key or change providers without
 * retyping.
 */
export interface ConfigureInitialValue {
    provider: 'realdebrid' | 'torbox';
    apikey: string;
}

export function renderConfigurePage(host: string, initial?: ConfigureInitialValue | null): string {
    const initialJson = initial
        ? JSON.stringify({ provider: initial.provider, apikey: initial.apikey })
        : 'null';
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Mico Leão Dublado V2 — Configurar</title>
<link rel="icon" type="image/jpeg" href="/favicon.jpg" />
<link rel="apple-touch-icon" href="/logo.jpg" />
<meta name="theme-color" content="#0a0f1f" />
<meta name="description" content="Stremio addon para filmes e séries dublados em português brasileiro, com suporte a Real-Debrid e TorBox." />
<meta property="og:title" content="Mico Leão Dublado V2" />
<meta property="og:description" content="Stremio addon para filmes e séries dublados em português brasileiro, com suporte a Real-Debrid e TorBox." />
<meta property="og:image" content="/logo.jpg" />
<meta property="og:type" content="website" />
<style>
  :root {
    color-scheme: dark;
    --bg: #0a0f1f;
    --bg-grad-1: #1a1240;
    --bg-grad-2: #0a0f1f;
    --card: rgba(22, 27, 45, 0.85);
    --card-border: rgba(125, 166, 255, 0.12);
    --text: #e7e9f3;
    --muted: #8b93b0;
    --dim: #5a6280;
    --accent: #7da6ff;
    --accent-2: #b47dff;
    --success: #4fd9a0;
    --warn: #ffb84f;
    --input-bg: rgba(10, 13, 24, 0.6);
    --input-border: rgba(125, 166, 255, 0.15);
    --input-border-focus: #7da6ff;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    background-image:
      radial-gradient(circle at 15% 10%, rgba(125, 166, 255, 0.15), transparent 40%),
      radial-gradient(circle at 85% 90%, rgba(180, 125, 255, 0.12), transparent 40%);
    color: var(--text);
    display: flex; flex-direction: column; align-items: center;
    min-height: 100vh; padding: 40px 16px;
    line-height: 1.5;
  }
  .card {
    background: var(--card);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid var(--card-border);
    border-radius: 16px;
    padding: 32px;
    max-width: 480px; width: 100%;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }
  .header { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
  .header img {
    width: 56px; height: 56px; border-radius: 12px; object-fit: cover;
    box-shadow: 0 4px 16px rgba(125, 166, 255, 0.3);
  }
  .header h1 { margin: 0; font-size: 22px; letter-spacing: -0.01em; }
  .header .badge {
    display: inline-block; vertical-align: middle;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: white; font-size: 11px; font-weight: 700;
    padding: 2px 8px; border-radius: 6px; margin-left: 6px;
  }
  .header .subtitle { font-size: 12px; color: var(--dim); margin-top: 2px; }
  .lede { color: var(--muted); margin: 16px 0 24px; font-size: 14px; }

  label {
    display: block; margin-top: 18px; margin-bottom: 6px;
    font-weight: 600; font-size: 13px; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .providers {
    display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;
  }
  .provider-btn {
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    color: var(--text);
    padding: 14px 10px; border-radius: 10px; cursor: pointer;
    font-size: 13px; font-weight: 600;
    transition: all 0.15s ease;
    text-align: center;
  }
  .provider-btn:hover {
    border-color: var(--accent);
    background: rgba(125, 166, 255, 0.08);
  }
  .provider-btn.selected {
    border-color: var(--accent);
    background: rgba(125, 166, 255, 0.15);
    box-shadow: 0 0 0 2px rgba(125, 166, 255, 0.2);
  }
  .provider-btn .label-main { display: block; }
  .provider-btn .label-sub { display: block; font-size: 10px; color: var(--dim); margin-top: 4px; font-weight: 500; text-transform: none; letter-spacing: 0; }

  .apikey-section { transition: opacity 0.2s ease, max-height 0.3s ease; overflow: hidden; }
  .apikey-section.hidden { opacity: 0; max-height: 0; margin: 0; pointer-events: none; }

  .input-wrapper { position: relative; }
  input[type="text"], input[type="password"] {
    width: 100%; padding: 12px 40px 12px 14px;
    background: var(--input-bg);
    color: var(--text);
    border: 1px solid var(--input-border);
    border-radius: 10px;
    font-size: 14px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    transition: border-color 0.15s ease;
  }
  input[type="text"]:focus, input[type="password"]:focus {
    outline: none; border-color: var(--input-border-focus);
    box-shadow: 0 0 0 3px rgba(125, 166, 255, 0.15);
  }
  .toggle-visibility {
    position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
    background: none; border: none; cursor: pointer; padding: 4px 8px;
    color: var(--muted); font-size: 12px;
  }
  .toggle-visibility:hover { color: var(--text); }

  .apikey-link {
    margin-top: 8px; font-size: 12px; color: var(--muted);
  }
  .apikey-link a {
    color: var(--accent); text-decoration: none; font-weight: 500;
  }
  .apikey-link a:hover { text-decoration: underline; }
  .apikey-link .icon { display: inline-block; margin-right: 4px; }

  button.primary {
    margin-top: 24px; width: 100%; padding: 14px;
    border: none;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: white; font-weight: 700; font-size: 15px;
    border-radius: 10px;
    cursor: pointer;
    transition: transform 0.1s ease, box-shadow 0.15s ease;
    letter-spacing: 0.01em;
  }
  button.primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 8px 24px rgba(125, 166, 255, 0.35);
  }
  button.primary:active { transform: translateY(0); }
  button.primary:disabled {
    background: var(--input-bg); color: var(--dim); cursor: not-allowed;
    transform: none; box-shadow: none;
  }

  .install {
    margin-top: 24px; padding-top: 24px;
    border-top: 1px solid var(--card-border);
    display: none;
  }
  .install.visible { display: block; animation: fadeIn 0.3s ease; }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .install-actions { display: flex; gap: 8px; margin-bottom: 12px; }
  .install-actions a, .install-actions button {
    flex: 1; padding: 12px; border-radius: 10px;
    font-size: 13px; font-weight: 600;
    text-align: center; text-decoration: none;
    cursor: pointer; border: 1px solid var(--input-border);
    background: var(--input-bg); color: var(--text);
    transition: all 0.15s ease;
  }
  .install-actions a.primary-action {
    background: linear-gradient(135deg, var(--success), #3fa67a);
    border-color: transparent; color: white;
  }
  .install-actions a:hover, .install-actions button:hover {
    border-color: var(--accent);
  }
  .install-actions a.primary-action:hover {
    box-shadow: 0 6px 20px rgba(79, 217, 160, 0.3);
  }
  .manifest-url {
    background: rgba(10, 13, 24, 0.8);
    padding: 10px 12px;
    border-radius: 8px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    word-break: break-all;
    color: var(--muted);
    border: 1px solid var(--input-border);
  }
  .copy-feedback {
    color: var(--success); font-size: 12px;
    margin-top: 6px; text-align: center;
    opacity: 0; transition: opacity 0.2s ease;
  }
  .copy-feedback.visible { opacity: 1; }

  footer {
    margin-top: 28px; color: var(--dim); font-size: 12px;
    text-align: center; max-width: 480px;
  }
  footer a { color: var(--accent); text-decoration: none; font-weight: 500; }
  footer a:hover { text-decoration: underline; }

  @media (max-width: 480px) {
    .card { padding: 24px 20px; }
    .header h1 { font-size: 19px; }
    .providers { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="header">
      <img src="/logo.jpg" alt="Mico Leão Dublado" />
      <div>
        <h1>Mico Leão Dublado <span class="badge">V2</span></h1>
        <div class="subtitle">Stremio addon · Filmes e séries dublados</div>
      </div>
    </div>

    <p class="lede" id="lede">
      Opcionalmente conecte um provedor Debrid para streams cacheados e instantâneos —
      sem download torrent local.
    </p>

    <label>Provedor Debrid</label>
    <div class="providers" id="providers">
      <button type="button" class="provider-btn selected" data-provider="">
        <span class="label-main">Nenhum</span>
        <span class="label-sub">Torrents diretos</span>
      </button>
      <button type="button" class="provider-btn" data-provider="realdebrid">
        <span class="label-main">Real-Debrid</span>
        <span class="label-sub">€3 / mês</span>
      </button>
      <button type="button" class="provider-btn" data-provider="torbox">
        <span class="label-main">TorBox</span>
        <span class="label-sub">$3 / mês</span>
      </button>
    </div>

    <div class="apikey-section hidden" id="apikeySection">
      <label for="apikey">API Key</label>
      <div class="input-wrapper">
        <input id="apikey" type="password" placeholder="Cole sua API key aqui" autocomplete="off" spellcheck="false" />
        <button type="button" class="toggle-visibility" id="toggleApikey" aria-label="Mostrar/ocultar">👁</button>
      </div>
      <div class="apikey-link" id="apikeyLink"></div>
    </div>

    <button type="button" class="primary" id="generate" disabled>Gerar link de instalação</button>

    <div class="install" id="install">
      <div class="install-actions">
        <a id="installLink" class="primary-action" href="#">▶ Instalar no Stremio</a>
        <button type="button" id="copyBtn">📋 Copiar URL</button>
      </div>
      <div class="manifest-url" id="manifestUrl"></div>
      <div class="copy-feedback" id="copyFeedback">URL copiada ✓</div>
    </div>
  </div>

  <footer>
    <p style="margin:0">
      <a href="https://github.com/joaosouz4dev/MicoLeaoDubladoAPIV2" target="_blank">
        ⭐ github.com/joaosouz4dev/MicoLeaoDubladoAPIV2
      </a>
    </p>
  </footer>

<script>
  const host = ${JSON.stringify(host)};
  const initial = ${initialJson};
  const APIKEY_LINKS = {
    realdebrid: {
      url: 'https://real-debrid.com/apitoken',
      label: 'Pegar minha API key no Real-Debrid'
    },
    torbox: {
      url: 'https://torbox.app/settings',
      label: 'Pegar minha API key no TorBox'
    }
  };

  let selectedProvider = '';
  const providerBtns = document.querySelectorAll('.provider-btn');
  const apikeySection = document.getElementById('apikeySection');
  const apikeyInput = document.getElementById('apikey');
  const apikeyLink = document.getElementById('apikeyLink');
  const generateBtn = document.getElementById('generate');
  const installBox = document.getElementById('install');
  const installLink = document.getElementById('installLink');
  const manifestUrlEl = document.getElementById('manifestUrl');
  const copyBtn = document.getElementById('copyBtn');
  const copyFeedback = document.getElementById('copyFeedback');
  const toggleApikey = document.getElementById('toggleApikey');

  function updateGenerateButtonState() {
    if (!selectedProvider) {
      generateBtn.disabled = false;
      generateBtn.textContent = 'Instalar sem Debrid';
    } else if (apikeyInput.value.trim()) {
      generateBtn.disabled = false;
      generateBtn.textContent = 'Gerar link de instalação';
    } else {
      generateBtn.disabled = true;
      generateBtn.textContent = 'Cole a API key acima';
    }
  }

  providerBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      providerBtns.forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedProvider = btn.dataset.provider;

      if (selectedProvider && APIKEY_LINKS[selectedProvider]) {
        apikeySection.classList.remove('hidden');
        const info = APIKEY_LINKS[selectedProvider];
        apikeyLink.innerHTML =
          '<span class="icon">🔑</span>' +
          '<a href="' + info.url + '" target="_blank" rel="noopener">' + info.label + ' ↗</a>';
      } else {
        apikeySection.classList.add('hidden');
        apikeyInput.value = '';
      }
      installBox.classList.remove('visible');
      updateGenerateButtonState();
    });
  });

  apikeyInput.addEventListener('input', updateGenerateButtonState);

  toggleApikey.addEventListener('click', () => {
    apikeyInput.type = apikeyInput.type === 'password' ? 'text' : 'password';
  });

  function buildManifestUrl() {
    const apikey = apikeyInput.value.trim();
    if (selectedProvider && apikey) {
      return host + '/' + selectedProvider + '-' + encodeURIComponent(apikey) + '/manifest.json';
    }
    return host + '/manifest.json';
  }

  generateBtn.addEventListener('click', () => {
    const manifestUrl = buildManifestUrl();
    const stremioUrl = manifestUrl.replace(/^https?:\\/\\//, 'stremio://');
    installLink.href = stremioUrl;
    manifestUrlEl.textContent = manifestUrl;
    installBox.classList.add('visible');
    installBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(manifestUrlEl.textContent);
      copyFeedback.classList.add('visible');
      setTimeout(() => copyFeedback.classList.remove('visible'), 1800);
    } catch (err) {
      const range = document.createRange();
      range.selectNode(manifestUrlEl);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
  });

  /**
   * Boot with the initial config when present (Stremio edit-config deep link).
   * Selects the provider chip and pre-fills the apikey so the user can
   * rotate the key or change providers without retyping.
   */
  function applyInitial() {
    if (!initial || !initial.provider) return;
    const btn = document.querySelector('.provider-btn[data-provider="' + initial.provider + '"]');
    if (!btn) return;
    providerBtns.forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedProvider = initial.provider;
    if (APIKEY_LINKS[selectedProvider]) {
      apikeySection.classList.remove('hidden');
      const info = APIKEY_LINKS[selectedProvider];
      apikeyLink.innerHTML =
        '<span class="icon">🔑</span>' +
        '<a href="' + info.url + '" target="_blank" rel="noopener">' + info.label + ' ↗</a>';
    }
    if (initial.apikey) apikeyInput.value = initial.apikey;
    // Show a "Currently installed" hint so it's obvious this is edit mode
    const lede = document.getElementById('lede');
    if (lede) {
      lede.textContent = 'Edite sua configuração atual. O link de instalação abaixo refletirá as mudanças.';
    }
  }

  applyInitial();
  updateGenerateButtonState();
</script>
</body>
</html>`;
}
