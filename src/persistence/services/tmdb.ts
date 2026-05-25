/**
 * TMDB (The Movie Database) provider, PT-BR localized.
 *
 * Cinemeta provides metas in English. TMDB has proper Portuguese translations
 * (titles, synopses, posters) AND lets us discover region-relevant catalogs
 * (popular in Brazil, etc.).
 *
 * If TMDB_API_KEY is set in the environment, we use TMDB everywhere it helps:
 *   - enrichMeta: PT-BR name/description/poster overlay on a Cinemeta hit
 *   - discoverPopularBR: catalog of popular movies/series in Brazil
 *   - lookupTitles: best-effort PT-BR + original_title for a given IMDb id,
 *     so the indexer search can try both
 *
 * Reference: betorbr/betor-catalog
 */
import axios from 'axios';

const API_KEY = process.env.TMDB_API_KEY;
const BASE = 'https://api.themoviedb.org/3';
const UA = 'Mozilla/5.0 MicoLeaoV2';
const IMG_BASE = 'https://image.tmdb.org/t/p';

export interface TmdbEnrichment {
    name?: string;
    description?: string;
    poster?: string;
    background?: string;
}

export interface TmdbTitles {
    ptBr?: string;
    original?: string;
}

export function tmdbAvailable(): boolean {
    return !!API_KEY;
}

async function tmdbGet(path: string, params: Record<string, string> = {}): Promise<any | null> {
    if (!API_KEY) return null;
    const query = new URLSearchParams({ api_key: API_KEY, ...params }).toString();
    try {
        const res = await axios.get(`${BASE}${path}?${query}`, { timeout: 6000, headers: { 'User-Agent': UA } });
        return res.data;
    } catch (err: any) {
        console.error(`[tmdb] ${path}: ${err.message || err}`);
        return null;
    }
}

/**
 * Enrich a Meta with PT-BR localized fields.
 */
export async function enrichFromTmdb(
    imdbId: string,
    type: 'movie' | 'series'
): Promise<TmdbEnrichment | null> {
    const data = await tmdbGet(`/find/${encodeURIComponent(imdbId)}`, {
        external_source: 'imdb_id',
        language: 'pt-BR'
    });
    if (!data) return null;
    const bucket = type === 'movie' ? 'movie_results' : 'tv_results';
    const hit = data[bucket]?.[0];
    if (!hit) return null;
    return {
        name: hit.title || hit.name,
        description: hit.overview,
        poster: hit.poster_path ? `${IMG_BASE}/w500${hit.poster_path}` : undefined,
        background: hit.backdrop_path ? `${IMG_BASE}/original${hit.backdrop_path}` : undefined
    };
}

/**
 * Return PT-BR and original titles for a given IMDb id, so the indexer can try both.
 */
export async function lookupTitles(imdbId: string, type: 'movie' | 'series'): Promise<TmdbTitles> {
    const data = await tmdbGet(`/find/${encodeURIComponent(imdbId)}`, {
        external_source: 'imdb_id',
        language: 'pt-BR'
    });
    if (!data) return {};
    const bucket = type === 'movie' ? 'movie_results' : 'tv_results';
    const hit = data[bucket]?.[0];
    if (!hit) return {};
    return {
        ptBr: hit.title || hit.name,
        original: hit.original_title || hit.original_name
    };
}

/**
 * Discover popular movies or series in Brazil (region=BR, in pt-BR).
 * Returns Cinemeta-shaped meta previews so the catalog handler can serve
 * them directly. Each entry has imdb_id (when TMDB knows it).
 */
export async function discoverPopularBR(
    type: 'movie' | 'series',
    page = 1
): Promise<any[]> {
    const path = type === 'movie' ? '/discover/movie' : '/discover/tv';
    const data = await tmdbGet(path, {
        language: 'pt-BR',
        region: 'BR',
        sort_by: 'popularity.desc',
        page: String(page)
    });
    if (!data?.results) return [];

    // Each TMDB entry needs the IMDb id (Stremio uses tt-prefixed ids).
    // /find returns this in external_ids; we batch via /<type>/<id>/external_ids.
    const enriched = await Promise.all(
        data.results.slice(0, 50).map(async (r: any) => {
            const ext = await tmdbGet(`/${type === 'movie' ? 'movie' : 'tv'}/${r.id}/external_ids`);
            const imdbId = ext?.imdb_id;
            if (!imdbId) return null;
            return {
                id: imdbId,
                imdb_id: imdbId,
                type,
                name: r.title || r.name,
                poster: r.poster_path ? `${IMG_BASE}/w500${r.poster_path}` : undefined,
                background: r.backdrop_path ? `${IMG_BASE}/original${r.backdrop_path}` : undefined,
                description: r.overview,
                releaseInfo: (r.release_date || r.first_air_date || '').slice(0, 4),
                imdbRating: r.vote_average ? r.vote_average.toFixed(1) : undefined
            };
        })
    );
    return enriched.filter((m: any) => m !== null);
}

/**
 * Search TMDB for titles matching a free-text query (pt-BR). Returns Stremio
 * meta previews.
 */
export async function searchTmdb(
    query: string,
    type: 'movie' | 'series'
): Promise<any[]> {
    const path = type === 'movie' ? '/search/movie' : '/search/tv';
    const data = await tmdbGet(path, {
        query,
        language: 'pt-BR',
        region: 'BR'
    });
    if (!data?.results) return [];
    const enriched = await Promise.all(
        data.results.slice(0, 30).map(async (r: any) => {
            const ext = await tmdbGet(`/${type === 'movie' ? 'movie' : 'tv'}/${r.id}/external_ids`);
            const imdbId = ext?.imdb_id;
            if (!imdbId) return null;
            return {
                id: imdbId,
                imdb_id: imdbId,
                type,
                name: r.title || r.name,
                poster: r.poster_path ? `${IMG_BASE}/w500${r.poster_path}` : undefined,
                background: r.backdrop_path ? `${IMG_BASE}/original${r.backdrop_path}` : undefined,
                description: r.overview
            };
        })
    );
    return enriched.filter((m: any) => m !== null);
}
