/**
 * Footprint & order flow (ARCHITECTURE.md §6A, Family C). Per-candle bid/ask
 * volume at each price, delta, and imbalance — plus cumulative delta and
 * stacked-imbalance detection across bars.
 *
 * DATA DEPENDENCY (honest): this needs trade-by-trade data classified bid/ask
 * (was each print at the bid or the ask?). OpenAlgo serves live depth + tick LTP
 * but does not store historical classified trades by default, so footprint is
 * either live-session-only or needs a tick-recorder backend. The computation
 * here is pure and broker-agnostic; feeding it is the integration step.
 */
import type { FootprintBar, FootprintCell } from './profile-model';
import { bucketPrice } from './profile-model';

export interface ClassifiedTrade {
  price: number;
  qty: number;
  /** Whether the print hit the bid (sell-initiated) or the ask (buy-initiated). */
  side: 'bid' | 'ask';
}

/**
 * Build one bar's footprint from its classified trades.
 *
 * `rowTicks` is the same multiplier the market profile uses: rows are
 * `tickSize * rowTicks` tall, so a trader can widen bricks without pretending
 * the instrument has a coarser tick. Nifty at 0.1 with 2-point bricks is
 * `computeFootprint(t, trades, 0.1, 20)`.
 */
export function computeFootprint(
  time: number,
  trades: readonly ClassifiedTrade[],
  tickSize: number,
  rowTicks = 1,
): FootprintBar {
  const row = footprintRowSize(tickSize, rowTicks);
  if (!Number.isFinite(time)) throw new RangeError('Footprint time must be finite');
  for (const trade of trades) validateClassifiedTrade(trade);
  const map = new Map<number, FootprintCell>();
  let delta = 0, minDelta = 0, maxDelta = 0;
  for (const t of trades) {
    const price = bucketPrice(t.price, row);
    let cell = map.get(price);
    if (cell === undefined) { cell = { price, bidVol: 0, askVol: 0 }; map.set(price, cell); }
    if (t.side === 'bid') { cell.bidVol += t.qty; delta -= t.qty; }
    else { cell.askVol += t.qty; delta += t.qty; }
    minDelta = Math.min(minDelta, delta);
    maxDelta = Math.max(maxDelta, delta);
  }
  const cells = Array.from(map.values()).sort((a, b) => b.price - a.price);
  const bar: FootprintBar = { time, cells, delta, minDelta, maxDelta, rowSize: row, tradeCount: trades.length };
  if (trades.length > 0) {
    bar.open = trades[0]!.price;
    bar.close = trades[trades.length - 1]!.price;
    bar.high = bar.low = trades[0]!.price;
    for (const trade of trades) {
      bar.high = Math.max(bar.high, trade.price);
      bar.low = Math.min(bar.low, trade.price);
    }
  }
  return bar;
}

export interface Imbalance {
  price: number;
  side: 'buy' | 'sell';
}

/** Internal shared validation for batch and streaming footprints. */
export function footprintRowSize(tickSize: number, rowTicks: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) throw new RangeError('Footprint tickSize must be positive and finite');
  if (!Number.isSafeInteger(rowTicks) || rowTicks < 1) throw new RangeError('Footprint rowTicks must be a positive integer');
  const row = tickSize * rowTicks;
  if (!Number.isFinite(row)) throw new RangeError('Footprint tickSize * rowTicks must be finite');
  return row;
}

/** Internal shared validation; zero quantity is allowed and still counts as a record. */
export function validateClassifiedTrade(trade: ClassifiedTrade): void {
  if (!Number.isFinite(trade.price)) throw new RangeError('Footprint trade price must be finite');
  if (!Number.isFinite(trade.qty) || trade.qty < 0) throw new RangeError('Footprint trade qty must be nonnegative and finite');
  if (trade.side !== 'bid' && trade.side !== 'ask') throw new TypeError('Footprint trade side must be bid or ask');
}

