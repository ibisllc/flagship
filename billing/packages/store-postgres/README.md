# @ibisllc/billing-store-postgres

A PostgreSQL `MeterStore` for [`@ibisllc/billing-metering`](../metering).
Takes anything with node-postgres's `query(text, values) → { rows }`: a
`pg.Pool` (recommended), a `pg.Client`, PGlite, or a thin wrapper around
postgres.js, Neon or another driver. No dependencies of its own.

```ts
import pg from "pg";
import { PostgresMeterStore } from "@ibisllc/billing-store-postgres";

const store = new PostgresMeterStore(new pg.Pool({ connectionString: process.env.DATABASE_URL }), {
  schema: "metering",                                  // optional; default: search_path
  tables: { counters: "meter_counters", batches: "meter_batches" },
});
await store.migrate();                                 // CREATE TABLE IF NOT EXISTS
```

- Every operation, `addBatch` included, is **one statement**: atomic on any
  connection, one round trip whatever the batch size, no pool checkout.
  Batches lock counters in sorted order, so concurrent batches can't
  deadlock.
- Amounts are `BIGINT`, returned as JS numbers (exact to 2⁵³).
- Passes the full conformance suite on PGlite and on PostgreSQL servers
  (CI: 16 and 18).

BUSL-1.1, Change Date 2030-05-03 → Apache 2.0.
