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

test('creates and edits connection profiles through visible UI', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Добавить соединение' }).click();
  const dialog = page.getByRole('dialog', { name: 'Новое соединение' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Название соединения').fill('Analytics');
  await dialog.getByLabel('Тип базы данных').selectOption('postgres');
  await dialog.getByLabel('Пользователь').fill('analyst');
  await dialog.getByLabel('Пароль', { exact: true }).fill('demo-password');
  await dialog.getByLabel('Сервер PostgreSQL').fill('analytics.local');
  await dialog.getByLabel('База данных PostgreSQL').fill('warehouse');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();

  await expect(page.getByRole('button', { name: /Analytics analyst · warehouse/u })).toBeVisible();
  await page.getByRole('button', { name: /Analytics analyst · warehouse/u }).click();
  await page.getByRole('button', { name: 'Новый SQL-документ' }).click();
  await expect(page.locator('.document-tab')).toHaveCount(4);
  await expect(page.getByLabel('Соединение документа')).toHaveValue(/.+/u);
  await expect(page.getByText('Не подключено', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Подключить', exact: true }).click();
  await expect(page.getByText('Подключено', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Новый SQL-документ' }).click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Oracle local/u })).toBeVisible();
  await page.getByRole('menuitem', { name: /Oracle local/u }).click();
  await expect(page.locator('.document-tab')).toHaveCount(5);
  await page.getByRole('button', { name: 'Выбрать соединение для новой вкладки' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
});

test('exposes file actions, dirty close protection and encoding controls', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Файл/u }).click();
  await expect(page.getByRole('menuitem', { name: /Открыть/u })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Сохранить Ctrl\+S/u })).toBeVisible();
  await page.keyboard.press('Escape');

  const editor = page.getByTestId('sql-editor');
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('select 42;');
  await page.locator('.document-tab.is-active').click({ button: 'right' });
  const tabMenu = page.locator('.document-context-menu');
  await expect(tabMenu.getByRole('menuitem', { name: 'Сохранить как…' })).toBeVisible();
  await tabMenu.getByRole('menuitem', { name: 'Закрыть' }).click();
  await expect(page.getByRole('alertdialog', { name: /Закрыть Сотрудники\.sql/u })).toBeVisible();
  await page.getByRole('button', { name: 'Отмена' }).click();
  await expect(page.getByText('Сотрудники.sql', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: /^UTF8/u }).click();
  const encodingDialog = page.getByRole('dialog', { name: 'Кодировка файла' });
  await encodingDialog.getByLabel('Кодировка').fill('windows-1251');
  await encodingDialog.getByLabel('BOM').selectOption('none');
  await encodingDialog.getByRole('button', { name: 'Использовать при сохранении' }).click();
  await expect(page.getByText(/WINDOWS-1251/u).first()).toBeVisible();

  const beforeNew = await page.locator('.document-tab').count();
  await page.keyboard.press('Control+N');
  await expect(page.locator('.document-tab')).toHaveCount(beforeNew + 1);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['select 99;\r\n'], 'dragged.sql', { type: 'text/plain', lastModified: Date.now() }));
    document.querySelector('.app-shell')?.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  });
  await expect(page.getByText('dragged.sql', { exact: true }).first()).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n-- changed');
  await page.keyboard.press('Control+S');
  await expect(page.locator('.document-tab.is-active .dirty-dot')).toHaveCount(0);
});

test('requires an explicit transaction decision before closing a tab', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByTestId('sql-editor');
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText("insert into departments (department_id, department_name) values (9000, 'demo')");
  await page.getByRole('button', { name: /Выполнить/u }).click();
  await expect(page.getByRole('button', { name: 'Rollback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Отключить' }).click();
  const disconnectDialog = page.getByRole('alertdialog', { name: 'Незавершённая транзакция' });
  await expect(disconnectDialog).toBeVisible();
  await disconnectDialog.getByRole('button', { name: 'Отмена' }).click();
  await page.getByRole('button', { name: /Закрыть Сотрудники\.sql/u }).click();
  const transactionDialog = page.getByRole('alertdialog', { name: /Закрыть Сотрудники\.sql/u });
  await expect(transactionDialog.getByText('Незавершённая транзакция')).toBeVisible();
  await transactionDialog.getByRole('button', { name: 'Rollback и продолжить' }).click();
  await expect(transactionDialog.getByText('Несохранённый SQL')).toBeVisible();
  await transactionDialog.getByRole('button', { name: 'Не сохранять' }).click();
  await expect(page.getByText('Сотрудники.sql', { exact: true })).toHaveCount(0);
});

test('exposes Oracle Thin, Thick, TNS, custom addressing and SYSDBA fields', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Добавить соединение' }).click();
  const dialog = page.getByRole('dialog', { name: 'Новое соединение' });
  await expect(dialog.getByLabel('Режим Oracle')).toHaveValue('thin');
  await dialog.getByLabel('Режим Oracle').selectOption('thick');
  await expect(dialog.getByLabel('Oracle Client')).toBeVisible();
  await dialog.getByLabel('Привилегия Oracle').selectOption('sysdba');
  await expect(dialog.getByText(/административную привилегию SYSDBA/u)).toBeVisible();
  await dialog.getByLabel('Адресация Oracle').selectOption('tnsAlias');
  await expect(dialog.getByLabel('Каталог Oracle Net')).toBeVisible();
  await expect(dialog.getByLabel('TNS alias')).toBeVisible();
  await dialog.getByLabel('Адресация Oracle').selectOption('connectString');
  await expect(dialog.getByLabel('Connect string')).toBeVisible();
});
