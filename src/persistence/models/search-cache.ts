import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Short-lived cache for upstream provider responses, keyed by streamId.
 *
 * The DB also caches the *individual* streams in the Stream collection
 * (long-lived, 7d-effective for seeders refresh). This collection memoizes
 * the *aggregated provider response* to avoid hitting upstreams repeatedly
 * when many Stremio clients ask for the same id within minutes.
 *
 * TTL is enforced by a MongoDB TTL index on `expiresAt`.
 */
export interface ISearchCache extends Document {
    streamId: string;
    payload: any;
    expiresAt: Date;
}

const SearchCacheSchema: Schema = new Schema({
    streamId: { type: 'String', required: true, unique: true, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    expiresAt: { type: 'Date', required: true, index: { expires: 0 } }
});

const SearchCache: Model<ISearchCache> =
    (mongoose.models.SearchCache as Model<ISearchCache>) ||
    mongoose.model<ISearchCache>('SearchCache', SearchCacheSchema);

export default SearchCache;
