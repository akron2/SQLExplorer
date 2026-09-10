import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const projectRoot = process.cwd();

test('starts the Electron shell and executes against both live databases', async ({ browserName: _browserName }, testInfo) => {
  const application = await electron.launch({
    executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      SQLX_TEST_USER_DATA: testInfo.outputPath('user-data'),
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByTestId('sql-editor')).toBeVisible();
    await expect(page.getByText('SQLExplorer').first()).toBeVisible();

    const versions = await application.evaluate(({ app }) => ({
      electron: process.versions.electron,
      node: process.versions.node,
      version: app.getVersion(),
    }));
    expect(versions).toMatchObject({ electron: '44.3.0', version: '0.1.0' });

    await page.getByRole('button', { name: /Выполнить/u }).click();
    await expect(page.getByText('Alex Demo')).toBeVisible();

    await page.getByRole('button', { name: /^P Объекты\.sql/u }).click();
    await page.getByRole('button', { name: /Выполнить/u }).click();
    await expect(page.locator('.result-status')).toContainText('rows fetched');
    await expect(page.locator('.rdg').getByText('departments')).toBeVisible();

    const diagnostics = await page.evaluate(() =>
      (window as Window & { __SQLX_DIAGNOSTICS__?: unknown }).__SQLX_DIAGNOSTICS__,
    );
    expect(diagnostics).toMatchObject({ editorInstances: 1, modelCount: 2 });
    await page.screenshot({ path: testInfo.outputPath('electron-workspace.png') });
  } finally {
    await application.close();
  }
});

test('restores an Electron window with 100 documents and one editor', async ({ browserName: _browserName }, testInfo) => {
  const application = await electron.launch({
    executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [projectRoot, '--perf-documents=100'],
    cwd: projectRoot,
    env: {
      ...process.env,
      SQLX_TEST_USER_DATA: testInfo.outputPath('user-data'),
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByTestId('sql-editor')).toBeVisible();
    await expect.poll(async () => page.evaluate(() =>
      (window as Window & {
        __SQLX_DIAGNOSTICS__?: { documentCount: number; editorInstances: number; modelCount: number };
      }).__SQLX_DIAGNOSTICS__,
    )).toMatchObject({ documentCount: 100, editorInstances: 1, modelCount: 1 });

    const browserWindow = await application.browserWindow(page);
    await browserWindow.evaluate((window: { minimize(): void }) => {
      window.minimize();
    });
    await page.waitForTimeout(250);
    const startedAt = Date.now();
    await browserWindow.evaluate((window: { restore(): void }) => {
      window.restore();
    });
    await expect(page.getByTestId('sql-editor')).toBeVisible();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  } finally {
    await application.close();
  }
});
