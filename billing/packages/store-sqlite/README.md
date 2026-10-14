# @ibisllc/billing-store-sqlite

A SQLite `MeterStore` for [`@ibisllc/billing-metering`](../metering). Works
with `node:sqlite` (Node 22.13+), better-sqlite3, bun:sqlite, or any driver
with synchronous `prepare(sql).get/run(...)` and `exec(sql)`. No
dependencies of its own.

```ts
import { DatabaseSync } from "node:sqlite";          // or: import Database from "better-sqlite3"
import { SqliteMeterStore } from "@ibisllc/billing-store-sqlite";

const db = new DatabaseSync("meter.db");
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
const store = new SqliteMeterStore(db);               // { tables: { counters, batches } } to rename
store.migrate();                                     // CREATE TABLE IF NOT EXISTS
```

- `add` / `get` are one statement each; `addBatch` is one `BEGIN IMMEDIATE`
  transaction, so several processes on one file stay correct (give them a
  `busy_timeout`). Don't call it inside your own open transaction on the
  same connection.
- Passes the full conformance suite on node:sqlite and better-sqlite3,
  including two connections sharing one file.

BUSL-1.1, Change Date 2030-05-03 → Apache 2.0.
