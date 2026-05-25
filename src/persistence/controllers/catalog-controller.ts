import axios from 'axios';
import MetaDAO from './meta-dao';
import { IMeta } from '../models/meta';
import { Args } from '../models/stremio';

const CINEMETA_BASE = process.env.CINEMETA_BASE || 'https://v3-cinemeta.strem.io';
const UA = { 'User-Agent': 'Stremio/4.4.x (MicoLeaoDubladoAPIV2)' };

/**
 * Catalog request handler — extracted from the legacy addon.ts so Next.js routes
 * can call it directly without the stremio-addon-sdk addonBuilder.
 *
 * When the local catalog is empty (fresh install, no streams cached yet), falls
 * back to Cinemeta's "Top" catalog so users see something meaningful and can
 * trigger stream lookups that warm both the meta and stream caches.
 */
export async function handleCatalog(args: Args): Promise<{ metas: any[] }> {
    const metaDao = new MetaDAO();
    const skip = args.extra?.skip ? Number(args.extra.skip) : 0;
    const limit = 100;

    if (args.extra?.search) {
        const local = await metaDao.getByName(args.extra.search, skip, limit);
        if (local.length > 0) return { metas: local };
        return { metas: await fetchCinemetaCatalog(args.type, 'top', { search: args.extra.search }) };
    }

    if (args.extra?.genre) {
        const local = await metaDao.getByGenre(args.id, args.extra.genre, skip, limit);
        if (local.length > 0) return { metas: local };
        return { metas: await fetchCinemetaCatalog(args.type, 'top', { genre: args.extra.genre, skip }) };
    }

    const local = await metaDao.getByCatalogId(args.id, skip, limit);
    if (local.length > 0) return { metas: local };

    // Empty cache — proxy Cinemeta's "Top" catalog (movies or series) so the
    // addon shows useful content. Subsequent /stream lookups will warm both
    // the meta and stream caches.
    return { metas: await fetchCinemetaCatalog(args.type, 'top', { skip }) };
}

interface CinemetaMetaPreview {
    id: string;
    type: string;
    name: string;
    poster?: string;
    background?: string;
    description?: string;
}

/**
 * Fetch a Cinemeta catalog (e.g. /catalog/movie/top.json) optionally filtered by
 * search/genre/skip. Returns the metas array, never null.
 */
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
        const metas = res.data?.metas;
        return Array.isArray(metas) ? metas : [];
    } catch (err: any) {
        console.error(`[catalog] cinemeta fallback failed (${url}): ${err.message || err}`);
        return [];
    }
}
