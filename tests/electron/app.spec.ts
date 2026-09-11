import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test } from '@playwright/test';
import iconv from 'iconv-lite';

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

    const editor = page.getByTestId('sql-editor');
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText('select full_name from employees order by employee_id');
    await page.getByRole('button', { name: /Выполнить/u }).click();
    await expect(page.getByText('Alex Demo')).toBeVisible();
    await expect(page.locator('.server-status')).toHaveClass(/connected/u);

    await page.getByRole('button', { name: /PostgreSQL local/u }).first().click();
    await page.getByRole('button', { name: 'Новый SQL-документ' }).click();
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText("select tablename from pg_catalog.pg_tables where schemaname = 'public' order by tablename");
    await page.getByRole('button', { name: /Выполнить/u }).click();
    await expect(page.locator('.result-status')).toContainText('rows fetched');
    await expect(page.locator('.rdg').getByText('departments')).toBeVisible();

    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText("insert into departments (department_id, department_name) values (9997, 'Tab isolation')");
    await page.getByRole('button', { name: /Выполнить/u }).click();
    await expect(page.getByRole('button', { name: 'Rollback', exact: true })).toBeEnabled();
    await page.getByLabel('Соединение документа').selectOption('oracle-local');
    await expect(page.getByLabel('Соединение документа')).toHaveValue('postgres-local');
    await expect(page.getByText(/Сначала выполните Commit или Rollback/u)).toBeVisible();
    await page.getByRole('button', { name: 'Rollback', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Rollback', exact: true })).toBeDisabled();

    const diagnostics = await page.evaluate(() =>
      (window as Window & { __SQLX_DIAGNOSTICS__?: unknown }).__SQLX_DIAGNOSTICS__,
    );
    expect(diagnostics).toMatchObject({ editorInstances: 1, modelCount: 2 });
    const browserWindow = await application.browserWindow(page);
    await browserWindow.evaluate((window: { close(): void }) => window.close());
    const closeDialog = page.getByRole('alertdialog', { name: 'Закрыть SQLExplorer' });
    await expect(closeDialog).toBeVisible();
    await closeDialog.getByRole('button', { name: 'Отмена' }).click();
    await expect(page.getByTestId('sql-editor')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('electron-workspace.png') });
  } finally {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
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
    await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  }
});

test('persists a UI-created profile while keeping its password out of plaintext SQLite', async ({ browserName: _browserName }, testInfo) => {
  const userData = testInfo.outputPath('user-data');
  const emptyConfig = testInfo.outputPath('empty-config');
  fs.mkdirSync(emptyConfig, { recursive: true });
  const launch = () => electron.launch({
    executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [projectRoot],
    cwd: projectRoot,
    env: { ...process.env, SQLX_CONFIG_ROOT: emptyConfig, SQLX_TEST_USER_DATA: userData },
  });

  const first = await launch();
  try {
    const page = await first.firstWindow();
    await expect(page.getByText('Нет соединений', { exact: true })).toBeVisible();
    await expect(page.getByText('Нет метаданных', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Добавить соединение' }).click();
    const dialog = page.getByRole('dialog', { name: 'Новое соединение' });
    await dialog.getByLabel('Название соединения').fill('Persistent reports');
    await dialog.getByLabel('Тип базы данных').selectOption('postgres');
    await dialog.getByLabel('Пользователь').fill('reporter');
    await dialog.getByLabel('Пароль', { exact: true }).fill('never-plain-text');
    await dialog.getByLabel('Сервер PostgreSQL').fill('reports.internal');
    await dialog.getByLabel('База данных PostgreSQL').fill('reports');
    await page.screenshot({ path: testInfo.outputPath('connection-dialog.png') });
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const savedCard = page.locator('.connection-main').filter({ hasText: 'Persistent reports' });
    await expect(savedCard).toBeVisible();
    await expect(savedCard.locator('.connection-runtime')).toHaveClass(/disconnected/u);
    await expect(savedCard).toContainText('Не подключено');
  } finally {
    await first.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  }

  const databasePath = path.join(userData, 'sqlexplorer.sqlite');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const encrypted = database.prepare('SELECT encrypted_password FROM connection_secrets').get() as {
    encrypted_password: string;
  };
  const profile = database.prepare('SELECT profile_json FROM connection_profiles').get() as {
    profile_json: string;
  };
  database.close();
  expect(encrypted.encrypted_password).not.toContain('never-plain-text');
  expect(profile.profile_json).not.toContain('never-plain-text');

  const second = await launch();
  try {
    const page = await second.firstWindow();
    const profileCard = page.locator('.connection-card').filter({ hasText: 'Persistent reports' });
    await expect(profileCard).toBeVisible();
    await profileCard.hover();
    await profileCard.getByRole('button', { name: 'Изменить Persistent reports' }).click();
    const dialog = page.getByRole('dialog', { name: 'Соединение: Persistent reports' });
    await dialog.getByLabel('Название соединения').fill('Reports edited');
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(page.locator('.connection-main').filter({ hasText: 'Reports edited' })).toBeVisible();
  } finally {
    await second.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  }
});

test('opens and saves a Windows-1251 SQL file through visible controls', async ({ browserName: _browserName }, testInfo) => {
  const sourcePath = testInfo.outputPath('legacy-source.sql');
  const savedPath = testInfo.outputPath('legacy-saved.sql');
  const source = "-- Проверка кодировки: Привет мир, данные, сотрудники\r\nselect 'Привет' from dual;\r\n";
  fs.writeFileSync(sourcePath, iconv.encode(source, 'windows-1251'));
  const application = await electron.launch({
    executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [projectRoot],
    cwd: projectRoot,
    env: { ...process.env, SQLX_TEST_USER_DATA: testInfo.outputPath('user-data') },
  });
  try {
    await application.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [paths.source], bookmarks: [] });
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: paths.saved, bookmark: '' });
    }, { source: sourcePath, saved: savedPath });
    const page = await application.firstWindow();
    await page.getByRole('button', { name: 'Открыть SQL-файл' }).click();
    await expect(page.getByText('legacy-source.sql', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /WINDOWS-1251/u })).toBeVisible();
    const encodingDialog = page.getByRole('dialog', { name: 'Кодировка файла' });
    if (await encodingDialog.isVisible()) {
      await encodingDialog.getByRole('button', { name: 'Использовать при сохранении' }).click();
    }
    const editor = page.getByTestId('sql-editor');
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText("-- Изменено\nselect 'До свидания' from dual;\n");
    await page.getByRole('button', { name: /Файл/u }).click();
    await page.getByRole('menuitem', { name: /Сохранить как/u }).click();
    await expect.poll(() => fs.existsSync(savedPath)).toBe(true);
    const bytes = fs.readFileSync(savedPath);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(iconv.decode(bytes, 'windows-1251')).toBe("-- Изменено\r\nselect 'До свидания' from dual;\r\n");

    fs.writeFileSync(savedPath, iconv.encode("-- Внешнее изменение\r\nselect 7;\r\n", 'windows-1251'));
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('-- локально');
    await page.getByRole('button', { name: 'Сохранить SQL-файл' }).click();
    const conflict = page.getByRole('alertdialog', { name: 'Файл изменён на диске' });
    await expect(conflict).toBeVisible();
    await conflict.getByRole('button', { name: 'Сравнить' }).click();
    const comparison = page.getByRole('dialog', { name: 'Сравнение файла' });
    await expect(comparison.getByText('Внешнее изменение')).toBeVisible();
    await comparison.getByRole('button', { name: 'Вернуться к выбору' }).click();
    await conflict.getByRole('button', { name: 'Отмена' }).click();
  } finally {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  }
});

