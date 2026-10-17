import {
  SessionCalendar, planTimeframe, timeframeBucketAt, withTimeframes,
  resolveInterval, tryResolveInterval, registerInterval, utcSecondsToZonedParts, zonedWallClockToUtcSeconds,
} from '/dist/openalgo-charts.mjs';
import { createTimeframeProvider } from '/dist/openalgo-charts.indicators.mjs';
import { createTimeframePreferences } from '/dist/openalgo-charts.widget.mjs';
import { exchangeOf, SESSIONS, venueCalendar } from './status.js';
import { instrumentFor } from './ticks.js';

export const NATIVE_INTERVALS = ['1m', '2m', '5m', '15m', '30m', '1h', '90m', '1d'];
export const SOURCE_MAX_DAYS = { '1m': 7, '2m': 60, '5m': 60, '15m': 60, '30m': 60, '1h': 730, '90m': 60 };
const DAY = 86400;
const allDay = new SessionCalendar({ timezone: 'UTC', sessions: ['0000-0000:1234567'] });
const extended = new SessionCalendar({ timezone: 'America/New_York', sessions: ['0400-2000:23456'] });

function calendarFor(req) {
  const instrument = instrumentFor(req.symbol);
  if (instrument) return new SessionCalendar({ timezone: instrument.metadata.timezone, ...instrument.metadata.calendar });
  const venue = exchangeOf(req.symbol);
  return req.variant?.session === 'extended' && venue === 'US' ? extended : venueCalendar(venue) ?? allDay;
}

function bounds(calendar, interval, time) {
  const rule = resolveInterval(interval).bucketing;
  if (rule.mode !== 'interval') return null;
  if (rule.seconds === DAY) {
    const p = utcSecondsToZonedParts(time, calendar.timezone);
    const from = zonedWallClockToUtcSeconds(p.year, p.month, p.day, 0, 0, 0, calendar.timezone);
    const session = calendar.sessionFrom(from);
    if (!session || session.open >= from + 26 * 3600) return null;
    return { time, from, to: session.close };
  }
  const session = calendar.sessionAt(time);
  if (!session) return null;
  const from = session.open + Math.floor((time - session.open) / rule.seconds) * rule.seconds;
  return { time: from, from, to: Math.min(from + rule.seconds, session.close) };
}

/** The source's wire tokens, retention and timestamp conventions, independent of display timezone. */
export function referenceMarket(req, now = Date.now() / 1000) {
  const venue = exchangeOf(req.symbol), calendar = calendarFor(req);
  const known = venue in SESSIONS || instrumentFor(req.symbol) !== null;
  return {
    key: `reference:${venue}:${calendar.timezone}:${req.variant?.session ?? 'regular'}`,
    calendar,
    sources: NATIVE_INTERVALS.map(interval => ({
      interval,
      bounds: time => known ? bounds(calendar, interval, time) : null,
      earliest: SOURCE_MAX_DAYS[interval] ? now - SOURCE_MAX_DAYS[interval] * DAY : -2208988800,
      ...(interval === '1m' ? { maxSpanSeconds: 5 * DAY } : {}),
    })),
  };
}

/** Restore a saved calendar choice even when it is no longer in the menu. */
export function restoreReferenceTimeframe(code) {
  if (typeof code !== 'string' || tryResolveInterval(code)) return;
  const match = /^(\d*)([MQY])$/.exec(code);
  if (!match) return;
  const count = match[1] === '' ? 1 : Number(match[1]);
  if (!Number.isInteger(count) || count < 1 || count > 100000) return;
  registerInterval({ code, bucketing: { mode: 'calendar', unit: { M: 'month', Q: 'quarter', Y: 'year' }[match[2]], count } });
}

export function referenceSource(interval, symbol = 'AAPL', variant, now = Date.now() / 1000) {
  restoreReferenceTimeframe(interval);
  const req = { symbol, exchange: exchangeOf(symbol), interval, variant };
  return planTimeframe(req, referenceMarket(req, now)).source.interval;
}

export function referenceSupports(interval, symbol, variant) {
  try { referenceSource(interval, symbol, variant); return true; } catch { return false; }
}

/** One shared resampler and confirmed-history provider for every chart on the page. */
export function createReferenceTimeframes(source, { now = () => Date.now() / 1000 } = {}) {
  const latest = new Map();
  const key = req => `${req.symbol}|${req.interval}|${req.variant?.session ?? 'regular'}`;
  const feed = withTimeframes({
    getBars: async req => {
      const bars = await source.getBars({ ...req, allowEmpty: true });
      if (bars.length) {
        const id = key(req), previous = latest.get(id), horizon = Math.min(req.to ?? now(), now());
        // Older warmup pages cannot replace the tail, but a fresh tail can
        // regress when the source falls behind. The stale badge must see it.
        const seen = previous && previous.horizon > horizon ? previous : { horizon, time: bars.at(-1).time };
        latest.delete(id); latest.set(id, seen);
        if (latest.size > 128) latest.delete(latest.keys().next().value);
      }
      return bars;
    },
    ...(source.dataVariants ? { dataVariants: req => source.dataVariants(req) } : {}),
  }, { market: req => referenceMarket(req, now()), now });
  const destroy = feed.destroy;
  feed.destroy = () => { latest.clear(); destroy(); };
  const provider = createTimeframeProvider(feed, { now, availability: (bar, req) => {
    const bucket = timeframeBucketAt(feed.resolve({ ...req, exchange: req.exchange ?? '' }), bar.time);
    return { at: bucket?.to ?? null, confirmed: bucket !== null && bucket.to <= now() };
  } });
  return { feed, provider, latest: req => latest.get(key({ ...req, interval: feed.resolve(req).source.interval }))?.time };
}

export function attachReferenceTimeframes(chart, provider) { chart.setBarsProvider(provider); }

let preferences;
export function referenceTimeframePreferences() {
  if (!preferences) {
    let storage = null;
    try { storage = globalThis.localStorage; } catch { /* The page still works when persistence is blocked. */ }
    preferences = createTimeframePreferences({ storage, key: 'oac-reference-timeframes', defaults: ['5m', '15m', '30m', '1h', '1d'] });
  }
  return preferences;
}
