/**
 * In-memory circuit breaker per provider name.
 *
 * After N consecutive failures, the provider is short-circuited (returns
 * empty without invoking the underlying call) for COOLDOWN_MS. This keeps
 * a sick upstream from making every request pay the timeout penalty.
 *
 * Lives in module scope, so it's process-local. On Vercel serverless that
 * means each warm function instance has its own breaker — good enough to
 * absorb burst failures within a single invocation cluster.
 *
 * Inspired by GuickerZ/guindex.
 */

const FAILURE_THRESHOLD = parseInt(process.env.BREAKER_FAILURE_THRESHOLD || '2', 10);
const COOLDOWN_MS = parseInt(process.env.BREAKER_COOLDOWN_MS || `${15 * 60 * 1000}`, 10);

interface BreakerState {
    failures: number;
    openedAt: number; // 0 when closed
}

const states = new Map<string, BreakerState>();

function getState(name: string): BreakerState {
    let s = states.get(name);
    if (!s) {
        s = { failures: 0, openedAt: 0 };
        states.set(name, s);
    }
    return s;
}

/**
 * Wrap a provider call. When the breaker is open, returns an empty array
 * immediately without invoking `fn`. Otherwise runs `fn`; on rejection or
 * empty result the failure counter is bumped, on success it resets.
 *
 * "Empty result" is treated as a soft failure — a provider returning [] for
 * many distinct queries usually means it's broken, not that no content
 * exists. This is intentional.
 */
export async function withBreaker<T>(
    name: string,
    fn: () => Promise<T[]>
): Promise<T[]> {
    const s = getState(name);

    if (s.openedAt > 0) {
        const elapsed = Date.now() - s.openedAt;
        if (elapsed < COOLDOWN_MS) {
            console.log(`[breaker:${name}] short-circuit (open for ${Math.floor(elapsed / 1000)}s)`);
            return [];
        }
        // Cooldown elapsed — half-open: let one request through to probe
        s.openedAt = 0;
        s.failures = 0;
        console.log(`[breaker:${name}] half-open, probing`);
    }

    try {
        const result = await fn();
        if (result.length === 0) {
            s.failures++;
            if (s.failures >= FAILURE_THRESHOLD) {
                s.openedAt = Date.now();
                console.warn(`[breaker:${name}] OPENED after ${s.failures} empty/failed responses`);
            }
            return result;
        }
        // Success — reset
        if (s.failures > 0) {
            console.log(`[breaker:${name}] recovered (had ${s.failures} failures)`);
        }
        s.failures = 0;
        s.openedAt = 0;
        return result;
    } catch (err) {
        s.failures++;
        if (s.failures >= FAILURE_THRESHOLD) {
            s.openedAt = Date.now();
            console.warn(`[breaker:${name}] OPENED after error: ${err}`);
        }
        throw err;
    }
}

/**
 * Diagnostic helper for /status.
 */
export function getBreakerStates(): Array<{ name: string; failures: number; openFor?: number }> {
    const out: Array<{ name: string; failures: number; openFor?: number }> = [];
    for (const [name, s] of states) {
        const openFor = s.openedAt > 0 ? Math.floor((Date.now() - s.openedAt) / 1000) : undefined;
        out.push({ name, failures: s.failures, openFor });
    }
    return out;
}
