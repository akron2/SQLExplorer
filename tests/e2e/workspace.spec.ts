import { expect, test } from '@playwright/test';

test('runs an Oracle query and keeps document contexts separate', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('SQLExplorer').first()).toBeVisible();
  await expect(page.getByTestId('sql-editor')).toBeVisible();

  const diagnostics = await page.evaluate(() =>
    (window as Window & { __SQLX_DIAGNOSTICS__?: unknown }).__SQLX_DIAGNOSTICS__,
  );
  expect(diagnostics).toMatchObject({ documentCount: 3, editorInstances: 1, modelCount: 1 });

  await page.getByRole('button', { name: /Выполнить/u }).click();
  await expect(page.getByText('Alex Demo')).toBeVisible();
  await expect(page.getByText('3 rows fetched')).toBeVisible();

  await page.getByRole('button', { name: /^P Объекты\.sql/u }).click();
  await page.getByRole('button', { name: /Выполнить/u }).click();
  await expect(page.getByText('employee_audit')).toBeVisible();
  await page.getByRole('button', { name: /^O Сотрудники\.sql/u }).click();
  await expect(page.getByText('Alex Demo')).toBeVisible();
});

test('restores 100 documents with one mounted editor', async ({ page }) => {
  await page.goto('/?performance=1&documents=100&payloadKb=4');
  await expect(page.getByTestId('sql-editor')).toBeVisible();
  await expect.poll(async () => page.evaluate(() =>
    (window as Window & {
      __SQLX_DIAGNOSTICS__?: { documentCount: number; editorInstances: number; modelCount: number };
    }).__SQLX_DIAGNOSTICS__,
  )).toMatchObject({ documentCount: 100, editorInstances: 1, modelCount: 1 });
  await expect(page.locator('.document-tab')).toHaveCount(100);
});
