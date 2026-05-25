/**
 * Environment configuration and MongoDB connection helper.
 *
 * The connection is cached on globalThis so that serverless invocations (Vercel)
 * reuse the same connection across function calls instead of opening a new one
 * per request.
 */
import mongoose from 'mongoose';

export const PORT = process.env.PORT || 3000;
export const DB_HOST = process.env.DB_HOST || "localhost";
export const DB_PORT = process.env.DB_PORT || 27017;
export const DB_NAME = process.env.DB_NAME || "brazilian-addon-db";
const DB_USER = process.env.DB_USER;
const DB_PSK = process.env.DB_PSK;
const MONGODB_URI = process.env.MONGODB_URI;

interface MongoCache {
    conn: typeof mongoose | null;
    promise: Promise<typeof mongoose> | null;
}

const globalForMongo = globalThis as unknown as { _mongoCache?: MongoCache };
const cache: MongoCache = globalForMongo._mongoCache || { conn: null, promise: null };
globalForMongo._mongoCache = cache;

function buildUri(): { primary: string; fallback?: string } {
    if (MONGODB_URI) return { primary: MONGODB_URI };
    let credentials = "";
    if (DB_USER && DB_PSK) credentials = `${DB_USER}:${DB_PSK}@`;
    return {
        primary: `mongodb+srv://${credentials}${DB_HOST}:/${DB_NAME}`,
        fallback: `mongodb://${credentials}${DB_HOST}:${DB_PORT}/${DB_NAME}`
    };
}

/**
 * Connect to MongoDB. Reuses an existing connection across serverless invocations.
 * Tries the SRV URI first, then falls back to a standard mongodb:// URI when
 * MONGODB_URI is not explicitly provided.
 */
export async function connect(): Promise<string> {
    if (cache.conn) return cache.conn.connection.host;

    const { primary, fallback } = buildUri();
    if (!cache.promise) {
        cache.promise = mongoose.connect(primary).catch(async (err) => {
            if (!fallback) throw err;
            return mongoose.connect(fallback);
        });
    }
    cache.conn = await cache.promise;
    return cache.conn.connection.host;
}
