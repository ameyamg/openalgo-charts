import { test, expect } from '@playwright/test';

// The reference host's sample timeline events: rich details rendered as text
// and a host action on the popup.
const PAGE = '/examples/yfinance/index.html?test=1';
const PROBE = '/api/history?symbol=AAPL&interval=1d&period=1mo';
let serverUp: boolean | null = null;

test.beforeEach(async ({ request, page }) => {
  if (serverUp === null) serverUp = await request.get(PROBE).then(response => response.ok(), () => false);
  test.skip(!serverUp, 'The reference fixture server is unavailable');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(PAGE);
  await page.waitForFunction(() => Boolean((window as any).__oac?.app?.currentBars?.length));
});

test('sample events show rich details as text and mark the chart', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Timeline events (sample data)', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Show sample events' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__oac.chart.eventMarkers()?.events().length ?? 0)).toBe(3);
  // The samples sit part way through the loaded history, which may be off screen.
  await page.evaluate(() => {
    const { chart, app } = (window as any).__oac;
    const time = chart.eventMarkers().events().find((event: { id: string }) => event.id === 'sample-results').time;
    const index = app.currentBars.findIndex((bar: { time: number }) => bar.time >= time);
    chart.setVisibleLogicalRange({ from: index - 60, to: index + 40 });
  });
  const point = await page.evaluate(() => new Promise<{ x: number; y: number } | null>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
    const { chart } = (window as any).__oac;
    const markers = chart.eventMarkers();
    const rect = document.getElementById('chart')!.getBoundingClientRect();
    // The badge sits on its event's time, somewhere down that column.
    const at = Math.round(chart.timeToCoordinate(markers.events().find((event: { id: string }) => event.id === 'sample-results').time));
    for (let y = 0; y < rect.height; y++) for (let x = at - 6; x <= at + 6; x++) {
      const hit = markers.hitTest(x, y);
      if (hit && markers.detailsForHit(hit.externalId)?.events[0].id === 'sample-results') { resolve({ x: rect.left + x, y: rect.top + y }); return; }
    }
    resolve(null);
  }))));
  expect(point).not.toBeNull();
  await page.mouse.click(point!.x, point!.y);
  const dialog = page.getByRole('dialog', { name: 'Event details' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.oac-event-details__subhead')).toHaveText('Sample highlights');
  await expect(dialog.locator('.oac-event-details__list li').last()).toHaveText('Markup such as <b>this</b> stays text');
  await expect(dialog.locator('.oac-event-details__content b')).toHaveCount(0);
  await expect(dialog.locator('a')).toHaveAttribute('href', 'https://marketcalls.github.io/openalgo-charts/docs/events/');
  await page.screenshot({ path: info.outputPath('demo-event-details.png') });

  const time = await page.evaluate(() => (window as any).__oac.chart.eventMarkers()?.events().find((event: { id: string }) => event.id === 'sample-results').time);
  await dialog.getByRole('button', { name: 'Mark on chart', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).__oac.draw.drawings()
    .filter((d: { tool: string }) => d.tool === 'vertical-line').map((d: { points: Array<{ time: number }> }) => d.points[0].time))).toEqual([time]);
  await page.screenshot({ path: info.outputPath('demo-event-marked.png') });
  expect(errors).toEqual([]);
});
