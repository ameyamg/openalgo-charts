/**
 * The runtime's side of a study's `calcTail`: the tail returns values for the
 * bars from its first index on, and the instance lays them over the result it
 * already holds for the bars before it.
 */
import type { IndicatorValues } from './indicator-registry';

/**
 * Overlay a `calcTail` result (values for `[from, n)`) onto the previous full
 * result. Any key the tail omits, or a previous column of the wrong length,
 * forces the caller back to a full recompute by returning `null`.
 */
export function spliceTail(
  previous: IndicatorValues,
  tail: IndicatorValues,
  from: number,
  n: number,
): IndicatorValues | null {
  const out: Record<string, (number | null)[]> = {};
  for (const key of Object.keys(tail)) {
    const prev = previous[key];
    const add = tail[key];
    if (prev === undefined || add === undefined) return null;
    if (add.length !== n - from) return null;
    const col = new Array<number | null>(n);
    for (let i = 0; i < from; i++) col[i] = prev[i] ?? null;
    for (let i = from; i < n; i++) col[i] = add[i - from] ?? null;
    out[key] = col;
  }
  return out;
}
