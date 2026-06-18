/** Coerce an unknown arg to an integer within [min, max], falling back to `dflt`. */
export function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
