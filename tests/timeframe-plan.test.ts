import { afterEach, describe, expect, it } from 'vitest';
import { SessionCalendar } from '../src/feed/instrument';
import { registerInterval } from '../src/feed/intervals';
import { planTimeframe, timeframeBucketAt, type TimeframeMarket, type TimeframeSource } from '../src/feed/timeframe-plan';

const time = (value: string): number => Date.parse(value) / 1000;
const calendar = new SessionCalendar({ timezone: 'Asia/Kolkata', sessions: ['0915-1530:23456'], exceptions: {
  '2026-01-26': [], '2026-01-27': ['1000-1300'],
} });
function source(interval: string, seconds: number, cal = calendar): TimeframeSource {
  return { interval, bounds(t) {
    const session = cal.sessionAt(t);
    if (!session) return null;
    const from = session.open + Math.floor((t - session.open) / seconds) * seconds;
    return { time: from, from, to: Math.min(from + seconds, session.close) };
  } };
}
const market = (sources: TimeframeSource[], cal = calendar): TimeframeMarket => ({ key: 'test:1', calendar: cal, sources });
const request = (interval: string, from = time('2026-01-28T03:45:00Z')) => ({ symbol: 'TEST', exchange: 'NSE', interval, from, to: from + 86400 });
const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(off => off()));

describe('timeframe source selection', () => {
  it('uses a finer source when a mid-bucket probe hides coarse misalignment', () => {
    const cal = new SessionCalendar({ timezone: 'UTC', sessions: ['0930-1630:23456'] });
    const hourly: TimeframeSource = { interval: '1h', bounds(t) {
      const from = Math.floor(t / 3600) * 3600;
      return { time: from, from, to: from + 3600 };
    } };
    const plan = planTimeframe(request('2h', time('2026-01-28T10:00:00Z')), market([hourly, source('1m', 60, cal)], cal));
    expect(plan.source.interval).toBe('1m');
  });

  it('uses native wire aliases', () => {
    const result = planTimeframe(request('60m'), market([source('1h', 3600)]));
    expect(result.native).toBe(true);
    expect(result.source.interval).toBe('1h');
  });
  it.each([['1m', 60, '7m'], ['1h', 3600, '2h'], ['5m', 300, '1h'], ['1s', 1, '5s'], ['5s', 5, '10s']])(
    'builds %s into compatible %s source bars for %s', (code, seconds, target) => {
      expect(planTimeframe(request(target), market([source(code, seconds)])).native).toBe(false);
    },
  );
  it('builds 7m only from compatible smaller bars', () => {
    expect(() => planTimeframe(request('7m'), market([source('5m', 300)]))).toThrow(/compatible/i);
    expect(() => planTimeframe(request('5s'), market([source('1m', 60)]))).toThrow(/compatible/i);
    expect(planTimeframe(request('1h'), market([source('1m', 60), source('5m', 300)])).source.interval).toBe('5m');
  });
  it('refuses unknown source alignment', () => {
    expect(() => planTimeframe(request('7m'), market([{ interval: '1m', bounds: () => null }]))).toThrow(/alignment/i);
    expect(planTimeframe(request('1m'), market([{ interval: '1m', bounds: () => null }])).native).toBe(true);
  });
  it('respects retention before selecting a source', () => {
    const old = request('2h');
    expect(planTimeframe(old, market([{ ...source('1h', 3600), earliest: old.from + 1 }, source('1m', 60)])).source.interval).toBe('1m');
    expect(() => planTimeframe(old, market([{ ...source('1h', 3600), earliest: old.from + 1 }]))).toThrow(/coverage/i);
  });
  it.each(['0m', '-7m', 'NaNm', '1.5h', '99999999999999999h'])('rejects invalid %s', interval => {
    expect(() => planTimeframe(request(interval), market([source('1m', 60)]))).toThrow();
  });
  it('distinguishes minute and month', () => {
    disposers.push(registerInterval({ code: 'M', bucketing: { mode: 'calendar', unit: 'month' } }));
    expect(planTimeframe(request('1m'), market([source('1m', 60)])).native).toBe(true);
    expect(() => planTimeframe(request('M'), market([source('1m', 60)]))).toThrow(/compatible/i);
  });
});

