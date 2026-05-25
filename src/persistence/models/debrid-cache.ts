import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Cache for Debrid resolution outcomes per (infoHash, provider).
 *
 * Why we need this:
 *   - RD deprecated /torrents/instantAvailability; the only reliable way to
 *     test cache is to actually addMagnet+selectFiles, which costs API
 *     budget and adds latency to every stream request.
 *   - Same content gets requested many times (Stremio re-fetches on every
 *     focus, every "Resume" click, multiple devices, etc.).
 *
 * The TTL is short because RD's cache state changes: a torrent uncached
 * today may be cached tomorrow once another user pulls it down.
 *
 * `url` is intentionally NOT cached — Real-Debrid links are tied to an IP
 * + expire in ~1h. We only cache the boolean and the filename/filesize.
 */
export interface IDebridCache extends Document {
    key: string;             // `${provider}:${infoHash}` — unique
    cached: boolean;
    filename?: string;
    filesize?: number;
    expiresAt: Date;
}

const DebridCacheSchema: Schema = new Schema({
    key: { type: 'String', required: true, unique: true, index: true },
    cached: { type: 'Boolean', required: true },
    filename: { type: 'String' },
    filesize: { type: 'Number' },
    expiresAt: { type: 'Date', required: true, index: { expires: 0 } }
});

const DebridCache: Model<IDebridCache> =
    (mongoose.models.DebridCache as Model<IDebridCache>) ||
    mongoose.model<IDebridCache>('DebridCache', DebridCacheSchema);

export default DebridCache;
