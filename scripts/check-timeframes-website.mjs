/** Check the published custom-interval example using the same gate as the local export. */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, firefox, webkit, expect } from '@playwright/test';

const base = (process.argv[2] ?? 'http://127.0.0.1:4174/openalgo-charts').replace(/\/$/, '');
const output = process.env.OAC_ARTIFACT_DIR ?? 'artifacts';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await mkdir(output, { recursive: true });
const engines = { chromium, firefox, webkit };
for (const name of (process.env.OAC_WEBSITE_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
  const browser = await engines[name].launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultNavigationTimeout(60_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto(base + '/docs/custom-intervals/');
    expect(response.status()).toBe(200);
    const demo = page.locator('.oac-example').filter({ hasText: 'Sixty seven-minute candles' });
    await demo.scrollIntoViewIfNeeded();
    await expect(demo.locator('.oac-example__loading')).toHaveCount(0);
    await expect(demo.locator('.oac-example__err')).toHaveCount(0);
    await expect(demo.getByRole('application')).toHaveCount(1);
    const candlePixels = () => demo.locator('canvas').evaluateAll(canvases => {
      let total = 0;
      for (const canvas of canvases) {
        const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; pixels && i < pixels.length; i += 4) {
          const [r, g, b, a] = pixels.slice(i, i + 4);
          if (a > 100 && ((r > g * 1.4 && r > b * 1.4) || (g > r * 1.5 && g > b * 1.03))) total++;
        }
      }
      return total;
    });
    await expect.poll(candlePixels).toBeGreaterThan(500);
    await demo.screenshot({ path: join(output, `custom-intervals-${name}-light.png`) });
    await page.getByRole('button', { name: 'Toggle color theme', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(demo.locator('.oac-example__err')).toHaveCount(0);
    await expect.poll(candlePixels).toBeGreaterThan(500);
    await demo.screenshot({ path: join(output, `custom-intervals-${name}-dark.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await demo.scrollIntoViewIfNeeded();
    expect(await demo.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await expect.poll(candlePixels).toBeGreaterThan(200);
    await demo.screenshot({ path: join(output, `custom-intervals-${name}-mobile.png`) });
    await expect(page.getByText(`OpenAlgo Charts ${version}`, { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    console.log(`${name}: custom candles, both themes and narrow layout passed`);
  } finally { await browser.close(); }
}