describe('timeframe boundaries', () => {
  it('anchors each session independently', () => {
    const plan = planTimeframe(request('7m'), market([source('1m', 60)]));
    for (const stamp of ['2026-01-28T03:45:00Z', '2026-01-28T03:52:00Z', '2026-01-28T03:59:00Z', '2026-01-29T03:45:00Z']) {
      const from = time(stamp);
      expect(timeframeBucketAt(plan, from + 30)).toEqual({ time: from, from, to: from + 420 });
    }
    expect(timeframeBucketAt(plan, time('2026-01-28T09:59:59Z'))?.to).toBe(time('2026-01-28T10:00:00Z'));
    expect(timeframeBucketAt(plan, time('2026-01-26T05:00:00Z'))).toBeNull();
    expect(timeframeBucketAt(plan, time('2026-01-27T04:30:01Z'))?.from).toBe(time('2026-01-27T04:30:00Z'));
    const two = planTimeframe(request('2h'), market([source('1h', 3600)]));
    for (const hour of [3, 5, 7, 9]) {
      const from = time(`2026-01-28T0${hour}:45:00Z`);
      expect(timeframeBucketAt(two, from + 1)?.from).toBe(from);
    }
  });
  it('does not join split or overnight sessions', () => {
    const cal = new SessionCalendar({ timezone: 'UTC', sessions: ['0900-1200:23456', '1300-1600:23456', '2200-0200:23456'] });
    const plan = planTimeframe(request('2h', time('2026-01-28T09:00:00Z')), market([source('1h', 3600, cal)], cal));
    expect(timeframeBucketAt(plan, time('2026-01-28T11:30:00Z'))?.to).toBe(time('2026-01-28T12:00:00Z'));
    expect(timeframeBucketAt(plan, time('2026-01-28T12:30:00Z'))).toBeNull();
    expect(timeframeBucketAt(plan, time('2026-01-28T13:30:00Z'))?.from).toBe(time('2026-01-28T13:00:00Z'));
    expect(timeframeBucketAt(plan, time('2026-01-29T00:30:00Z'))?.from).toBe(time('2026-01-29T00:00:00Z'));
  });
  it('keeps calendar periods across year boundaries', () => {
    disposers.push(registerInterval({ code: 'Q', bucketing: { mode: 'calendar', unit: 'quarter' } }));
    const daily = source('D', 86400);
    const weekly = planTimeframe(request('2W', time('2025-12-31T04:00:00Z')), market([daily]));
    expect(timeframeBucketAt(weekly, time('2025-12-31T04:00:00Z'))).toEqual(timeframeBucketAt(weekly, time('2026-01-01T04:00:00Z')));
    const quarter = planTimeframe(request('Q'), market([daily]));
    expect(timeframeBucketAt(quarter, time('2026-02-20T04:00:00Z'))).toEqual({
      time: time('2025-12-31T18:30:00Z'), from: time('2025-12-31T18:30:00Z'), to: time('2026-03-31T18:30:00Z'),
    });
  });
  it('uses exchange timezone through DST', () => {
    const cal = new SessionCalendar({ timezone: 'America/New_York', sessions: ['0930-1600:23456'] });
    const plan = planTimeframe(request('2h', time('2026-03-06T14:30:00Z')), market([source('1h', 3600, cal)], cal));
    expect(timeframeBucketAt(plan, time('2026-03-06T15:00:00Z'))?.from).toBe(time('2026-03-06T14:30:00Z'));
    expect(timeframeBucketAt(plan, time('2026-03-09T14:00:00Z'))?.from).toBe(time('2026-03-09T13:30:00Z'));
  });
});
