/**
 * Static manifest, embedded as a TypeScript constant.
 *
 * We used to `import` the manifest from a sibling .json file. Next.js + the
 * Vercel build pipeline read JSON imports through a route that mangled UTF-8
 * for our emoji characters (🦁 → ðŸ¦), which made Stremio silently drop the
 * "Mico - Séries" catalog because its name parsed as garbage.
 *
 * Inlining the JSON as a TS literal sidesteps the bundler entirely — the
 * source file is read as UTF-8 like any other TS module.
 */
export const manifest = {
    id: 'brazilian-addon-v2',
    name: '🦁 Mico Leão Dublado V2',
    logo: 'https://raw.githubusercontent.com/joaosouz4dev/MicoLeaoDubladoAPIV2/main/assets/logo.jpg',
    background: 'https://raw.githubusercontent.com/joaosouz4dev/MicoLeaoDubladoAPIV2/main/assets/logo.jpg',
    version: '2.1.1',
    description: '🇧🇷 Filmes e séries dublados em português. Suporte a Debrid (Real-Debrid, TorBox). Código aberto em github.com/joaosouz4dev/MicoLeaoDubladoAPIV2',
    resources: ['catalog', 'stream'],
    types: ['movie', 'series'],
    catalogs: [
        {
            type: 'movie',
            id: 'MicoFilmes',
            name: '🦁 Mico - Filmes',
            extra: [
                { name: 'search', isRequired: false },
                {
                    name: 'genre',
                    isRequired: false,
                    options: [
                        'Ação', 'Animação', 'Aventura', 'Clássico', 'Comédia',
                        'Documentário', 'Drama', 'Fantasia', 'Ficção', 'Faroeste',
                        'Guerra', 'Músicas', 'Nacional', 'Policial', 'Romance',
                        'Suspense', 'Terror'
                    ]
                },
                { name: 'skip', isRequired: false }
            ]
        },
        {
            type: 'series',
            id: 'MicoSeries',
            name: '🦁 Mico - Séries',
            extra: [
                { name: 'search', isRequired: false },
                {
                    name: 'genre',
                    isRequired: false,
                    options: [
                        'Ação', 'Animação', 'Aventura', 'Comédia', 'Drama',
                        'Fantasia', 'Ficção', 'Romance', 'Suspense', 'Terror'
                    ]
                },
                { name: 'skip', isRequired: false }
            ]
        }
    ],
    idPrefixes: ['tt'],
    behaviorHints: {
        configurable: true,
        configurationRequired: false
    }
} as const;

export default manifest;
