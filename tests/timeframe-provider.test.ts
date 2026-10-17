import { describe, expect, it, vi } from 'vitest';
import type { Bar } from '../src/model/bar';
import type { IndicatorSnapshotRequest } from '../src/model/indicator-registry';
import { SessionCalendar } from '../src/feed/instrument';
import type { BarsPageRequest, BarsRequest } from '../src/feed/types';
import { withTimeframes } from '../src/feed/timeframe-feed';
import { createTimeframeProvider } from '../src/indicators/timeframe-provider';

const day = 86400, first = Date.parse('2025-01-01T00:00:00Z') / 1000;
const calendar = new SessionCalendar({ timezone: 'UTC', sessions: ['0900-1600:23456'] });
const history: Bar[] = Array.from({ length: 400 }, (_, i) => first + i * day)
  .filter(time => ![0, 6].includes(new Date(time * 1000).getUTCDay()))
  .map((time, i) => ({ time, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i }));
const req: IndicatorSnapshotRequest = { symbol: 'TEST', exchange: 'TEST', interval: 'D', from: history[230]!.time, to: history[235]!.time, warmupBars: 200 };
function fixture(input = history) {
  let revision = 'v1';
  const getBars = vi.fn(async (r: BarsRequest) => input.filter(bar => bar.time >= r.from! && bar.time < r.to!));
  const getBarsPage = vi.fn(async (r: BarsPageRequest) => {
    const eligible = input.filter(bar => bar.time < r.before);
    return { bars: eligible.slice(-5), hasMore: eligible.length > 5, nextBefore: eligible[Math.max(0, eligible.length - 5)]?.time ?? first };
  });
  const feed = withTimeframes({ getBars, getBarsPage }, { market: () => ({ key: revision, calendar, sources: [{ interval: 'D', earliest: first, bounds: time => ({ time, from: time, to: time + day }) }] }) });
  const availability = vi.fn((bar: Readonly<Bar>) => ({ at: bar.time + 16 * 3600, confirmed: true }));
  return { feed, getBars, getBarsPage, availability, revise: () => { revision = 'v2'; } };
}

