/**
 * A higher-timeframe view of the chart's own bars, one value per source bar.
 *
 * securitySeries aligns aggregate OHLC values. securityExpression calculates
 * on aggregate bars before alignment, so a rolling window counts requested
 * bars rather than repeated aligned values. securitySeries names its readings:
 *
 * - `offset: 0` (the default) reads the bucket **as it stood at that bar**:
 *   its open so far, high and low so far, the bar's own close, volume so far.
 *   It is what the live bar sees and it never uses a later bar.
 * - `offset: k` reads the bucket that completed `k` buckets before, held
 *   constant across the current one. The classic non-repainting reference,
 *   `close[1]` on the higher timeframe.
 * - `lookahead: true` reads the current bucket's **final** values on every one
 *   of its bars. It uses bars that had not happened yet, which is what the
 *   source it is porting did; it is here so that can be reproduced, not
 *   recommended.
 *
 * Buckets follow the chart's calendar: a day is a day in `timezone`, a week
 * starts on Monday there, and a sub-day interval is anchored to the epoch, or
 * to the session open when `session` is given, which is how an exchange cuts
 * its hourly bars.
 */
import {
  DEFAULT_TIMEZONE,
  IndicatorInputError,
  bucketStartOf,
  parseSessionSpec,
  resolveInterval,
  utcSecondsToZonedParts,
  zonedWallClockToUtcSeconds,
  zonedDayIndex,
  zonedWeekIndex,
  type Bar,
  type Bucketing,
  type IndicatorValues,
} from 'openalgo-charts';

export interface SecurityExpressionOptions {
  timezone?: string;
  session?: string;
  /**
   * confirmed (default) holds the previous observed bucket's result once the
   * next bucket starts. developing calculates with the current partial bucket.
   * lookahead aligns the current bucket's final result onto its earlier bars.
   */
  mode?: 'confirmed' | 'developing' | 'lookahead';
}

export interface SecurityOptions {
  /** The calendar the buckets are cut in. Defaults to the shipped default zone. */
  timezone?: string;
  /** Read each bucket's final values on all of its bars. Default false. */
  lookahead?: boolean;
  /** Read the bucket completed this many buckets ago. Default 0, the current one. */
  offset?: number;
  /**
   * A session window, `'0915-1530'`, that anchors sub-day buckets to the
   * session open instead of the epoch. Without it a 30-minute bucket on a
   * 09:15 open runs 09:00 to 09:30; with it, 09:15 to 09:45.
   */
  session?: string;
}

export interface SecuritySeries {
  open: (number | null)[];
  high: (number | null)[];
  low: (number | null)[];
  close: (number | null)[];
  /** Null on a bucket none of whose bars carried volume. */
  volume: (number | null)[];
  /**
   * Open interest as at the last source bar of the bucket, null where no bar in
   * it carried any. A level rather than a flow, so it is the latest reading and
   * never the sum the way `volume` is.
   */
  oi: (number | null)[];
  /** Time of the first source bar in the bucket being read, UTC seconds. */
  bucketStart: (number | null)[];
  /** True on the first source bar of each bucket. */
  isNew: boolean[];
}

interface Bucket {
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  oi: number | null;
}

const WEEK = 604800;
const DAY = 86400;

/**
 * The bucket a bar belongs to, as a number equal for every bar in it. Shared
 * with `./timeframe`, whose live tail has to cut a new bar exactly as the fold
 * that computed the held result cut the history.
 */
export function keyOf(b: Bucketing, time: number, zone: string, sessionStart: number | null): number {
  if (b.mode === 'calendar') return bucketStartOf(b, time, zone);
  if (b.mode !== 'interval') return time; // unreachable: refused before the loop
  const s = b.seconds;
  if (s % WEEK === 0) return Math.floor(zonedWeekIndex(time, zone) / (s / WEEK));
  if (s % DAY === 0) return Math.floor(zonedDayIndex(time, zone) / (s / DAY));
  if (sessionStart === null) return bucketStartOf(b, time);
  // Anchored to this day's session open. The day index keeps two days' buckets
  // apart, which a per-day floor alone would not.
  const date = utcSecondsToZonedParts(time, zone);
  const anchor = zonedWallClockToUtcSeconds(date.year, date.month, date.day,
    Math.floor(sessionStart / 60), sessionStart % 60, 0, zone);
  return zonedDayIndex(time, zone) * 1e6 + Math.floor((time - anchor) / s);
}

const finite = (v: number): boolean => Number.isFinite(v);

