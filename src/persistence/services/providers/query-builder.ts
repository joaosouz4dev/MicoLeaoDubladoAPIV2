/**
 * Build a list of candidate search queries for a given Stremio id.
 *
 * BR indexers don't typically support IMDb id lookups, so we have to query by
 * title. The exact wording varies by source (some use the PT-BR title, some
 * the original, some include the year, etc.) — generating multiple variants
 * dramatically increases hit rate at trivial cost.
 *
 * Inspired by GuickerZ/guindex.
 */

export interface QueryContext {
    ptBr?: string;
    original?: string;
    year?: string;
    season?: number;
    episode?: number;
}

/**
 * Build up to ~12 query variants from the available title fields, ordered
 * by expected hit probability (most specific first, broader last).
 *
 * For series, "S01E05" and "1ª temporada" / "temporada 1" / "T01" patterns
 * are emitted so we cover both formal release group naming and informal
 * Brazilian forum naming.
 *
 * Duplicates and empty strings are filtered out.
 */
export function buildQueryVariants(ctx: QueryContext): string[] {
    const variants: string[] = [];
    const titles = [ctx.ptBr, ctx.original]
        .map((t) => t?.trim())
        .filter((t): t is string => !!t);

    if (ctx.season != null && ctx.episode != null) {
        const s = pad(ctx.season);
        const e = pad(ctx.episode);
        const sNum = ctx.season;
        for (const t of titles) {
            variants.push(`${t} S${s}E${e}`);          // "Dark S01E05"
            variants.push(`${t} ${s}x${e}`);            // "Dark 01x05"
            variants.push(`${t} temporada ${sNum}`);    // "Dark temporada 1"
            variants.push(`${t} T${s}`);                // "Dark T01"
            variants.push(t);                            // bare title as last resort
        }
    } else if (ctx.season != null) {
        const s = pad(ctx.season);
        for (const t of titles) {
            variants.push(`${t} S${s}`);
            variants.push(`${t} temporada ${ctx.season}`);
            variants.push(t);
        }
    } else {
        for (const t of titles) {
            if (ctx.year) variants.push(`${t} ${ctx.year}`);
            variants.push(t);
        }
    }

    // Dedupe (case-insensitive), preserve order, trim
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of variants) {
        const k = v.replace(/\s+/g, ' ').trim();
        if (!k) continue;
        const key = k.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(k);
    }
    return out;
}

function pad(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}