describe('independent timeframe snapshots', () => {
  it('bounds empty-window traversal when a new listing has no retention metadata', async () => {
    const input = history.slice(220, 230);
    const getBars = vi.fn(async (r: BarsRequest) => input.filter(bar => bar.time >= r.from! && bar.time < r.to!));
    const feed = withTimeframes({ getBars }, { market: () => ({ key: 'new-listing', calendar, sources: [
      { interval: 'D', bounds: time => ({ time, from: time, to: time + day }) },
    ] }) });
    const provider = createTimeframeProvider(feed, { availability: bar => ({ at: bar.time + day, confirmed: true }) });
    await expect(provider.requestSnapshot!(req)).rejects.toThrow(/Insufficient.*history/i);
    expect(getBars.mock.calls.length).toBeLessThanOrEqual(6);
    feed.destroy();
  });
  it('continues after one empty window instead of assuming history is exhausted', async () => {
    const f = fixture();
    f.getBarsPage.mockResolvedValueOnce({ bars: [], hasMore: true, nextBefore: req.from - 1 });
    const result = await createTimeframeProvider(f.feed, { availability: f.availability }).requestSnapshot!(req);
    expect(result.bars.filter(bar => bar.time < req.from)).toHaveLength(200);
    f.feed.destroy();
  });

  it('loads 200 observations before an intraday window despite weekends and short pages', async () => {
    const f = fixture(), provider = createTimeframeProvider(f.feed, { availability: f.availability });
    const result = await provider.requestSnapshot!(req);
    expect(result.bars.filter(bar => bar.time < req.from)).toHaveLength(200);
    expect(result.bars[result.bars.length - 1]!.time).toBe(history[234]!.time);
    expect(f.getBarsPage).toHaveBeenCalledTimes(40);
    expect(provider.supportsWarmup).toBe(true);
    f.feed.destroy();
  });
  it('does not fabricate observations for a newly listed instrument', async () => {
    const f = fixture(history.slice(110, 235));
    const provider = createTimeframeProvider(f.feed, { availability: f.availability });
    expect((await provider.requestSnapshot!(req)).bars.filter(bar => bar.time < req.from)).toHaveLength(120);
    f.feed.destroy();
  });
  it('does not download daily history on each tick and keeps a stable oldest seed', async () => {
    const f = fixture(), provider = createTimeframeProvider(f.feed, { availability: f.availability });
    const initial = await provider.requestSnapshot!(req);
    const pages = f.getBarsPage.mock.calls.length, reads = f.getBars.mock.calls.length;
    const again = await provider.requestSnapshot!({ ...req });
    expect(again).toEqual(initial);
    expect(f.getBarsPage).toHaveBeenCalledTimes(pages);
    expect(f.getBars).toHaveBeenCalledTimes(reads);
    const advanced = await provider.requestSnapshot!({ ...req, from: history[231]!.time, to: history[236]!.time });
    expect(advanced.bars[0]!.time).toBe(initial.bars[0]!.time);
    expect(f.getBars.mock.calls[f.getBars.mock.calls.length - 1]![0].from).toBeGreaterThanOrEqual(req.to);
    f.feed.destroy();
  });
  it('calendar revision invalidates cached availability and variants have separate identities', async () => {
    const f = fixture(), provider = createTimeframeProvider(f.feed, { availability: f.availability });
    await provider.requestSnapshot!(req);
    const before = f.getBarsPage.mock.calls.length;
    f.revise();
    await provider.requestSnapshot!(req);
    expect(f.getBarsPage.mock.calls.length).toBeGreaterThan(before);
    await provider.requestSnapshot!({ ...req, variant: { adjustment: 'raw' } });
    expect(f.getBars.mock.calls[f.getBars.mock.calls.length - 1]![0].variant).toEqual({ adjustment: 'raw' });
    f.feed.destroy();
  });
  it('rejects asOf without historical versions', async () => {
    const f = fixture(), provider = createTimeframeProvider(f.feed, { availability: f.availability });
    await expect(provider.requestSnapshot!({ ...req, asOf: req.to })).rejects.toThrow(/historical/i);
    expect(f.getBars).not.toHaveBeenCalled();
    const historicalSnapshot = vi.fn(async () => ({ bars: [], confirmed: [], availableAt: [] }));
    await createTimeframeProvider(f.feed, { availability: f.availability, historicalSnapshot }).requestSnapshot!({ ...req, asOf: req.to });
    expect(historicalSnapshot).toHaveBeenCalledTimes(1);
    f.feed.destroy();
  });
  it('preserves unknown availability and refreshes a forming tail', async () => {
    const f = fixture();
    let closed = false;
    const provider = createTimeframeProvider(f.feed, { availability: bar => ({ at: bar.time === history[234]!.time && !closed ? null : bar.time + 16 * 3600, confirmed: closed || bar.time < history[234]!.time }) });
    const initial = await provider.requestSnapshot!(req);
    expect(initial.availableAt[initial.availableAt.length - 1]).toBeNull();
    closed = true;
    const final = await provider.requestSnapshot!(req);
    expect(final.confirmed[final.confirmed.length - 1]).toBe(true);
    expect(f.getBars.mock.calls[f.getBars.mock.calls.length - 1]![0].from).toBe(history[234]!.time);
    f.feed.destroy();
  });
  it('one cancelled consumer does not cancel another and failures are retryable', async () => {
    const f = fixture(), provider = createTimeframeProvider(f.feed, { availability: f.availability });
    const controller = new AbortController();
    const one = provider.requestSnapshot!({ ...req, signal: controller.signal });
    const two = provider.requestSnapshot!(req);
    controller.abort();
    await expect(one).rejects.toMatchObject({ name: 'AbortError' });
    expect((await two).bars.length).toBeGreaterThan(200);
    f.revise();
    f.getBars.mockRejectedValueOnce(new Error('unavailable'));
    await expect(provider.requestSnapshot!(req)).rejects.toThrow('unavailable');
    expect((await provider.requestSnapshot!(req)).bars.length).toBeGreaterThan(200);
    f.feed.destroy();
  });
});
