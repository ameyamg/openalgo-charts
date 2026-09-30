import { expect, test, type Page } from '@playwright/test';
import type { Chart, IndicatorApi } from '../../src/index';
import type * as Widgets from '../../src/widget/index';

// A built-in study on a higher timeframe (issue 22), beside the same study on
// the chart's own timeframe, and the timeframe select in its settings, listing
// the intervals its host serves.
//
// The widget draws a 15-minute EMA on a 1-minute chart of a seeded random
// walk over three NSE sessions. The reference host draws one on its own
// 5-minute fixture bars, which are a seeded random walk too.

test.use({ screenshot: 'only-on-failure', trace: 'retain-on-failure' });
type Surface = 'widget' | 'demo';
type DemoWindow = Window & { __oac: { app: { chart: Chart; loading: boolean } } };
declare global { interface Window { __htf: { chart: Chart; plain: IndicatorApi; folded: IndicatorApi; open(): void } } }

const DEMO = `http://127.0.0.1:${process.env.OAC_E2E_DEMO_PORT || '8124'}/examples/yfinance/index.html?test=1`;

async function paint(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function mount(page: Page, surface: Surface) {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1200, height: 760 });
  if (surface === 'widget') {
    await page.route('**/native-higher-timeframe.html', route => route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><html><head><style>html,body{margin:0;background:#111318}#host{height:740px;width:100%}</style></head><body><div id="host"></div></body></html>' }));
    await page.goto('/native-higher-timeframe.html');
  } else {
    await page.goto(DEMO);
    const loaded = () => page.waitForFunction(() => Boolean((window as DemoWindow).__oac?.app.chart) && !(window as DemoWindow).__oac.app.loading);
    await loaded();
    await page.getByRole('button', { name: '5M', exact: true }).click();
    await page.waitForFunction(() => (window as DemoWindow).__oac.app.chart.getDataContext()?.interval === '5m');
    await loaded();
  }
  await page.evaluate(async (kind) => {
    const widgets = await import('/dist/openalgo-charts.widget.mjs') as typeof Widgets;
    await import('/dist/openalgo-charts.indicators.mjs');
    let chart: Chart, open: (id: string) => void;
    if (kind === 'widget') {
      const widget = widgets.createWidget(document.getElementById('host')!, {
        persist: false, rail: false, symbol: 'WALK', interval: '1m', intervals: ['1m', '5m', '15m', '1h'],
        branding: false, timeNavigator: false, animZoom: false, animAutoscale: false, mobile: 'never',
      });
      chart = widget.chart;
      open = id => { widgets.mountIndicatorSettings(widget.context, undefined, { instanceId: id }); };
      // Three NSE sessions of one-minute bars, 09:15 to 15:29 IST, as a seeded random walk.
      let seed = 20260930;
      const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      const bars: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
      let close = 1840;
      for (const day of [Date.UTC(2026, 8, 28), Date.UTC(2026, 8, 29), Date.UTC(2026, 8, 30)]) {
        const openAt = day / 1000 + 3 * 3600 + 45 * 60;
        for (let m = 0; m < 375; m++) {
          const o = close;
          close = Math.round(o * (1 + (rnd() - 0.5) * 0.003 + 0.00002) * 20) / 20;
          const high = Math.round(Math.max(o, close) * (1 + rnd() * 0.0008) * 20) / 20;
          const low = Math.round(Math.min(o, close) * (1 - rnd() * 0.0008) * 20) / 20;
          bars.push({ time: openAt + m * 60, open: o, high, low, close, volume: 1000 + Math.floor(rnd() * 9000) });
        }
      }
      chart.primarySeries()!.setData(bars);
    } else {
      chart = (window as DemoWindow).__oac.app.chart;
      const host = await import('/examples/yfinance/src/indicators.js') as { openSettings(id: string): void };
      open = id => host.openSettings(id);
    }
    for (const study of [...chart.indicators()]) study.remove();
    const plain = chart.addIndicator('ema', { length: 20, color: '#7e8aa2' });
    const folded = chart.addIndicator('ema', { length: 9, timeframe: '15m', color: '#ffb300', 'ma:width': 2.5 });
    const n = chart.primarySeries()!.getData().length;
    chart.setVisibleLogicalRange({ from: n - (kind === 'widget' ? 330 : 160), to: n + 5 });
    window.__htf = { chart, plain, folded, open: () => open(window.__htf.folded.id) };
  }, surface);
  await paint(page);
  return errors;
}

function dialog(page: Page, surface: Surface) {
  const root = page.locator(surface === 'widget' ? '.oac-indset' : '#setmodal');
  return {
    root,
    timeframe: surface === 'widget' ? root.locator('select[id$="-timeframe"]') : root.locator('select[data-key="timeframe"]'),
    accept: surface === 'widget' ? root.getByRole('button', { name: 'OK', exact: true }) : root.locator('#set-ok'),
  };
}

/**
 * Where the folded line moves, as seconds after the first bar of the session it
 * moves in. A session is told from the overnight gap, so the check holds in
 * whatever zone the host draws in.
 */
async function steps(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const { chart, folded } = window.__htf;
    const times = chart.primarySeries()!.getData().map(b => b.time);
    const values = folded.values().ma;
    const at: number[] = [];
    let open = times[0];
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] > 3 * 3600) open = times[i];
      if (values[i] !== values[i - 1] && values[i - 1] !== null) at.push(times[i] - open);
    }
    return at;
  });
}

for (const surface of ['widget', 'demo'] as const) {
  test(`${surface}: a 15 minute EMA beside the chart's own, and its timeframe select`, async ({ page }, info) => {
    const errors = await mount(page, surface);
    // The folded line moves only on a bucket's first bar, counted from the
    // session open.
    const fifteen = await steps(page);
    expect(fifteen.length).toBeGreaterThan(20);
    for (const at of fifteen) expect(at % 900, `a step ${at}s after the open`).toBe(0);
    await page.screenshot({ path: info.outputPath(`${surface}-15m-ema.png`) });

    await page.evaluate(() => window.__htf.open());
    const d = dialog(page, surface);
    await expect(d.timeframe).toBeVisible();
    await expect(d.timeframe).toHaveValue('15m');
    const options = await d.timeframe.locator('option').evaluateAll(nodes => nodes.map(n => (n as HTMLOptionElement).value));
    if (surface === 'widget') expect(options).toEqual(['', '1m', '5m', '15m', '1h']);
    else expect(options).toEqual(['', '5m', '15m', '30m', '1h', '1d', '1wk', '1mo', '1q']);
    expect(await d.timeframe.locator('option').first().textContent()).toBe('Chart');
    await page.screenshot({ path: info.outputPath(`${surface}-timeframe-select.png`) });
    await d.timeframe.selectOption('1h');
    await d.accept.click();
    await expect(d.root).toBeHidden();
    expect(await page.evaluate(() => window.__htf.folded.settings().timeframe)).toBe('1h');
    await paint(page);
    const hourly = await steps(page);
    expect(hourly.length).toBeGreaterThan(5);
    for (const at of hourly) expect(at % 3600, `an hourly step ${at}s after the open`).toBe(0);
    await page.screenshot({ path: info.outputPath(`${surface}-1h-ema.png`) });
    // The chart-timeframe EMA is untouched by any of it.
    expect(await page.evaluate(() => window.__htf.plain.settings().timeframe)).toBe('');
    expect(errors).toEqual([]);
  });
}
