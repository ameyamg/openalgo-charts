import { expect, test, type Page } from '@playwright/test';
import type { Chart, IndicatorApi, IndicatorBarsProviderAccess } from '../../src/index';
import type * as Engine from '../../src/index';
import type { ChartGrid } from '../../src/widget/index';

type Host = Window & { __oac: { app: {
  chart: Chart; chart2?: Chart; loading: boolean; loading2: boolean;
  req: { symbol: string; interval: string; period: string };
  timeframes: { provider: IndicatorBarsProviderAccess }; load(): Promise<void>;
} }; __dailyStudy?: IndicatorApi };

async function ready(page: Page, interval?: string) {
  await page.waitForFunction(code => {
    const app = (window as unknown as Host).__oac?.app;
    return app?.chart && !app.loading && (!code || app.req.interval === code);
  }, interval);
}
async function custom(page: Page, unit: string, count: string) {
  await page.locator('#timeframe-menu').click();
  await page.getByRole('button', { name: 'Add custom interval', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add custom interval', exact: true });
  await dialog.getByLabel('Type', { exact: true }).selectOption(unit);
  await dialog.getByLabel('Interval', { exact: true }).fill(count);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/examples/yfinance/index.html?test=1');
  await ready(page);
});

test('custom interval dialog, stable actions, favorites and reload', async ({ page }, info) => {
  const calls: string[] = [], errors: string[] = [];
  page.on('request', req => { if (req.url().includes('/api/history')) calls.push(req.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await custom(page, 'minutes', '7'); await ready(page, '7m');
  expect(calls.some(url => url.includes('interval=1m'))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as Host).__oac.app.req.period)).toBe('5d');
  await page.locator('#timeframe-menu').click();
  const row = page.locator('.oac-timeframe-menu__row').filter({ has: page.locator('[data-pick-interval="7m"]') });
  const before = await row.boundingBox(); await row.hover(); expect(await row.boundingBox()).toEqual(before);
  await page.locator('[data-favorite="7m"]').click();
  await page.screenshot({ path: info.outputPath('custom-timeframes-desktop.png') });
  await page.keyboard.press('Escape'); await page.reload(); await ready(page, '7m');
  await expect(page.locator('#shellbar .pills').getByRole('button', { name: '7M', exact: true })).toBeVisible();
  await page.locator('#timeframe-menu').click(); await page.locator('[data-remove-interval="7m"]').click();
  expect(await page.evaluate(() => (window as unknown as Host).__oac.app.req.interval)).toBe('7m');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('daily EMA 200 has correct values and visible line pixels on a short five-minute chart', async ({ page }, info) => {
  await page.evaluate(async () => {
    const app = (window as unknown as Host).__oac.app;
    (document.getElementById('interval') as HTMLSelectElement).value = '5m';
    (document.getElementById('period') as HTMLSelectElement).value = '5d';
    await app.load();
    for (const study of [...app.chart.indicators()]) study.remove();
    (window as unknown as Host).__dailyStudy = app.chart.addIndicator('ema', { length: 200, timeframe: 'D', color: '#ff00ff', 'ma:color': '#ff00ff', 'ma:width': 3 });
  });
  await page.waitForFunction(() => (window as unknown as Host).__dailyStudy?.dataStatus()?.state === 'ready');
  const result = await page.evaluate(async () => {
    const w = window as unknown as Host, chart = w.__oac.app.chart, study = w.__dailyStudy!;
    const bars = chart.primarySeries()!.getData();
    const snapshot = await w.__oac.app.timeframes.provider.requestSnapshot!({ symbol: w.__oac.app.req.symbol, exchange: chart.getDataContext()?.exchange, interval: 'D', from: bars[0].time, to: bars.at(-1)!.time + 1, warmupBars: 200 });
    const engine = await import('/dist/openalgo-charts.mjs') as typeof Engine;
    const descriptor = engine.getIndicator('ema')!;
    const expected = descriptor.calc(snapshot.bars, { ...engine.indicatorDefaults(descriptor), length: 200, timeframe: '' }, {}).ma!;
    const actual = study.values().ma!;
    let matches = 0;
    for (let i = 0; i < bars.length; i++) {
      let at = -1;
      for (let j = 0; j < snapshot.bars.length; j++) if (snapshot.confirmed[j] && snapshot.availableAt[j] !== null && snapshot.availableAt[j]! <= bars[i].time) at = j;
      if (at >= 0 && expected[at] !== null && actual[i] !== null && Math.abs(expected[at]! - actual[i]!) < 1e-8) matches++;
    }
    return { bars: bars.length, daily: snapshot.bars.length, matches };
  });
  expect(result.bars).toBeGreaterThan(10); expect(result.bars).toBeLessThan(500);
  expect(result.daily).toBeGreaterThanOrEqual(200); expect(result.matches).toBe(result.bars);
  await expect.poll(() => page.evaluate(() => {
    const chart = (window as unknown as Host).__oac.app.chart;
    const { ctx, element: canvas } = chart.panes()[0].base;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 210 && pixels[i + 1] < 70 && pixels[i + 2] > 210) count++;
    return count;
  })).toBeGreaterThan(100);
  await page.screenshot({ path: info.outputPath('daily-ema-200-on-5m.png') });
});

test('hour and calendar customs load from their base sources', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  for (const [unit, quantity, code] of [['hours', '2', '2h'], ['weeks', '1', 'W'], ['months', '1', 'M'], ['quarters', '1', 'Q']]) {
    await custom(page, unit, quantity); await ready(page, code);
    expect(await page.evaluate(() => (window as unknown as Host).__oac.app.chart.primarySeries()!.getData().length)).toBeGreaterThan(1);
  }
  await page.screenshot({ path: info.outputPath('calendar-quarter.png') });
  expect(errors).toEqual([]);
});

test('mobile custom entry fits the viewport and disables unsupported seconds', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#timeframe-menu').click();
  await page.getByRole('button', { name: 'Add custom interval', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add custom interval', exact: true });
  await dialog.getByLabel('Type', { exact: true }).selectOption('seconds');
  await dialog.getByLabel('Interval', { exact: true }).fill('5');
  await expect(dialog.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('status')).toContainText('source');
  await dialog.getByLabel('Type', { exact: true }).selectOption('minutes');
  await dialog.getByLabel('Interval', { exact: true }).fill('7');
  const box = await dialog.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath('custom-interval-mobile.png') });
  await dialog.getByLabel('Interval', { exact: true }).press('Enter'); await ready(page, '7m');
});

test('grid panes share custom favorites and independent daily history', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/examples/yfinance/grid.html?test=1');
  await page.waitForFunction(() => {
    const grid = (window as unknown as { __grid?: ChartGrid }).__grid;
    return grid?.cells().length === 4 && grid.cells().every(cell => cell.widget.series.getData().length > 0);
  });
  await page.locator('.oac-topbar__interval-menu').first().click();
  await page.getByRole('button', { name: 'Add custom interval', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add custom interval', exact: true });
  await dialog.getByLabel('Interval', { exact: true }).fill('7');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForFunction(() => {
    const widget = (window as unknown as { __grid: ChartGrid }).__grid.cells()[0].widget;
    return widget.interval() === '7m' && widget.series.getData().length > 10;
  });
  await page.locator('.oac-topbar__interval-menu').first().click(); await page.locator('[data-favorite="7m"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.oac-pills [data-interval="7m"]')).toHaveCount(4);
  expect(await page.evaluate(() => (window as unknown as { __grid: ChartGrid }).__grid.cells()[1].widget.interval())).toBe('1d');
  await page.evaluate(() => {
    const grid = (window as unknown as { __grid: ChartGrid }).__grid;
    grid.setTheme('light');
    (window as unknown as Host).__dailyStudy = grid.cells()[0].widget.chart.addIndicator('ema', { length: 200, timeframe: 'D' });
  });
  await page.waitForFunction(() => (window as unknown as Host).__dailyStudy?.values().ma?.some(value => value !== null));
  await page.locator('.oac-topbar__interval-menu').first().click();
  const menu = page.getByRole('dialog', { name: 'Timeframes', exact: true });
  const cellBox = await page.locator('.oac-grid__cell').first().boundingBox();
  const menuBox = await menu.boundingBox();
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(cellBox!.y + cellBox!.height);
  await menu.locator('[data-pick-interval="1w"]').scrollIntoViewIfNeeded();
  await expect(menu.locator('[data-pick-interval="1w"]')).toBeInViewport();
  await page.screenshot({ path: info.outputPath('grid-custom-intervals-light.png') });
  expect(errors).toEqual([]);
});
