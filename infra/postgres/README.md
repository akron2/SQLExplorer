# Тестовый PostgreSQL SQLExplorer

Для разработки используется отдельная база `sqlexplorer_dev` и роль `sqlx_dev` в разрешённом тестовом контейнере `confluence-postgres`. Объекты другого проекта не изменяются.

Реквизиты локального подключения находятся в `.local/postgres/connection.json`, который исключён из Git. Начальные вымышленные данные и объекты создаёт [seed.sql](seed.sql); скрипт допускает повторный запуск.

Проверка доступности:

```powershell
docker exec confluence-postgres pg_isready
```

Приложение подключается с Windows к `127.0.0.1:5432`. Тесты выполняются только в базе `sqlexplorer_dev`.