export function securitySeries(
  bars: readonly Bar[],
  interval: string,
  options: SecurityOptions = {},
): SecuritySeries {
  const zone = options.timezone ?? DEFAULT_TIMEZONE;
  const offset = Math.floor(options.offset ?? 0);
  if (!Number.isFinite(offset) || offset < 0) {
    throw new IndicatorInputError('securitySeries: offset must be zero or a positive count of buckets');
  }
  const lookahead = options.lookahead === true;
  const { bucketing } = resolveInterval(interval);
  if (bucketing.mode === 'ticks' || bucketing.mode === 'volume') {
    throw new IndicatorInputError(
      `securitySeries: "${interval}" closes on trade flow rather than the clock and cannot be folded from time bars`,
    );
  }
  let sessionStart: number | null = null;
  if (options.session !== undefined) {
    const spec = parseSessionSpec(options.session);
    if (spec === null) throw new IndicatorInputError(`securitySeries: cannot read session "${options.session}"`);
    sessionStart = spec.start;
  }

  const n = bars.length;
  const open = new Array<number | null>(n).fill(null);
  const high = new Array<number | null>(n).fill(null);
  const low = new Array<number | null>(n).fill(null);
  const close = new Array<number | null>(n).fill(null);
  const volume = new Array<number | null>(n).fill(null);
  const oi = new Array<number | null>(n).fill(null);
  const bucketStart = new Array<number | null>(n).fill(null);
  const isNew = new Array<boolean>(n).fill(false);
  if (n === 0) return { open, high, low, close, volume, oi, bucketStart, isNew };

  // One pass groups the bars, which are time-sorted, into contiguous buckets
  // and folds each bucket's final values. A second pass reads them out.
  const buckets: Bucket[] = [];
  const of = new Array<number>(n);
  let prevKey = NaN;
  for (let i = 0; i < n; i++) {
    const bar = bars[i];
    const key = keyOf(bucketing, bar.time, zone, sessionStart);
    if (i === 0 || key !== prevKey) {
      buckets.push({
        start: bar.time,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume === undefined ? null : bar.volume,
        oi: bar.oi === undefined ? null : bar.oi,
      });
      isNew[i] = true;
    } else {
      const k = buckets[buckets.length - 1];
      if (!finite(k.open) && finite(bar.open)) k.open = bar.open;
      if (finite(bar.high) && (!finite(k.high) || bar.high > k.high)) k.high = bar.high;
      if (finite(bar.low) && (!finite(k.low) || bar.low < k.low)) k.low = bar.low;
      if (finite(bar.close)) k.close = bar.close;
      if (bar.volume !== undefined) k.volume = (k.volume ?? 0) + bar.volume;
      // Replaced, not accumulated: see Bar.oi. The bucket's open interest is
      // the position as at its last bar.
      if (bar.oi !== undefined) k.oi = bar.oi;
    }
    of[i] = buckets.length - 1;
    prevKey = key;
  }

  let runHigh = NaN;
  let runLow = NaN;
  let runVolume: number | null = null;
  let runOi: number | null = null;
  for (let i = 0; i < n; i++) {
    const bar = bars[i];
    const bi = of[i];
    if (offset > 0) {
      const src = bi - offset;
      if (src < 0) continue;
      const k = buckets[src];
      open[i] = k.open; high[i] = k.high; low[i] = k.low; close[i] = k.close;
      volume[i] = k.volume; oi[i] = k.oi; bucketStart[i] = k.start;
      continue;
    }
    const k = buckets[bi];
    bucketStart[i] = k.start;
    if (lookahead) {
      open[i] = k.open; high[i] = k.high; low[i] = k.low; close[i] = k.close;
      volume[i] = k.volume; oi[i] = k.oi;
      continue;
    }
    if (isNew[i]) {
      runHigh = bar.high; runLow = bar.low;
      runVolume = bar.volume === undefined ? null : bar.volume;
      runOi = bar.oi === undefined ? null : bar.oi;
    } else {
      if (finite(bar.high) && (!finite(runHigh) || bar.high > runHigh)) runHigh = bar.high;
      if (finite(bar.low) && (!finite(runLow) || bar.low < runLow)) runLow = bar.low;
      if (bar.volume !== undefined) runVolume = (runVolume ?? 0) + bar.volume;
      // The developing bucket's open interest is the newest reading in it, on
      // the same level-not-flow rule the completed bucket follows.
      if (bar.oi !== undefined) runOi = bar.oi;
    }
    open[i] = k.open;
    high[i] = finite(runHigh) ? runHigh : null;
    low[i] = finite(runLow) ? runLow : null;
    close[i] = finite(bar.close) ? bar.close : null;
    volume[i] = runVolume;
    oi[i] = runOi;
  }
  return { open, high, low, close, volume, oi, bucketStart, isNew };
}

