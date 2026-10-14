# Writing a store

A `MeterStore` is three methods (`packages/metering/src/store.ts`):

```ts
interface MeterStore {
  add(account, resource, period, amount, now): Promise<number>;   // atomic increment → new total
  get(account, resource, period): Promise<MeterCounter | undefined>;
  addBatch?(batchId, entries, now, keepUntil): Promise<MeterBatchResult>;
}
```

The store never interprets `resource` or `period`; a new resource needs no
schema change. What it must guarantee:

- **`add`** is atomic: concurrent adds to one counter all count. Negative
  and fractional amounts floor to a whole non-negative number; a zero add
  still creates the counter. Amounts beyond 2³² must survive (store 64-bit
  integers, return plain JS numbers).
- **Keys** are compared byte for byte: case, Unicode, quotes and separator
  characters in an account id must never collide or be altered.
- **`addBatch`** (optional, needed for reports with ids) is ONE atomic step:
  if `batchId` is not on record, record it until `keepUntil` and add every
  entry as `add` would, returning the new totals in entry order (repeated
  keys give running totals); if it is on record and `keepUntil >= now`,
  change nothing and return `{ duplicate: true }`. An expired record may be
  claimed again. Concurrent sends of one id count it exactly once. The record
  holds the id and an expiry, never an account or an amount.

## The conformance suite

Every rule above is a case in `@ibisllc/billing-metering/conformance`. Each
case is `{ name, run }`, where `run` rejects with the failed expectation, so
any test runner can drive it:

```ts
// vitest / jest
import { meterStoreConformance } from "@ibisllc/billing-metering/conformance";

describe("MyStore", () => {
  for (const c of meterStoreConformance({ make: async () => freshStore() })) it(c.name, c.run);
});

// node:test
import { test } from "node:test";
for (const c of meterStoreConformance({ make: freshStore })) test(c.name, c.run);
```

- `make` returns a store with nothing recorded, once per case. Fresh tables
  per case (the stores here accept a `tables` option for that) let one
  database serve the whole run.
- `batches: false` skips the `addBatch` cases for a store that leaves it out.
- `concurrency` (default 20) sets how many writers the race cases use; run
  against a real server with a pool at least that large to make the races
  real.

Run it against the real database, not a mock: the cases are there to catch
what only the engine does (isolation, integer widths, upsert semantics).

## Patterns that pass

- **SQL with upsert + RETURNING** (SQLite 3.35+, PostgreSQL 9.5+, D1):
  `schema/meter_counters.sql` and `schema/meter_batches.sql` document the
  statements. For `addBatch`, claim the id with
  `INSERT … ON CONFLICT (batch_id) DO UPDATE … WHERE keep_until < :now
  RETURNING batch_id` and add the counters only if a row came back, in one
  transaction or one statement. In PostgreSQL, merge repeated keys before
  one multi-row upsert (a statement can't touch a row twice) and sort the
  rows so concurrent batches lock counters in the same order.
- **MySQL / MariaDB:** `INSERT … ON DUPLICATE KEY UPDATE amount = amount +
  VALUES(amount)` then a `SELECT` in the same transaction (no RETURNING);
  claim the batch id with `INSERT IGNORE` and check affected rows.
- **Redis:** `HINCRBY` per counter; `addBatch` as a Lua script
  (`SET batch:<id> 1 PXAT <keepUntil> NX`, then the increments) so it is
  atomic.
- **DynamoDB:** `UpdateItem` with `ADD amount :n` and `ReturnValues:
  UPDATED_NEW`; `addBatch` as a `TransactWriteItems` with a conditional put
  on the batch id (100 items per transaction, so split big batches across
  ids or keep reports ≤ 99 accounts).

Publishing your own store? Name it something other than `@ibisllc/…`, depend
on `@ibisllc/billing-metering` with a `^` range, and say in its README which
conformance version it passes.
