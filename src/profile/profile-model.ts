/**
 * Profile data model (ARCHITECTURE.md §6A, Family C). Price-bucketed
 * distributions: volume-at-price, time-at-price (TPO), and bid/ask footprint.
 */
export interface VolumeProfileResult {
  /** Volume per price bucket, sorted high → low price. */
  buckets: { price: number; volume: number }[];
  /** Point of control: price bucket with the most volume. */
  poc: number;
  /** Value-area high / low (the price band holding `valueAreaPercent` of volume). */
  vah: number;
  val: number;
  totalVolume: number;
}

export interface TpoResult {
  buckets: { price: number; count: number }[];
  poc: number;
  vah: number;
  val: number;
  /** Initial balance: price range of the first `ibPeriods` periods. */
  ib: { high: number; low: number };
}

export interface FootprintCell {
  price: number;
  bidVol: number;
  askVol: number;
}

export interface FootprintBar {
  time: number;
  cells: FootprintCell[]; // sorted high → low price
  /** Net delta = Σ(askVol − bidVol). */
  delta: number;
  /** Lowest/highest running trade delta within this bar, including initial zero.
   * Absent when only aggregated price rows are available. */
  minDelta?: number;
  maxDelta?: number;
  /** Effective ladder step: instrument tick size multiplied by rowTicks. */
  rowSize?: number;
  /** Actual traded prices, before ladder rounding. Absent for empty/legacy bars. */
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  /** Number of classified trade records, not the number of occupied rows. */
  tradeCount?: number;
}

/** Bucket a price to the tick grid. */
export function bucketPrice(price: number, step: number): number {
  return Math.round((Math.round(price / step) * step) * 1e8) / 1e8;
}

/**
 * Inclusive list of bucket prices spanning [low, high]. A step that is not a
 * positive finite number gives no buckets.
 */
export function priceBuckets(low: number, high: number, step: number): number[] {
  // A negative step would walk away from `high` and never stop.
  if (!(step > 0) || step === Infinity) return [];
  const lo = bucketPrice(low, step);
  const hi = bucketPrice(high, step);
  const out: number[] = [];
  for (let p = lo; p <= hi + step / 2; p += step) out.push(bucketPrice(p, step));
  return out;
}
