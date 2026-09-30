/**
 * Volume Profile (ARCHITECTURE.md §6A). Distributes each bar's volume across the
 * price buckets it spans, then derives the Point of Control and Value Area.
 * From OHLCV this is an approximation (uniform spread across the bar's range);
 * exact profiles need tick data. Pure + testable.
 */
import type { Bar } from '../model/bar';
import type { VolumeProfileResult } from './profile-model';
import { priceBuckets, valueArea } from './profile-model';

export interface VolumeProfileOptions {
  tickSize: number;
  /** Fraction of total volume contained in the value area (default 0.7). */
  valueAreaPercent: number;
}

export function computeVolumeProfile(
  bars: readonly Bar[],
  tickSize: number,
  valueAreaPercent = 0.7,
): VolumeProfileResult {
  const vol = new Map<number, number>();
  for (const bar of bars) {
    const buckets = priceBuckets(bar.low, bar.high, tickSize);
    const share = (bar.volume ?? 0) / buckets.length;
    for (const b of buckets) vol.set(b, (vol.get(b) ?? 0) + share);
  }
  const buckets = Array.from(vol.entries())
    .map(([price, volume]) => ({ price, volume }))
    .sort((a, b) => b.price - a.price);

  if (buckets.length === 0) {
    return { buckets, poc: 0, vah: 0, val: 0, totalVolume: 0 };
  }

  const total = buckets.reduce((s, b) => s + b.volume, 0);
  // `valueArea` hands back indices into `buckets`, which is not empty.
  const va = valueArea(buckets.map((b) => b.volume), total * valueAreaPercent);
  return {
    buckets,
    poc: buckets[va.poc]!.price,
    vah: buckets[va.upper]!.price,
    val: buckets[va.lower]!.price,
    totalVolume: total,
  };
}
