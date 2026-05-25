# Mico Leão Dublado **API V2**

![Mico Leão Dublado Logo](./assets/logo.jpg)

> **Sucessor independente** do projeto [`victorgveloso/MicoLeaoDubladoAPI`](https://github.com/victorgveloso/MicoLeaoDubladoAPI) — reescrito em Next.js 14, com suporte Debrid (Real-Debrid, TorBox) e deploy serverless na Vercel.

Mico Leão Dublado V2 é uma API stateless para armazenamento e distribuição de torrent magnets de conteúdo dublado em português brasileiro, em conformidade com o padrão Stremio Addon SDK. Os magnets são armazenados no MongoDB Atlas e os streams podem ser entregues diretamente como torrent ou via provedores Debrid (cacheados, mais rápidos).

## Créditos

Este projeto é um **sucessor independente** do original [`victorgveloso/MicoLeaoDubladoAPI`](https://github.com/victorgveloso/MicoLeaoDubladoAPI), licenciado sob Apache 2.0. O design dos models (`Meta`, `Stream`, `Catalog`, `Manifest`), assemblers de DTO e a estrutura geral da camada de persistência foram preservados — o crédito pelo trabalho fundacional é do autor original, **Victor G. Veloso**.

A partir desta V2, a base de código diverge significativamente do upstream:

- Migração de Express → **Next.js 14 (App Router)** + serverless functions
- Suporte a **Debrid** (Real-Debrid + TorBox) — atendendo à [issue #8](https://github.com/victorgveloso/MicoLeaoDubladoAPI/issues/8) do upstream, aberta desde 2022 sem resposta
- **Tracker scrape** nativo para refresh on-demand de seeders
- **`StreamController`** acima do DAO com formatação de título e cache temporal de seeders
- Página `/configure` no padrão Stremio (config codificada na URL, sem sessão server-side)
- Deploy serverless na Vercel + MongoDB Atlas com connection caching

A LICENSE Apache 2.0 do projeto original é mantida — veja [LICENSE](./LICENSE).

## Novidades da V2

- **Next.js 14 (App Router)** + deploy serverless na **Vercel**
- **Seeders ao vivo** via tracker scrape (UDP/HTTP/HTTPS BEP 48), refresh on-demand a cada 30 dias (configurável via `SEEDERS_REFRESH_MS`)
- **`StreamController`** envolve o DAO, formata título com contagem 👥 de seeders
- **Suporte Debrid**: Real-Debrid e TorBox via URL configurável (Stremio standard `/<provider>-<apikey>/manifest.json`)
- Página `/configure` para gerar manifest URL personalizada
- **MongoDB Atlas** com connection caching global para serverless

Veja [DEPLOY.md](./DEPLOY.md) para instruções de deploy na Vercel.

## Dependencies

* NodeJS 18+
* MongoDB (Atlas para produção; local para desenvolvimento)

## Running

```sh
npm install
cp .env.example .env       # configure MONGODB_URI
npm run dev                # dev server (Next.js) em http://localhost:3000
npm run build && npm start # production build
npm test                   # rodar testes
```

## Using

Mico Leão Dublado API V2 é uma HTTP API (use um HTTP client de sua escolha).

### Endpoints

| Verb | Path                                                          | Descrição                                                   |
|------|---------------------------------------------------------------|-------------------------------------------------------------|
| GET  | `/`                                                           | Redireciona para `/configure`                               |
| GET  | `/configure`                                                  | Página de configuração Debrid                               |
| GET  | `/manifest.json`                                              | Manifest sem Debrid                                         |
| GET  | `/<provider>-<apikey>/manifest.json`                          | Manifest com Debrid embutido                                |
| GET  | `/stream/movie/<imdbId>.json`                                 | Streams torrent diretos (filme)                             |
| GET  | `/stream/series/<imdbId>:<season>:<episode>.json`             | Streams torrent diretos (episódio)                          |
| GET  | `/<provider>-<apikey>/stream/movie/<imdbId>.json`             | Streams via Debrid (filme)                                  |
| GET  | `/<provider>-<apikey>/stream/series/<imdbId>:<s>:<e>.json`    | Streams via Debrid (episódio)                               |
| GET  | `/catalog/<type>/<catalogId>.json`                            | Catálogo                                                    |
| GET  | `/catalog/<type>/<catalogId>/<extra>.json`                    | Catálogo com filtros (`search=`, `genre=`, `skip=`)         |
| GET  | `/meta/<type>/<imdbId>.json`                                  | Metadata                                                    |
| POST | `/movie`                                                      | Inserir filme — body: [`MovieDTO`](src/persistence/models/transfer-objects/movie.ts) |
| POST | `/series`                                                     | Inserir série — body: [`SeriesDTO`](src/persistence/models/transfer-objects/series.ts) |

### Provedores Debrid suportados

| Provider     | Valor `<provider>` | Onde obter API key                              |
|--------------|--------------------|-------------------------------------------------|
| Real-Debrid  | `realdebrid`       | <https://real-debrid.com/apitoken>              |
| TorBox       | `torbox`           | <https://torbox.app/settings>                   |

## Contributing

Issues e PRs são bem-vindos. Veja [CONTRIBUTING.md](./CONTRIBUTING.md).

## Community

Você pode nos encontrar no [Stremio Addons Discord Server](https://discord.gg/WTqVGKXh) e em [r/StremioAddons](https://reddit.com/r/StremioAddons/).

### License: [Apache 2.0](./LICENSE) (herdada do projeto original)
