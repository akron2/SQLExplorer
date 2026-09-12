# SQLExplorer

Кроссплатформенный настольный SQL-клиент для Oracle и PostgreSQL. Текущая версия включает редактор Monaco, независимые SQL-вкладки и транзакции, управляемые профили соединений, одновременные Oracle Thin/Thick runtime, PostgreSQL, честные состояния сессий, порционные результаты и работу с SQL-файлами разных кодировок.

Проектные решения находятся в [docs/architecture.md](docs/architecture.md), подробный план базовых сценариев — в [docs/core-workflows-development-plan.md](docs/core-workflows-development-plan.md), фактический статус — в [docs/implementation-status.md](docs/implementation-status.md), а весь незавершённый объём — в едином [бэклоге](docs/backlog.md).

## Быстрый запуск на Windows

В проекте закреплён Node.js 24.21 LTS. Проверенная локальная копия находится в `.local/toolchains` и автоматически используется скриптом:

```powershell
.\scripts\dev.ps1
```

Для первого запуска после чистого клонирования:

```powershell
npm install
npm start
```

`npm install` скачивает проверяемый Electron runtime. Системный Node должен соответствовать `.node-version`.

## Проверки

```powershell
npm run verify        # lint, TypeScript, модульные тесты
npm run test:ui       # браузерные сценарии интерфейса и 100 документов
npm run build         # production-бандлы
npm run test:db       # Oracle Thin/Thick/TNS/SYSDBA, PostgreSQL, paging, rollback, cancel, reconnect
npm run package       # нативный пакет текущей ОС
npm run test:electron # Electron UI и восстановление 100 документов
npm run test:package  # ASAR, renderer, UtilityProcess и полная DB-матрица в упакованном exe
```

## Линейные окончания (EOL) и чистый Git

Добавлен `.gitattributes`, который принудительно хранит текстовые файлы с `LF`, чтобы не ловить шум от `LF -> CRLF` при коммитах на Windows.

После изменения `.gitattributes` можно безопасно обновить индекс с учётом новых правил:

```powershell
git add --renormalize .
```

Windows-сборка создаётся в `out/release/SQLExplorer-win32-x64`. В локальном окружении её можно запустить с тестовыми профилями так:

```powershell
.\scripts\run-packaged.ps1
```

Файлы `.local/oracle` и `.local/postgres` используются только как development/test fixtures и исключены из Git и production package. Профили, созданные из интерфейса, находятся в SQLite пользователя; сохранённые пароли шифруются Electron `safeStorage` и не возвращаются в renderer.

## Что уже работает

- Один смонтированный Monaco Editor независимо от числа скрытых вкладок; модели создаются лениво.
- Выполнение выделения или текущего SQL-выражения по `F8`/`Ctrl+Enter`.
- Создание, проверка, редактирование и удаление Oracle/PostgreSQL-профилей из интерфейса.
- Oracle Thin и несколько изолированных Thick runtime одновременно; host/port/service, TNS alias, custom connect string и парольный SYSDBA.
- Настраиваемые глобальный каталог Oracle Net, override профиля и список установок Oracle Client; `tnsnames.ora` читается, но не изменяется.
- PostgreSQL через `pg`/`pg-cursor`; драйверы работают в отдельных Electron UtilityProcess.
- Закреплённая сессия и ручной Commit/Rollback для каждой вкладки, явные Connect/Reconnect/Disconnect и состояние `lost/outdated`.
- Нет периодических ping и скрытого повторного выполнения SQL после connection-level error.
- Отмена активных запросов, порции до 1000 строк и явный `NULL`.
- Дерево объектов и контекстные подсказки колонок по алиасу.
- Создание вкладки для выбранного профиля левым кликом, стрелкой, правым кликом или клавиатурой.
- Видимые Open/Save/Save As/Save All, системные диалоги, tab context menu, drag-and-drop и recent files.
- Сохранение UTF BOM, кодировки и CRLF/LF/CR; UTF-8/16/32, Windows code pages, CP866, KOI8 и другие iconv-кодировки с ручным override и preview.
- Защита от внешнего изменения файла, непредставимых символов legacy-кодировки и потери dirty-документов/транзакций при закрытии.
- CSV, копирование, светлая/тёмная тема, кэш реальных метаданных и SQLite-восстановление рабочей области.
- Проверочный режим `--perf-documents=100` и запись метрик первых кадров/восстановления окна.

## Текущие границы

Единственный актуальный список незавершённых функций, дефектов, проверок и открытых продуктовых решений находится в [docs/backlog.md](docs/backlog.md). Другие документы объясняют архитектуру и историю решений, но не заменяют этот список.

Production-приложение не переносит локальные test fixtures; для разработки упакованной сборки используется `run-packaged.ps1`.
