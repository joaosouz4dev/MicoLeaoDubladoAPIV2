import MetaDAO from './meta-dao';
import { IMeta } from '../models/meta';
import { Args } from '../models/stremio';

/**
 * Catalog request handler — extracted from the legacy addon.ts so Next.js routes
 * can call it directly without the stremio-addon-sdk addonBuilder.
 */
export async function handleCatalog(args: Args): Promise<{ metas: IMeta[] }> {
    const metaDao = new MetaDAO();
    const skip = args.extra?.skip ? Number(args.extra.skip) : 0;
    const limit = 100;
    if (args.extra?.search) {
        return { metas: await metaDao.getByName(args.extra.search, skip, limit) };
    }
    if (args.type === 'movie') {
        if (args.extra?.genre) {
            return { metas: await metaDao.getByGenre(args.id, args.extra.genre, skip, limit) };
        }
        return { metas: await metaDao.getByCatalogId(args.id, skip, limit) };
    }
    return { metas: [] };
}