function observedRowSize(cells: readonly FootprintCell[]): number {
  let row = Infinity;
  for (let i = 1; i < cells.length; i++) {
    const gap = cells[i - 1]!.price - cells[i]!.price;
    if (gap > 0) row = Math.min(row, gap);
  }
  return row;
}

function adjacent(upper: number, lower: number, row: number): boolean {
  const tolerance = Math.max(row * 1e-7, Math.max(Math.abs(upper), Math.abs(lower)) * Number.EPSILON * 8);
  return Number.isFinite(row) && upper > lower && Math.abs(upper - lower - row) <= tolerance;
}

/**
 * Diagonal imbalances compare ask at P with bid one row below, and bid at P
 * with ask one row above. Missing rows are never bridged or synthesized.
 * Supply rowSize for sparse ladders; legacy callers infer the minimum observed
 * gap, which cannot distinguish uniformly missing rows from a coarser grid.
 * Positive volume against a zero opposing volume is an imbalance; zero against
 * zero is not. threshold is the minimum dominant-side quantity (inclusive).
 */
export function diagonalImbalances(cells: readonly FootprintCell[], ratio = 3, rowSize?: number, threshold = 0): Imbalance[] {
  if (!Number.isFinite(ratio) || ratio <= 0) throw new RangeError('Imbalance ratio must be positive and finite');
  if (rowSize !== undefined && (!Number.isFinite(rowSize) || rowSize <= 0)) throw new RangeError('Imbalance rowSize must be positive and finite');
  if (!Number.isFinite(threshold) || threshold < 0) throw new RangeError('Imbalance threshold must be nonnegative and finite');
  const sorted = [...cells].sort((a, b) => b.price - a.price);
  const row = rowSize ?? observedRowSize(sorted);
  const dominates = (volume: number, opposing: number): boolean => volume > 0 && volume >= threshold && volume >= ratio * opposing;
  const out: Imbalance[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const here = sorted[i]!;
    const below = sorted[i + 1];
    const above = sorted[i - 1];
    if (below && adjacent(here.price, below.price, row) && dominates(here.askVol, below.bidVol)) out.push({ price: here.price, side: 'buy' });
    if (above && adjacent(above.price, here.price, row) && dominates(here.bidVol, above.askVol)) out.push({ price: here.price, side: 'sell' });
  }
  return out;
}

/** Running cumulative delta across a sequence of footprint bars. */
export function cumulativeDelta(bars: readonly FootprintBar[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const b of bars) { acc += b.delta; out.push(acc); }
  return out;
}

export interface StackedImbalance {
  startPrice: number;
  endPrice: number;
  side: 'buy' | 'sell';
  count: number;
}

/** Runs of minStack+ adjacent diagonal imbalances, tracked independently per side. */
export function stackedImbalances(cells: readonly FootprintCell[], ratio = 3, minStack = 3, rowSize?: number, threshold = 0): StackedImbalance[] {
  if (!Number.isSafeInteger(minStack) || minStack < 1) throw new RangeError('Imbalance minStack must be a positive integer');
  const sorted = [...cells].sort((a, b) => b.price - a.price);
  const imb = diagonalImbalances(sorted, ratio, rowSize, threshold);
  const row = rowSize ?? observedRowSize(sorted);
  const out: StackedImbalance[] = [];
  for (const side of ['buy', 'sell'] as const) {
    const prices = new Set(imb.filter((entry) => entry.side === side).map((entry) => entry.price));
    let run: StackedImbalance | undefined;
    const finish = (): void => {
      if (run && run.count >= minStack) out.push(run);
      run = undefined;
    };
    for (const cell of sorted) {
      if (!prices.has(cell.price)) { finish(); continue; }
      if (run && !adjacent(run.endPrice, cell.price, row)) finish();
      if (run) { run.endPrice = cell.price; run.count++; }
      else run = { startPrice: cell.price, endPrice: cell.price, side, count: 1 };
    }
    finish();
  }
  return out.sort((a, b) => b.startPrice - a.startPrice);
}
