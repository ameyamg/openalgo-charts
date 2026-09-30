/** The same unchecked read in a base directory, which must count against the base, not the profile tier. */
export function last(values: readonly number[]): number {
  return values[values.length - 1];
}
