import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function readUiScale(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.style.getPropertyValue('--ui-scale'));
}

test('applies interface scale and editor font size, and persists them', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('sql-editor')).toBeVisible();
  expect(await readUiScale(page)).toBe('1');

  const statusFontSize = await page.locator('.status-bar').evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  expect(statusFontSize).toBeCloseTo(13, 1);

  await page.getByRole('button', { name: 'Вид и шрифт' }).click();
  const dialog = page.getByRole('dialog', { name: 'Вид и шрифт' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: '100%' })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.locator('.font-size-value')).toHaveText('14px');

  await dialog.getByRole('radio', { name: '125%' }).click();
  await expect(dialog.getByText(/Базовый текст интерфейса — 18px/u)).toBeVisible();
  await expect.poll(() => readUiScale(page)).toBe('1.25');
  const scaledStatus = await page.locator('.status-bar').evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  expect(scaledStatus).toBeCloseTo(16.25, 1);

  await dialog.getByRole('button', { name: 'Увеличить шрифт редактора' }).click();
  await expect(dialog.locator('.font-size-value')).toHaveText('15px');
  await expect.poll(() => page.locator('.monaco-editor .view-lines').evaluate((element) => getComputedStyle(element).fontSize)).toBe('15px');

  await dialog.getByRole('button', { name: 'Готово' }).click();
  await expect(dialog).toHaveCount(0);

  // Нативный Ctrl+wheel в headless-стенде перехватывается браузерным zoom и перезагружает
  // страницу, поэтому проверяем тот же DOM-обработчик синтетическим событием.
  await page.getByTestId('sql-editor').evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -120 }));
  });
  await expect.poll(() => page.locator('.monaco-editor .view-lines').evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px');

  await expect.poll(() => page.evaluate(() => localStorage.getItem('sqlexplorer.browser.ui-settings')))
    .toContain('"editorFontSize":16');

  await page.reload();
  await expect(page.getByTestId('sql-editor')).toBeVisible();
  await expect.poll(() => readUiScale(page)).toBe('1.25');
  await expect.poll(() => page.locator('.monaco-editor .view-lines').evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px');
});
