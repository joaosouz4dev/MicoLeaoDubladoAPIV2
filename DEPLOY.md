# Deploy — MicoLeaoDubladoAPIV2 na Vercel

## 1. Pré-requisitos

- Conta Vercel
- Cluster MongoDB Atlas (free tier basta) — anote a connection string
- API keys dos provedores Debrid suportados (opcional, configurado por usuário):
  - Real-Debrid: <https://real-debrid.com/apitoken>
  - TorBox: <https://torbox.app/settings>

## 2. Variáveis de ambiente

Configure no painel da Vercel (Settings → Environment Variables):

| Variável             | Obrigatória | Descrição                                                       |
|----------------------|-------------|-----------------------------------------------------------------|
| `MONGODB_URI`        | sim         | URI completa do Atlas (com user/senha e database)               |
| `SEEDERS_REFRESH_MS` | não         | Intervalo de refresh de seeders em ms (default 30 dias)         |

> No Atlas, libere acesso de qualquer IP (`0.0.0.0/0`) para a função serverless conseguir conectar.

## 3. Deploy

### Via CLI

```sh
npm i -g vercel
vercel login
vercel link --project MicoLeaoDubladoAPIV2
vercel --prod
```

### Via GitHub

1. Faça push do repositório para o GitHub
2. Em <https://vercel.com/new> importe o repositório
3. Defina o nome do projeto como **MicoLeaoDubladoAPIV2**
4. Adicione as env vars (passo 2)
5. Deploy

## 4. Endpoints

Após o deploy, a base será `https://micoleaodubladoapiv2.vercel.app`.

| Endpoint                                                       | Descrição                                       |
|----------------------------------------------------------------|-------------------------------------------------|
| `/`                                                            | Redireciona para `/configure`                   |
| `/configure`                                                   | Página de configuração Debrid                   |
| `/manifest.json`                                               | Manifest sem Debrid                             |
| `/<provider>-<apikey>/manifest.json`                           | Manifest com Debrid embutido                    |
| `/stream/movie/<imdbId>.json`                                  | Streams torrent diretos                         |
| `/<provider>-<apikey>/stream/movie/<imdbId>.json`              | Streams via Debrid (Real-Debrid / TorBox)       |
| `/stream/series/<imdbId>:<season>:<episode>.json`              | Streams de série                                |
| `/catalog/movie/<catalogId>.json`                              | Catálogo                                        |
| `/meta/<type>/<id>.json`                                       | Metadata                                        |
| `POST /movie`                                                  | Inserir filme (admin)                           |
| `POST /series`                                                 | Inserir série (admin)                           |

## 5. Como o usuário instala

1. Acessa `https://micoleaodubladoapiv2.vercel.app/configure`
2. Seleciona provedor Debrid e cola a API key
3. Clica em "Gerar link de instalação"
4. Clica em "Instalar no Stremio"

A URL contém a config — o servidor é stateless, nada é armazenado.
