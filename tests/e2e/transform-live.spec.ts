import { test, expect, type Page } from '@playwright/test';

/**
 * In-chart transforms in real browser pixels. Unit tests prove the elements a
 * run forms after every tick; this proves the chart paints them live: a tick
 * on the forming bar draws the bricks it completes, a tick back takes them
 * off the canvas again, and a closed bar keeps its bricks. Each transformed
 * chart type is also captured once per browser for a person to look at.
 */

interface Element { time: number; open: number; close: number }

async function ready(page: Page, query: string): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 620 });
  await page.goto(`/tests/e2e/transform-live-fixture.html?${query}`);
  await page.waitForFunction(() => (window as any).__ready);
}

/** The chart's elements after the next painted frame. */
async function elements(page: Page): Promise<Element[]> {
  return page.evaluate(async () => { await (window as any).__frame(); return (window as any).__probe.elements(); });
}

/**
 * The colour painted at an element's body centre, read off the chart's own
 * capture, as `[r, g, b]` in device pixels.
 */
async function bodyColour(page: Page, element: Element): Promise<number[]> {
  return page.evaluate(async (el) => {
    const { chart } = (window as any).__probe;
    await (window as any).__frame();
    const shot = chart.takeScreenshot() as HTMLCanvasElement;
    const dpr = devicePixelRatio;
    const x = Math.round(chart.timeToCoordinate(el.time) * dpr);
    const y = Math.round(chart.priceToCoordinate((el.open + el.close) / 2) * dpr);
    return [...shot.getContext('2d')!.getImageData(x, y, 1, 1).data.slice(0, 3)];
  }, element);
}

const hex = (colour: string): number[] => [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16));
const near = (a: number[], b: number[]): boolean => a.every((v, i) => Math.abs(v - b[i]) <= 24);

test.describe('in-chart transforms', () => {
  test('ticks a Renko chart live, brick by brick', async ({ page }, testInfo) => {
    await ready(page, 'type=renko&study=chart');
    const theme = await page.evaluate(() => { const { lib } = (window as any).__probe; return { up: lib.darkTheme.upColor, down: lib.darkTheme.downColor }; });
    const box = 2;
    const history = await elements(page);
    expect(history.length).toBeGreaterThan(40);
    const edge = history[history.length - 1].close;

    // A new bar opens and ticks up through three boxes: three bricks form on it.
    await page.evaluate(() => (window as any).__probe.open());
    await page.evaluate((price) => (window as any).__probe.tick(price), edge + box * 3.4);
    const up = await elements(page);
    expect(up.slice(0, history.length)).toEqual(history);
    expect(up.length).toBe(history.length + 3);
    const newest = up[up.length - 1];
    expect(newest.close - newest.open).toBeCloseTo(box, 6);
    expect(near(await bodyColour(page, newest), hex(theme.up))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('renko-forming.png') });

    // The same bar falls back inside the box it opened in: those bricks were
    // only ever provisional, and leave the chart with the price.
    await page.evaluate((price) => (window as any).__probe.tick(price), edge + box * 0.5);
    const back = await elements(page);
    expect(back).toEqual(history);
    expect(near(await bodyColour(page, newest), hex(theme.up))).toBe(false);

    // It closes two boxes down, and the next bar opens: the down bricks stay.
    await page.evaluate((price) => (window as any).__probe.tick(price), edge - box * 2.2);
    await page.evaluate(() => (window as any).__probe.open());
    const closed = await elements(page);
    expect(closed.length).toBe(history.length + 2);
    const down = closed[closed.length - 1];
    expect(down.open - down.close).toBeCloseTo(box, 6);
    expect(near(await bodyColour(page, down), hex(theme.down))).toBe(true);
    await page.evaluate((price) => (window as any).__probe.tick(price), edge - box * 1.9);
    expect(await elements(page)).toEqual(closed);
    // The host's own bars are what the series still holds.
    expect(await page.evaluate(() => (window as any).__probe.lastSource().close)).toBeCloseTo(edge - box * 1.9, 6);
  });

  for (const type of ['heikin-ashi', 'renko', 'range-bars', 'line-break', 'point-figure', 'kagi']) {
    test(`draws a ${type} chart`, async ({ page }, testInfo) => {
      await ready(page, `type=${type}`);
      const drawn = await elements(page);
      expect(drawn.length).toBeGreaterThan(type === 'kagi' || type === 'point-figure' ? 8 : 40);
      // Something other than the background is painted inside the plot.
      const painted = await page.evaluate(() => {
        const { chart, lib } = (window as any).__probe;
        const shot = chart.takeScreenshot() as HTMLCanvasElement, plot = chart.plotRect(0), dpr = devicePixelRatio;
        const data = shot.getContext('2d')!.getImageData(plot.left * dpr, plot.top * dpr, plot.width * dpr, plot.height * dpr).data;
        const bg = [1, 3, 5].map(i => parseInt(lib.darkTheme.background.slice(i, i + 2), 16));
        let count = 0;
        for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 60) count++;
        return count / (data.length / 4);
      });
      expect(painted).toBeGreaterThan(0.01);
      await page.screenshot({ path: testInfo.outputPath(`${type}.png`) });
    });
  }

  test('picks Renko from the widget chart type menu and ticks it live', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1200, height: 700 });
    await page.goto('/tests/e2e/widget-transform-fixture.html');
    await page.waitForFunction(() => (window as any).fixture?.widget.chart.primaryBars().length === 300);
    await page.click('.oac-topbar__type');
    const menu = page.locator('.oac-menu[role="menu"]');
    for (const name of ['Heikin Ashi', 'Renko', 'Range bars', 'Line break', 'Point and figure', 'Kagi']) {
      await expect(menu.getByRole('menuitemradio', { name, exact: true })).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath('widget-type-menu.png') });
    await menu.getByRole('menuitemradio', { name: 'Kagi', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('widget-type-menu-end.png') });
    await menu.getByRole('menuitemradio', { name: 'Renko', exact: true }).click();
    const state = () => page.evaluate(async () => {
      const { widget } = (window as any).fixture;
      await (window as any).__frame();
      const bricks = widget.chart.primaryBars();
      return { type: widget.chartType(), transform: widget.chart.seriesTransform(widget.series), count: bricks.length,
        last: bricks[bricks.length - 1], box: Math.abs(bricks[0].close - bricks[0].open), label: document.querySelector('.oac-topbar__type')?.textContent };
    });
    const renko = await state();
    expect(renko).toMatchObject({ type: 'renko', transform: { type: 'renko' } });
    expect(renko.label).toContain('Renko');
    expect(renko.count).toBeGreaterThan(20);
    // A live bar through three and a half boxes: three bricks form on it.
    await page.evaluate(({ price }) => (window as any).fixture.live(price, true), { price: renko.last.close + renko.box * 3.5 });
    const ticked = await state();
    expect(ticked.count).toBe(renko.count + 3);
    await page.screenshot({ path: testInfo.outputPath('widget-renko.png') });
    // Back inside the box it opened in: the provisional bricks go.
    await page.evaluate(({ price }) => (window as any).fixture.live(price), { price: renko.last.close + renko.box * 0.2 });
    expect((await state()).count).toBe(renko.count);
  });
});
