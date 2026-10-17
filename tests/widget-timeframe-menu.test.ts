import { describe, expect, it, vi } from 'vitest';
import { fakeWidgetDocument, fire, fireKey, type FakeElement } from './helpers/fake-dom-widget';
import { createTimeframePreferences } from '../src/widget/timeframe-preferences';
import { openTimeframeMenu } from '../src/widget/timeframe-menu';
import type { WidgetContext } from '../src/widget/context';
import { makeGrid, topbar } from './widget-grid-harness';

function harness() {
  const doc = fakeWidgetDocument(), anchor = doc.createElement('button'); doc.body.appendChild(anchor);
  const preferences = createTimeframePreferences({ storage: null, key: 'test', defaults: ['5m'] });
  let panel: HTMLElement | null = null, onClose: (() => void) | undefined;
  const context = { document: doc, openOverlay(element: HTMLElement, opts: { onClose?: () => void }) {
    panel = element; doc.body.appendChild(element as unknown as FakeElement); onClose = opts.onClose;
    return () => { element.remove(); onClose?.(); };
  } } as unknown as Pick<WidgetContext, 'document' | 'openOverlay' | 'translate'>;
  const onSelect = vi.fn();
  const open = () => openTimeframeMenu(context, anchor as unknown as HTMLElement, { intervals: ['1m', '5m', '1h', 'D'], current: () => '5m', preferences, canSelect: code => code !== '1s', onSelect });
  return { doc, preferences, open, onSelect, panel: () => panel! };
}
describe('custom interval menu', () => {
  it('groups choices and keeps favorites separate from selecting a timeframe', () => {
    const h = harness(), close = h.open();
    expect(h.panel().textContent).toContain('Minutes'); expect(h.panel().textContent).toContain('Hours');
    const star = h.panel().querySelector<HTMLButtonElement>('[data-favorite="1m"]')!;
    star.click(); expect(h.preferences.favorites()).toEqual(['5m', '1m']); expect(h.onSelect).not.toHaveBeenCalled();
    h.panel().querySelector<HTMLButtonElement>('[data-pick-interval="1h"]')!.click(); expect(h.onSelect).toHaveBeenCalledWith('1h');
    close(); h.preferences.destroy();
  });
  it('adds a custom interval through a unit and quantity dialog and removes it', () => {
    const h = harness(); h.open();
    h.panel().querySelector<HTMLButtonElement>('[data-add-interval]')!.click();
    const count = h.panel().querySelector<HTMLInputElement>('[name="quantity"]')!;
    count.value = '7'; fire(count as unknown as FakeElement, 'input');
    h.panel().querySelector<HTMLButtonElement>('[data-confirm-interval]')!.click();
    expect(h.preferences.custom()).toEqual(['7m']); expect(h.onSelect).toHaveBeenCalledWith('7m');
    const close = h.open();
    h.panel().querySelector<HTMLButtonElement>('[data-remove-interval="7m"]')!.click();
    expect(h.preferences.custom()).toEqual([]); expect(h.onSelect).toHaveBeenCalledTimes(1);
    close(); h.preferences.destroy();
  });
  it('keeps unavailable saved choices visible and disabled', () => {
    const h = harness(); h.preferences.addCustom('1s'); const close = h.open();
    const pick = h.panel().querySelector<HTMLButtonElement>('[data-pick-interval="1s"]')!;
    expect(pick.disabled).toBe(true); expect(pick.title).toContain('source');
    pick.click(); expect(h.onSelect).not.toHaveBeenCalled(); expect(h.preferences.custom()).toEqual(['1s']);
    close(); h.preferences.destroy();
  });
  it('shares favorites across panes without changing their selected intervals', () => {
    const preferences = createTimeframePreferences({ storage: null, key: 'shared', defaults: ['5m'] });
    const { grid } = makeGrid({ preset: '2x1', interval: '5m', timeframePreferences: preferences, canSelectInterval: () => true });
    grid.cells()[1]!.widget.setInterval('1h');
    preferences.addCustom('7m'); preferences.toggle('7m');
    for (const index of [0, 1]) expect(topbar(grid, index).querySelector('[data-interval="7m"]')).not.toBeNull();
    expect(grid.cells().map(cell => cell.widget.interval())).toEqual(['5m', '1h']);
    topbar(grid, 0).querySelector('[data-interval="7m"]')!.click();
    expect(grid.cells().map(cell => cell.widget.interval())).toEqual(['7m', '1h']);
    preferences.removeCustom('7m');
    expect(grid.cells()[0]!.widget.interval()).toBe('7m');
    expect(topbar(grid, 1).querySelector('[data-interval="7m"]')).toBeNull();
    grid.destroy(); preferences.destroy();
  });
  it('validates unsupported entries and supports keyboard submission', () => {
    const h = harness(); h.open(); h.panel().querySelector<HTMLButtonElement>('[data-add-interval]')!.click();
    const count = h.panel().querySelector<HTMLInputElement>('[name="quantity"]')!;
    const unit = h.panel().querySelector<HTMLSelectElement>('[name="unit"]')!;
    unit.value = 'seconds'; count.value = '1'; fire(unit as unknown as FakeElement, 'change');
    expect(h.panel().querySelector<HTMLButtonElement>('[data-confirm-interval]')!.disabled).toBe(true);
    unit.value = 'hours'; count.value = '2'; fire(unit as unknown as FakeElement, 'change');
    fireKey(count as unknown as FakeElement, 'Enter');
    expect(h.onSelect).toHaveBeenCalledWith('2h'); h.preferences.destroy();
  });
  it('shows equivalent interval aliases once with the saved favorite state', () => {
    const h = harness(); h.preferences.addCustom('60m'); h.preferences.toggle('60m');
    const close = h.open();
    expect(h.panel().querySelectorAll('[data-pick-interval="1h"]').length
      + h.panel().querySelectorAll('[data-pick-interval="60m"]').length).toBe(1);
    const star = h.panel().querySelector<HTMLButtonElement>('[data-favorite="60m"]')!;
    expect(star.getAttribute('aria-pressed')).toBe('true');
    close(); h.preferences.destroy();
  });
});
