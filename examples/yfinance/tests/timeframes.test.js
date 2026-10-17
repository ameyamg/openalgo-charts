import { describe, expect, it, vi, afterEach } from 'vitest';
import { customTimeframeCode } from '/dist/openalgo-charts.widget.mjs';
import { createReferenceTimeframes, referenceMarket, referenceSource } from '../src/timeframes.js';
import { YFinanceDataFeed, NotFoundError } from '../src/feed.js';
import { clampPeriod } from '../src/intervals.js';

const at = value => Date.parse(value) / 1000;
const now = at('2026-10-16T22:00:00Z');
const from = at('2026-10-16T13:30:00Z');
const bar = (time, close) => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 10 });
const request = interval => ({ symbol: 'AAPL', exchange: 'US', interval, from, to: from + 7200 });
afterEach(() => vi.unstubAllGlobals());

describe('reference timeframe integration', () => {
  it('bounds source-horizon memory and does not rewind it during warmup paging', async () => {
    const service = createReferenceTimeframes({ getBars: async req => [bar(req.from, 100)] }, { now: () => now });
    await service.feed.getBars(request('1d'));
    await service.feed.getBars({ ...request('1d'), from: from - 86400, to: from });
    expect(service.latest(request('1d'))).toBe(from);
    await service.feed.getBars({ ...request('1d'), from: from - 86400 });
    expect(service.latest(request('1d'))).toBe(from - 86400);
    for (let i = 0; i < 128; i++) await service.feed.getBars({ ...request('1d'), symbol: `TEST${i}` });
    expect(service.latest(request('1d'))).toBeUndefined();
    service.feed.destroy();
  });

  it('uses compatible native observations and exchange session buckets', async () => {
    const calls = [];
    const source = { getBars: async req => {
      calls.push(req);
      const seconds = req.interval === '1m' ? 60 : 3600;
      return Array.from({ length: 7200 / seconds }, (_, i) => bar(from + i * seconds, 100 + i));
    } };
    const service = createReferenceTimeframes(source, { now: () => now });
    const minutes = await service.feed.getBars(request('7m'));
    expect(calls[0].interval).toBe('1m');
    expect(minutes[0]).toMatchObject({ time: from, open: 100, close: 106, volume: 70 });
    const hours = await service.feed.getBars(request('2h'));
    expect(calls.at(-1).interval).toBe('1h');
    expect(hours[0]).toMatchObject({ time: from, open: 100, close: 101, volume: 20 });
    service.feed.destroy();
  });

  it('derives calendar periods from daily history and refuses unavailable seconds', () => {
    for (const [unit, code] of [['weeks', 'W'], ['months', 'M'], ['quarters', 'Q']]) {
      customTimeframeCode(1, unit);
      expect(referenceSource(code, 'AAPL', undefined, now)).toBe('1d');
    }
    expect(() => referenceSource('5s', 'AAPL', undefined, now)).toThrow(/source/);
    expect(referenceMarket(request('7m'), now).sources.find(s => s.interval === '1m').earliest).toBe(now - 7 * 86400);
    expect(clampPeriod('7m', '1y')).toBe('5d');
    expect(clampPeriod('2h', '5y')).toBe('1y');
  });

  it('loads at least 200 confirmed daily observations independently of a two-hour chart window', async () => {
    const calls = [];
    const source = { getBars: async req => {
      calls.push(req);
      const market = referenceMarket(req, now), output = [];
      for (let day = Math.floor(req.from / 86400) * 86400; day < req.to; day += 86400) {
        const session = market.calendar.sessionFrom(day);
        if (session && session.open >= req.from && session.open < Math.min(day + 86400, req.to)) output.push(bar(session.open, 100 + output.length));
      }
      return output;
    } };
    const service = createReferenceTimeframes(source, { now: () => now });
    const snapshot = await service.provider.requestSnapshot({ ...request('D'), warmupBars: 200 });
    expect(snapshot.bars.filter((b, i) => b.time < from && snapshot.confirmed[i]).length).toBeGreaterThanOrEqual(200);
    expect(calls.every(req => req.interval === '1d')).toBe(true);
    expect(calls.some(req => req.from < from - 200 * 86400)).toBe(true);
    const forming = snapshot.bars.findIndex(b => b.time === from);
    expect(snapshot.availableAt[forming]).toBe(at('2026-10-16T20:00:00Z'));
    service.feed.destroy();
  });

  it('passes explicit windows to the server and permits empty bounded pages', async () => {
    const calls = [];
    vi.stubGlobal('fetch', async url => { calls.push(String(url)); return { status: 200, text: async () => '[]' }; });
    const source = new YFinanceDataFeed();
    await expect(source.getBars({ ...request('1d'), allowEmpty: true })).resolves.toEqual([]);
    expect(calls[0]).toContain(`from=${from}`);
    expect(calls[0]).toContain(`to=${from + 7200}`);
    await expect(source.getBars({ symbol: 'UNKNOWN', interval: '1d', period: '1y' })).rejects.toBeInstanceOf(NotFoundError);
  });
});
