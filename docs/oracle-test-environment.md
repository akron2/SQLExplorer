# Локальный тестовый Oracle

Дата: 2026-09-09. Статус: Oracle установлен, контейнер healthy, подключение с Windows и сохранность данных проверены.

## Назначение и ограничения

Пользователь поручил установить Oracle для изучения PL/SQL Developer 17 и проверки SQLExplorer, предпочтительно версии 19c. Разрешена установка в Docker. Крупные загрузки и данные должны размещаться на диске D:.

Подготовка тестовой БД является отдельной задачей инфраструктуры. Реализация приложения SQLExplorer пока не начата.

## Установленное окружение

- Windows 10 Pro x64; около 24 GiB RAM.
- Docker Desktop использует Linux-контейнеры через WSL2, архитектура amd64.
- Хранилище образов и томов Docker: `D:\Docker\DockerDesktopWSL\disk\docker_data.vhdx`.
- На момент начала установки на D: было свободно около 461 GiB. Порт 1521 выделен этому стенду.
- Контейнер `confluence-postgres` продолжает работать на порту 5432, его контейнер и том не изменялись; состояние healthy проверено после установки Oracle. Позднее пользователь уточнил: это тестовый сервер другого проекта, который разрешено использовать и для SQLExplorer. [Сведения о PostgreSQL](postgres-test-environment.md).

## Выбор версии

Попытка получить официальный образ `container-registry.oracle.com/database/enterprise:19.3.0.0` завершилась ответом реестра `401 Unauthorized`: требуется вход в Oracle Container Registry.

Поскольку исходный запрос допускает другую версию и называет 19c предпочтением, установлен общедоступный Oracle 21c XE. Это рабочий выбор в рамках исходного запроса, а не подтверждённый ответ на уточняющий вопрос. Фактическая версия по запросу к серверу: **Oracle Database 21c Express Edition, 21.3.0.0.0**.

Образ: `gvenzl/oracle-xe:21-slim-faststart`, linux/amd64. Digest зафиксирован и проверен: `sha256:f82bccdf6020d27373fdf0e93046b63eb3f777a0289e329d9839feebaf4555de`. Для проверки именно 19c потребуется отдельный стенд после получения доступа к его образу. Тестовый XE не определяет минимальные поддерживаемые версии SQLExplorer.

Источник сборки 19c: [oracle/docker-images](https://github.com/oracle/docker-images/tree/main/OracleDatabase/SingleInstance). Источник образа XE: [gvenzl/oci-oracle-xe](https://github.com/gvenzl/oci-oracle-xe).

## Размещение и конфигурация

- Контейнер `sqlexplorer-oracle21` и постоянный том `sqlexplorer_oracle21_data`.
- Listener доступен только с этой машины: `127.0.0.1:1521`.
- Проверенные пределы контейнера: 4 GiB RAM, 2 CPU и 1 GiB shared memory; на штатную остановку выделено 60 секунд.
- Отдельный обычный пользователь `SQLX` в PDB `XEPDB1` для тестов; SYS/SYSTEM используются только для настройки стенда.
- Конфигурация запуска хранится в [compose.yaml](../infra/oracle/compose.yaml); пароли — в `.local/oracle`, исключённом через `.gitignore`. Доступ к каталогу паролей ограничен текущей учётной записью Windows и SYSTEM. В контейнер пароли передаются через файлы Docker Compose secrets.
- Скачиваемые архивы, дополнительные клиентские библиотеки и временные файлы установки размещаются на D:.
- Данные находятся в `/opt/oracle/oradata` внутри именованного тома. Физический файл Docker на D: после установки занимает около 50.4 GiB и также содержит существующие образы и контейнеры пользователя.

## Подключение

| Поле | Значение |
|---|---|
| Host | `127.0.0.1` |
| Port | `1521` |
| Service name / PDB | `XEPDB1` |
| Database / Easy Connect | `127.0.0.1:1521/XEPDB1` |
| TNS alias | `SQLX_LOCAL` |
| Username | `SQLX` |
| Role | Normal |
| Пароль и полные параметры | [Локальный connection.json](../.local/oracle/connection.json) |

SYS/SYSTEM не нужны для обычной работы с учебной схемой. Пароли не включены в этот документ или конфигурацию Compose.

## Клиент для Windows

Oracle Instant Client Basic 19.32 и SQL*Plus 19.32 установлены в `D:\Oracle\instantclient_19_32`. Архивы скачаны с сайта Oracle в `D:\Oracle\downloads`, SHA256 обоих файлов проверены по опубликованным значениям. SQL*Plus запускается и успешно подключается к контейнеру.

Используется полный Basic, чтобы не ограничивать поддержку кодировок вариантом Basic Light. [Официальная страница клиента](https://www.oracle.com/database/technologies/instant-client/winx64-64-downloads.html).

Для PL/SQL Developer 17 в Preferences → Oracle → Connection можно выбрать OCI Library `D:\Oracle\instantclient_19_32\oci.dll`. Копия tnsnames.ora находится в `D:\Oracle\instantclient_19_32\network\admin`. Если Developer был открыт до установки клиента, его нужно перезапустить после сохранения работы. При продолжении осмотра отдельный экземпляр Developer успешно подключён параметрами запуска InstantClient и UserID; настройки Oracle исходного профиля не менялись. [Результаты проверок интерфейса](plsql-developer-review.md).

## Учебная схема и проверки

В SQLX созданы таблицы `DEPARTMENTS` и `EMPLOYEES` с PK/FK, представление `EMPLOYEE_DETAILS`, последовательность `EMPLOYEE_ID_SEQ`, синоним `STAFF` и пакет `DEMO_PKG` с функцией и процедурой, возвращающей REF CURSOR. В таблицах находятся вымышленные данные: 2 отдела и 3 сотрудника. Исходник: [seed.sql](../infra/oracle/seed.sql).

Проверено через SQL*Plus 19.32 на Windows:

- Вход обычным пользователем SQLX в XEPDB1 через TCP и TNS alias.
- Чтение таблиц, представления/синонима и наличие корректных объектов схемы.
- Работа PL/SQL-функции и процедуры с REF CURSOR.
- Откат тестовой вставки без изменения исходных учебных данных.
- Передача кириллицы, десятичных значений и timestamp с микросекундами.
- Повторное подключение и сохранение учебных данных и пакета после пересоздания контейнера с тем же томом.

На этой машине открытие базы после запуска контейнера занимало примерно три минуты. Во время запуска status может быть starting; перед подключением следует дождаться healthy. Это наблюдение о старте Oracle, а не измерение отзывчивости SQLExplorer.

## Управление

Команды из корня проекта:

```powershell
docker compose -f infra/oracle/compose.yaml ps
docker compose -f infra/oracle/compose.yaml stop
docker compose -f infra/oracle/compose.yaml start
docker compose -f infra/oracle/compose.yaml up -d
```

Остановка сохраняет данные. Подробности подключения и состава файлов: [infra/oracle/README.md](../infra/oracle/README.md).
