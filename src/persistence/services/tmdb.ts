/**
 * TMDB (The Movie Database) provider, PT-BR localized.
 *
 * Cinemeta provides metas in English. TMDB has proper Portuguese translations
 * (titles, synopses, posters). If TMDB_API_KEY is set in the environment, we
 * enrich Meta records with `name` (PT-BR) and `description` (PT-BR).
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

/**
 * Look up an IMDb id on TMDB and return the PT-BR translated fields.
 * Returns null when TMDB_API_KEY isn't configured or the title isn't on TMDB.
 */
export async function enrichFromTmdb(
    imdbId: string,
    type: 'movie' | 'series'
): Promise<TmdbEnrichment | null> {
    if (!API_KEY) return null;
    try {
        const findUrl = `${BASE}/find/${encodeURIComponent(imdbId)}?api_key=${API_KEY}&external_source=imdb_id&language=pt-BR`;
        const findRes = await axios.get(findUrl, { timeout: 5000, headers: { 'User-Agent': UA } });
        const bucket = type === 'movie' ? 'movie_results' : 'tv_results';
        const hit = findRes.data?.[bucket]?.[0];
        if (!hit) return null;
        return {
            name: hit.title || hit.name,
            description: hit.overview,
            poster: hit.poster_path ? `${IMG_BASE}/w500${hit.poster_path}` : undefined,
            background: hit.backdrop_path ? `${IMG_BASE}/original${hit.backdrop_path}` : undefined
        };
    } catch (err: any) {
        console.error(`[tmdb] enrich failed for ${imdbId}: ${err.message || err}`);
        return null;
    }
}