/**
 * Evaluate on aggregated bars first, then align named columns to source bars.
 * This differs from applying a rolling formula to already aligned OHLC values,
 * which counts each repeated requested value as another observation.
 *
 * The expression must be pure and causal, returning one value per requested
 * bar in each column. Confirmed and lookahead modes evaluate the folded history
 * once; developing mode evaluates every source prefix, with no future source
 * bars, so its cost includes one expression call per source bar. Completed
 * buckets are inferred only when the next observed bucket starts. Missing
 * buckets are not fabricated and the last bucket is never clock-confirmed.
 *
 * Supply bars finer than or equal to the requested interval. This function
 * cannot manufacture lower-timeframe observations from coarser source bars.
 * Source timestamps must increase strictly. Empty data returns {} without
 * invoking the expression. Non-finite expression results become null.
 */
export function securityExpression(
  bars: readonly Bar[], interval: string,
  expression: (bars: readonly Readonly<Bar>[]) => IndicatorValues,
  options: SecurityExpressionOptions = {},
): IndicatorValues {
  const mode = options.mode ?? 'confirmed';
  if (!['confirmed', 'developing', 'lookahead'].includes(mode)) throw new IndicatorInputError('securityExpression: invalid mode');
  const zone = options.timezone ?? DEFAULT_TIMEZONE;
  const { bucketing } = resolveInterval(interval);
  if (bucketing.mode !== 'interval' && bucketing.mode !== 'calendar') {
    throw new IndicatorInputError('securityExpression: requested interval must close on the clock');
  }
  const session = options.session === undefined ? undefined : parseSessionSpec(options.session);
  if (session === null) throw new IndicatorInputError('securityExpression: invalid session');
  if (bars.length === 0) return {};
  const folded: Readonly<Bar>[] = [];
  const indices: number[] = [];
  const out: IndicatorValues = {};
  let keys: string[] | undefined;
  let previousKey: number | undefined;
  let previousTime = -Infinity;
  const evaluate = (): IndicatorValues => {
    const result = expression(Object.freeze(folded.slice()));
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new IndicatorInputError('securityExpression: expression must return named columns');
    }
    const names = Object.keys(result);
    if (keys && (names.length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(result, key)))) {
      throw new IndicatorInputError('securityExpression: expression column keys must remain stable');
    }
    for (const key of names) {
      if (!Array.isArray(result[key]) || result[key].length !== folded.length) {
        throw new IndicatorInputError('securityExpression: expression column length must match requested bars');
      }
      if (!Object.prototype.hasOwnProperty.call(out, key)) Object.defineProperty(out, key, {
        value: new Array<number | null>(bars.length).fill(null), enumerable: true,
      });
    }
    keys = names;
    return result;
  };
  const write = (result: IndicatorValues, sourceIndex: number, requestedIndex: number): void => {
    for (const key of keys ?? []) {
      const value = result[key][requestedIndex];
      (out[key] as (number | null)[])[sourceIndex] = typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
  };
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!Number.isFinite(bar.time) || bar.time <= previousTime) {
      throw new IndicatorInputError('securityExpression: source times must be finite and strictly increasing');
    }
    previousTime = bar.time;
    const key = keyOf(bucketing, bar.time, zone, session?.start ?? null);
    if (key !== previousKey) folded.push(Object.freeze({ ...bar }));
    else {
      const old = folded[folded.length - 1];
      const next = { ...old };
      if (!finite(old.open) && finite(bar.open)) next.open = bar.open;
      if (finite(bar.high) && (!finite(old.high) || bar.high > old.high)) next.high = bar.high;
      if (finite(bar.low) && (!finite(old.low) || bar.low < old.low)) next.low = bar.low;
      if (finite(bar.close)) next.close = bar.close;
      if (bar.volume !== undefined) next.volume = (old.volume ?? 0) + bar.volume;
      if (bar.oi !== undefined) next.oi = bar.oi;
      folded[folded.length - 1] = Object.freeze(next);
    }
    previousKey = key;
    indices.push(folded.length - 1);
    if (mode === 'developing') write(evaluate(), i, folded.length - 1);
  }
  if (mode !== 'developing') {
    const result = evaluate();
    for (let i = 0; i < bars.length; i++) write(result, i, indices[i] - (mode === 'confirmed' ? 1 : 0));
  }
  return out;
}
