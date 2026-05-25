/**
 * Cinemeta proxy.
 *
 * Cinemeta is Stremio's official metadata addon. We use it to look up Meta records
 * for IMDb ids we haven't seen before, so the local catalog grows whenever a user
 * resolves a stream for a new title.
 *
 * Reference: https://v3-cinemeta.strem.io/manifest.json
 */
import axios from 'axios';
import Meta, { IMeta } from '../models/meta';
import { enrichFromTmdb } from './tmdb';

const CINEMETA_BASE = process.env.CINEMETA_BASE || 'https://v3-cinemeta.strem.io';
const DEFAULT_CATALOG = 'BrazilianCatalog';

interface CinemetaMeta {
    id: string;
    type: string;
    name: string;
    poster?: string;
    background?: string;
    logo?: string;
    description?: string;
    releaseInfo?: string;
    imdbRating?: string;
    runtime?: string;
    genres?: string[];
}

/**
 * Fetch a meta record from Cinemeta. Returns null if not found.
 */
export async function fetchCinemeta(type: 'movie' | 'series', imdbId: string): Promise<CinemetaMeta | null> {
    const url = `${CINEMETA_BASE}/meta/${type}/${encodeURIComponent(imdbId)}.json`;
    try {
        const res = await axios.get(url, {
            timeout: 6000,
            headers: { 'User-Agent': 'Stremio/4.4.x (MicoLeaoDubladoAPIV2)' }
        });
        return res.data?.meta || null;
    } catch (err: any) {
        console.error(`[cinemeta] fetch failed (${url}): ${err.message || err}`);
        return null;
    }
}

/**
 * Fetch a meta from Cinemeta and persist it locally if absent.
 * Idempotent: if the meta already exists in our DB, do nothing.
 *
 * Returned value is the local DB row (existing or newly inserted), or null on
 * any failure (Cinemeta unreachable, etc.).
 */
export async function ensureMetaCached(type: 'movie' | 'series', imdbId: string): Promise<IMeta | null> {
    try {
        const existing = await Meta.findOne({ id: imdbId }).exec();
        if (existing) return existing as IMeta;

        const cm = await fetchCinemeta(type, imdbId);
        if (!cm) return null;

        // PT-BR enrichment (best-effort): name + description override + poster fallback
        const tmdb = await enrichFromTmdb(imdbId, type);

        const doc = new Meta({
            id: cm.id,
            type: cm.type,
            name: tmdb?.name || cm.name,
            poster: cm.poster || tmdb?.poster,
            background: cm.background || tmdb?.background,
            logo: cm.logo,
            description: tmdb?.description || cm.description,
            releaseInfo: cm.releaseInfo,
            imdbRating: cm.imdbRating ? parseFloat(cm.imdbRating) : undefined,
            runtime: cm.runtime,
            genres: cm.genres || [],
            catalogs: [type === 'movie' ? 'MicoFilmes' : 'MicoSeries']
        });
        await doc.save();
        return doc as IMeta;
    } catch (err) {
        console.error(`[cinemeta] cache failed for ${imdbId}: ${err}`);
        return null;
    }
}
