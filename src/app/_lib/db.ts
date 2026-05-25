import { connect } from '../../config';

let ready: Promise<string> | null = null;

/**
 * Lazy DB connector for Next.js route handlers.
 * Returns the same in-flight connection promise across concurrent invocations.
 */
export async function ensureDb(): Promise<void> {
    if (!ready) ready = connect();
    await ready;
}
