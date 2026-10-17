import { test, expect } from '@playwright/test';

for (const width of [1200, 390]) {
  for (const [unit, count, code] of [['minutes', '7', '7m'], ['months', '5', '5M']]) {
    test(`custom ${code} controls persist and remove at width ${width}`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize({ width, height: 740 });
      await page.goto('/tests/e2e/widget-mobile-fixture.html?persist&timeframes');
      const ready = () => page.waitForFunction(() => (window as any).__loaded > 0);
      const current = () => page.evaluate(() => (window as any).__widget.interval());
      const open = () => page.locator(width < 600 ? '[data-mobile-action=interval]' : '.oac-topbar__interval-menu').click();
      await ready();
      await open();
      await page.getByRole('button', { name: 'Add custom interval', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Add custom interval', exact: true });
      const add = dialog.getByRole('button', { name: 'Add', exact: true });
      await expect(add).toBeDisabled();
      await dialog.getByLabel('Type', { exact: true }).selectOption('seconds');
      await dialog.getByLabel('Interval', { exact: true }).fill('5');
      await expect(add).toBeDisabled();
      await expect(dialog.getByRole('status')).toContainText('cannot build');
      await dialog.getByLabel('Type', { exact: true }).selectOption(unit!);
      await dialog.getByLabel('Interval', { exact: true }).fill(count!);
      await expect(add).toBeEnabled();
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(740);
      await dialog.screenshot({ path: info.outputPath(`dialog-${code}-${width}.png`) });
      await add.click();
      await expect.poll(current).toBe(code);
      await open();
      const menu = page.getByRole('dialog', { name: 'Timeframes', exact: true });
      const favorite = menu.locator(`[data-favorite="${code}"]`);
      const remove = menu.locator(`[data-remove-interval="${code}"]`);
      await favorite.scrollIntoViewIfNeeded();
      const before = await remove.boundingBox();
      await favorite.hover();
      expect(await remove.boundingBox()).toEqual(before);
      await favorite.click();
      await expect(favorite).toHaveAttribute('aria-pressed', 'true');
      await menu.screenshot({ path: info.outputPath(`picker-${code}-${width}.png`) });
      await page.keyboard.press('Escape');
      await page.reload(); await ready();
      await expect.poll(current).toBe(code);
      await open();
      await expect(favorite).toHaveAttribute('aria-pressed', 'true');
      await remove.click();
      await expect(remove).toBeHidden();
      await page.keyboard.press('Escape');
      await page.reload(); await ready();
      await expect.poll(current).toBe(code);
      await open();
      await expect(remove).toBeHidden();
      expect(errors).toEqual([]);
    });
  }
}
