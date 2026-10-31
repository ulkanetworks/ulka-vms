---
paths:
  - "migrations/**"
  - "*/queries/**"
  - "*/db/**"
  - "core/migrate.go"
  - "deploy/clickhouse/**"
  - "sqlc.yaml"
---
# Data: Postgres and ClickHouse
Load the postgres-db skill before designing tables or writing SQL.

## Postgres
- Migrations are append-only: never edit one that has been applied; add the next number. An application built on
  Ulka VMS keeps its own files, applied after ours under its name (`core.Migrations`, `app.Extension`). `*/db` is sqlc's
  output: regenerate it, never edit it.
- Migrations run in one transaction with `lock_timeout`, so no `CREATE INDEX CONCURRENTLY` (fine at today's sizes; a
  big live table needs it outside a migration).
- SQL functions store their body as text: renaming a table means recreating every function that names it.
- Row-level security on every tenant table (`current_tenant()`). Reads across workspaces go through a narrow
  `SECURITY DEFINER` function in a migration, granted to `ulka_app` only (like `stored_minutes`). Foreign keys ignore
  RLS, so composite keys keep related rows inside one workspace.
- Lists always read and written whole with their parent live on it as JSONB (a video's captions, a
  workspace's limits) and change in one statement (append or filter in SQL), never read-modify-write in
  Go. Rows looked up on their own, updated concurrently or unique across workspaces stay tables.
- River's tables are in the `river` schema (`core.RiverSchema`); `public` holds only the application's.
- Retention is daily, each module cleaning its own tables (`retention_core`, `retention_webhooks`; video
  purges its trash). A new table that grows gets a line there. Partition `usage_records` by month past ~10M rows.

## ClickHouse
- The schema is `deploy/clickhouse/*.sql`: fresh containers and the tests run every file; existing servers need a new
  file run by hand, so every file must be safe to run twice (`IF NOT EXISTS`).
- Native types, an ORDER BY that serves the filters used, monthly partitions for TTL, async inserts.
- Rows written from a request go through `core.ClickHouseLog` (batched, drained when the API stops), never an
  insert in a handler.
- The OpenTelemetry tables are ours (`60-otel.sql`), copied from the Collector's exporter, which runs with
  `create_schema: false`.
