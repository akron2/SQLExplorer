# Тестовый Oracle SQLExplorer

Oracle 21c XE, отдельный контейнер `sqlexplorer-oracle21`. Данные хранятся в томе `sqlexplorer_oracle21_data`, физически внутри хранилища Docker на D:.

Конфигурация не содержит паролей. Docker Compose читает их из `../../.local/oracle/admin-password.txt` и `../../.local/oracle/app-password.txt`. Файл `.local/oracle/connection.json` содержит все параметры для локального подключения и исключён из контроля версий.

## Управление

Команды выполняются из корня проекта `D:\work_traf\CODE\SQLExplorer`:

```powershell
docker compose -f infra/oracle/compose.yaml up -d
docker compose -f infra/oracle/compose.yaml ps
docker compose -f infra/oracle/compose.yaml logs --tail 50 oracle
docker compose -f infra/oracle/compose.yaml stop
docker compose -f infra/oracle/compose.yaml start
```

Остановка контейнера сохраняет данные. Наличие постоянного тома не заменяет резервное копирование при переносе или удалении окружения.

## Подключение

| Поле | Значение |
|---|---|
| Host | `127.0.0.1` |
| Port | `1521` |
| Service name | `XEPDB1` |
| User | `SQLX` |
| Role | Normal |
| TNS alias | `SQLX_LOCAL` |
| OCI library для Windows | `D:\Oracle\instantclient_19_32\oci.dll` |

Подключение через SQL*Plus с запросом пароля:

```powershell
& 'D:\Oracle\instantclient_19_32\sqlplus.exe' -L SQLX@//127.0.0.1:1521/XEPDB1
```

Копия `tnsnames.ora` установлена в `D:\Oracle\instantclient_19_32\network\admin`. Service name используется для подключения обычного пользователя к PDB; SID `XE` относится к экземпляру и не заменяет `XEPDB1` в этом подключении.

Для PL/SQL Developer 17 откройте Preferences → Oracle → Connection и укажите OCI Library `D:\Oracle\instantclient_19_32\oci.dll`. Если программа была запущена до установки клиента, перезапустите её после сохранения своей работы. В поле Database можно использовать `127.0.0.1:1521/XEPDB1`; имя пользователя — `SQLX`, роль — Normal.

## Учебные объекты

`seed.sql` создаёт две таблицы с PK/FK, представление, последовательность, синоним и пакет с функцией и процедурой. Данные вымышлены. Скрипт предназначен для первого заполнения новой схемы SQLX; повторный запуск поверх существующих таблиц завершится ошибкой, а не удалит данные.

Текущий статус установки и результаты проверок находятся в [описании окружения](../../docs/oracle-test-environment.md).
