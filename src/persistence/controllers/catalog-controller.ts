import axios from 'axios';
import MetaDAO from './meta-dao';
import Stream from '../models/stream';
import { Args } from '../models/stremio';
import { discoverPopularBR, searchTmdb, tmdbAvailable } from '../services/tmdb';

const CINEMETA_BASE = process.env.CINEMETA_BASE || 'https://v3-cinemeta.strem.io';
const UA = { 'User-Agent': 'Stremio/4.4.x (MicoLeaoDubladoAPIV2)' };

/**
 * Catalog request handler.
 *
 * The catalog is **dubbed-content first**. Order of preference:
 *
 *   1. **Local Mongo cache of metas that already have streams**
 *      — i.e. titles a user has resolved before, so they're proven to have
 *      a PT-BR dub. This is the highest-signal source.
 *
 *   2. **TMDB "popular in Brazil"** (region=BR, language=pt-BR)
 *      — when TMDB_API_KEY is set, this surfaces region-relevant content
 *      with proper PT-BR titles and posters. Far better signal for a
 *      Brazilian audience than Cinemeta's global "Top" list.
 *
 *   3. **Cinemeta "Top"** — fallback for cold-start when neither (1) nor (2)
 *      are available.
 *
 * Search and genre filters cascade through the same waterfall.
 */
export async function handleCatalog(args: Args): Promise<{ metas: any[] }> {
    const metaDao = new MetaDAO();
    const skip = args.extra?.skip ? Number(args.extra.skip) : 0;
    const limit = 100;

    // Search
    if (args.extra?.search) {
        const local = await metaDao.getByName(args.extra.search, skip, limit);
        if (local.length > 0) return { metas: await filterToDubbed(local) };
        if (tmdbAvailable()) {
            const tmdb = await searchTmdb(args.extra.search, args.type as 'movie' | 'series');
            if (tmdb.length > 0) return { metas: tmdb };
        }
        return { metas: await fetchCinemetaCatalog(args.type, 'top', { search: args.extra.search }) };
    }

    // Genre filter
    if (args.extra?.genre) {
        const local = await metaDao.getByGenre(args.id, args.extra.genre, skip, limit);
        if (local.length > 0) return { metas: await filterToDubbed(local) };
        return { metas: await fetchCinemetaCatalog(args.type, 'top', { genre: args.extra.genre, skip }) };
    }

    // Default catalog
    const local = await metaDao.getByCatalogId(args.id, skip, limit);
    if (local.length > 0) {
        const dubbed = await filterToDubbed(local);
        if (dubbed.length > 0) return { metas: dubbed };
    }

    // No local hits yet — surface region-relevant titles for browsing
    if (tmdbAvailable()) {
        const page = Math.floor(skip / 20) + 1;
        const popular = await discoverPopularBR(args.type as 'movie' | 'series', page);
        if (popular.length > 0) return { metas: popular };
    }

    return { metas: await fetchCinemetaCatalog(args.type, 'top', { skip }) };
}

/**
 * Keep only metas with at least one persisted Stream (i.e. confirmed dubbed
 * content in our cache). Operates on a single Mongo round-trip via $in.
 */
async function filterToDubbed(metas: any[]): Promise<any[]> {
    if (metas.length === 0) return [];
    const ids = metas.map((m) => m.id).filter(Boolean);
    const withStreams = new Set(
        (await Stream.distinct('metaId', { metaId: { $in: ids } }).exec()) as string[]
    );
    return metas.filter((m) => withStreams.has(m.id));
}

interface CinemetaMetaPreview {
    id: string;
    type: string;
    name: string;
    poster?: string;
    background?: string;
    description?: string;
}

async function fetchCinemetaCatalog(
    type: string,
    catalogId: string,
    opts: { search?: string; genre?: string; skip?: number } = {}
): Promise<CinemetaMetaPreview[]> {
    const extras: string[] = [];
    if (opts.search) extras.push(`search=${encodeURIComponent(opts.search)}`);
    if (opts.genre) extras.push(`genre=${encodeURIComponent(opts.genre)}`);
    if (opts.skip) extras.push(`skip=${opts.skip}`);
    const suffix = extras.length > 0 ? `/${extras.join('&')}.json` : '.json';
    const url = `${CINEMETA_BASE}/catalog/${type}/${catalogId}${suffix}`;
    try {
        const res = await axios.get(url, { timeout: 6000, headers: UA });
        return Array.isArray(res.data?.metas) ? res.data.metas : [];
    } catch (err: any) {
        console.error(`[catalog] cinemeta fallback failed (${url}): ${err.message || err}`);
        return [];
    }
}
