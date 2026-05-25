# Cloudflare Worker — Torrentio Proxy

Torrentio bloqueia IPs de cloud providers (Vercel, AWS, GCP) com HTTP 403.
Este worker fica como proxy entre o addon e o Torrentio.

## Setup (5 min)

### 1. Instalar Wrangler

```sh
npm install -g wrangler
wrangler login
```

### 2. Deploy

Na pasta `cloudflare-worker/`:

```sh
wrangler deploy
```

A saída mostra a URL final, algo como:
```
Published mico-torrentio-proxy
  https://mico-torrentio-proxy.<seu-subdomain>.workers.dev
```

### 3. (Opcional) Configurar segredo

Para impedir que terceiros usem seu worker:

```sh
wrangler secret put WORKER_SECRET
# Cole uma string aleatória quando pedido
```

### 4. Configurar a Vercel

No painel da Vercel → Settings → Environment Variables, adicione:

| Variável         | Valor                                                         |
|------------------|---------------------------------------------------------------|
| `TORRENTIO_BASE` | `https://mico-torrentio-proxy.<seu-subdomain>.workers.dev`    |
| `WORKER_SECRET`  | (mesma string que você passou no `wrangler secret put`)       |

Faça redeploy ou aguarde o próximo push para a Vercel pegar as novas envs.

## Como verificar

Depois do deploy:

```sh
curl https://<seu-deploy>.vercel.app/status
```

Procure por `upstreams.torrentio.ok: true`.

## Limites do free tier

Cloudflare Workers free tier:
- 100.000 requests/dia
- 10ms CPU time por request

Suficiente para uso pessoal e até alguns usuários simultâneos.
