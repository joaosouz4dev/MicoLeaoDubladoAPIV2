/**
 * Normalized shape every stream provider should return.
 * Aggregator dedupes by infoHash and writes back to the DB.
 */
export interface NormalizedStream {
    title: string;
    infoHash: string;
    sources: string[];
    seeders: number;
    size?: number;
    provider: string;
    languages?: string[];
}
