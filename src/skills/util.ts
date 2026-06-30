/** Coerce an unknown arg to an integer within [min, max], falling back to `dflt`. */
export function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** Thrown by `withTimeout` when `ms` elapses before `promise` settles. */
export class TimeoutError extends Error {}

/**
 * Races `promise` against a timer. mineflayer-pathfinder can get stuck recomputing partial
 * paths forever when no complete route to a target exists (a known upstream behavior, not an
 * error it throws) — without a hard ceiling here, that hangs the awaiting skill, and with it
 * the whole agent loop, indefinitely with no result ever reported back to the LLM. Rejects
 * with `TimeoutError` instead so the caller can treat it as an ordinary failure and retry/move
 * on, the same way it already handles any other rejection.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
