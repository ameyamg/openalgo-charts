/** An index read the compiler cannot prove is in range: an error under noUncheckedIndexedAccess only. */
export function first(values: readonly number[]): number {
  return values[0];
}
