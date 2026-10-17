import { describe, expect, it, vi } from 'vitest';
import { createTimeframePreferences, customTimeframeCode } from '../src/widget/timeframe-preferences';
import { resolveInterval, registerInterval } from '../src/feed/intervals';

function storage(initial?: string) {
  const values = new Map(initial === undefined ? [] : [['test', initial]]);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
describe('timeframe preferences', () => {
  it('uses defaults only when state is missing and preserves saved empty favorites', () => {
    const store = storage();
    const first = createTimeframePreferences({ storage: store, key: 'test', defaults: ['5m'] });
    expect(first.favorites()).toEqual(['5m']);
    first.toggle('5m');
    const second = createTimeframePreferences({ storage: store, key: 'test', defaults: ['5m'] });
    expect(second.favorites()).toEqual([]);
    first.destroy(); second.destroy();
  });
  it('deduplicates equivalent fixed and calendar intervals without confusing case', () => {
    const pref = createTimeframePreferences({ storage: null, key: 'test', defaults: ['1h', '60m', '2m'] });
    expect(pref.favorites()).toEqual(['1h', '2m']);
    pref.toggle('60m');
    expect(pref.favorites()).toEqual(['2m']);
    pref.addCustom('2M'); pref.toggle('2M');
    expect(pref.favorites()).toEqual(['2m', '2M']);
    expect(resolveInterval('2m').bucketing).toEqual({ mode: 'interval', seconds: 120 });
    expect(resolveInterval('2M').bucketing).toMatchObject({ mode: 'calendar', unit: 'month', count: 2 });
    pref.addCustom('3M'); pref.addCustom('Q');
    expect(pref.custom()).toHaveLength(2);
    pref.destroy();
  });
  it('never shadows minute codes when a month is explicitly registered', () => {
    const off = registerInterval({ code: '12M', bucketing: { mode: 'calendar', unit: 'year' } });
    expect(resolveInterval('12m').bucketing).toEqual({ mode: 'interval', seconds: 720 });
    off();
  });
  it('saves and removes custom choices while notifying shared panes', () => {
    const store = storage(), pref = createTimeframePreferences({ storage: store, key: 'test', defaults: [] });
    const paneA = vi.fn(), paneB = vi.fn();
    pref.subscribe(paneA); const off = pref.subscribe(paneB);
    pref.addCustom('7m'); pref.toggle('7m'); off(); pref.removeCustom('7m');
    expect(pref.custom()).toEqual([]); expect(pref.favorites()).toEqual([]);
    expect(paneA).toHaveBeenCalledTimes(3); expect(paneB).toHaveBeenCalledTimes(2);
    expect(JSON.parse(store.getItem('test')!)).toEqual({ version: 1, favorites: [], custom: [] });
    pref.destroy();
  });
  it('survives malformed and unavailable storage', () => {
    for (const store of [storage('{bad'), { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} }]) {
      const pref = createTimeframePreferences({ storage: store, key: 'test', defaults: ['5m'] });
      pref.addCustom('7m'); expect(pref.custom()).toEqual(['7m']); pref.destroy();
    }
  });
  it.each(['0m', '-1h', '1.5m', 'Infinityh', '10range', '50000000000000D'])('refuses invalid or unbounded custom input %s', code => {
    const pref = createTimeframePreferences({ storage: null, key: 'test', defaults: [] });
    expect(() => pref.addCustom(code)).toThrow(); pref.destroy();
  });
  it('creates all clock and calendar unit codes with positive integer validation', () => {
    expect(customTimeframeCode(7, 'minutes')).toBe('7m');
    expect(customTimeframeCode(2, 'hours')).toBe('2h');
    expect(customTimeframeCode(1, 'months')).toBe('M');
    expect(customTimeframeCode(1, 'quarters')).toBe('Q');
    expect(() => customTimeframeCode(0, 'seconds')).toThrow();
  });
  it('loads delayed preferences without overwriting an edit made meanwhile', () => {
    const store = storage(), pref = createTimeframePreferences({ storage: store, key: 'test', defaults: ['5m'] });
    store.setItem('test', JSON.stringify({ version: 1, favorites: [], custom: ['2M'] })); pref.reload();
    expect(pref.favorites()).toEqual([]); expect(pref.custom()).toEqual(['2M']);
    pref.addCustom('7m');
    store.setItem('test', JSON.stringify({ version: 1, favorites: ['1h'], custom: [] })); pref.reload();
    expect(pref.custom()).toEqual(['2M', '7m']); pref.destroy();
  });
});