test('saves a dirty document from the application close guard', async ({ browserName: _browserName }, testInfo) => {
  const userData = testInfo.outputPath('user-data');
  const emptyConfig = testInfo.outputPath('empty-config');
  const savedPath = testInfo.outputPath('close-guard.sql');
  fs.mkdirSync(emptyConfig, { recursive: true });
  const application = await electron.launch({
    executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [projectRoot],
    cwd: projectRoot,
    env: { ...process.env, SQLX_CONFIG_ROOT: emptyConfig, SQLX_TEST_USER_DATA: userData },
  });
  const childProcess = application.process();
  let closedByGuard = false;
  try {
    await application.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target, bookmark: '' });
    }, savedPath);
    const page = await application.firstWindow();
    const editor = page.getByTestId('sql-editor');
    await editor.click();
    await page.keyboard.insertText('select 123;');
    const browserWindow = await application.browserWindow(page);
    await browserWindow.evaluate((window: { close(): void }) => window.close());
    const closeDialog = page.getByRole('alertdialog', { name: 'Закрыть SQLExplorer' });
    await expect(closeDialog).toBeVisible();
    await closeDialog.getByRole('button', { name: 'Сохранить все' }).click();
    await expect.poll(() => fs.existsSync(savedPath)).toBe(true);
    await expect.poll(() => childProcess.exitCode, { timeout: 10_000 }).not.toBeNull();
    closedByGuard = true;
    expect(fs.readFileSync(savedPath, 'utf8')).toBe('select 123;');
  } finally {
    if (!closedByGuard) {
      await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    }
  }
});

test('shows a lost PostgreSQL session and reconnects on the next explicit execution', async ({ browserName: _browserName }, testInfo) => {
  const application = await electron.launch({
    executablePath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [projectRoot],
    cwd: projectRoot,
    env: { ...process.env, SQLX_TEST_USER_DATA: testInfo.outputPath('user-data') },
  });
  try {
    const page = await application.firstWindow();
    const editor = page.getByTestId('sql-editor');
    await page.getByLabel('Соединение документа').selectOption('postgres-local');
    await editor.click();
    await page.keyboard.insertText('select pg_backend_pid()');
    await page.getByRole('button', { name: /Выполнить/u }).click();
    await expect(page.locator('.rdg')).toContainText('pg_backend_pid');
    const gridText = await page.locator('.rdg').innerText();
    const backendPid = Number(gridText.match(/\b\d{2,}\b/gu)?.at(-1));
    expect(backendPid).toBeGreaterThan(0);

    await page.getByRole('button', { name: /PostgreSQL local/u }).first().click();
    await page.getByRole('button', { name: 'Новый SQL-документ' }).click();
    await editor.click();
    await page.keyboard.insertText(`select pg_terminate_backend(${backendPid})`);
    await page.getByRole('button', { name: /Выполнить/u }).click();
    await expect(page.locator('.rdg')).toContainText('true');

    await page.getByRole('button', { name: /^P SQL 1/u }).click();
    const serverStatus = page.locator('.server-status');
    try {
      await expect(serverStatus).toHaveClass(/lost/u, { timeout: 2_000 });
    } catch {
      await editor.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText('select 41');
      await page.getByRole('button', { name: /Выполнить/u }).click();
      await expect(serverStatus).toHaveClass(/lost/u);
    }

    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText('select 42');
    await page.getByRole('button', { name: /Выполнить/u }).click();
    await expect(page.locator('.rdg')).toContainText('42');
    await expect(serverStatus).toHaveClass(/connected/u);
  } finally {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  }
});
