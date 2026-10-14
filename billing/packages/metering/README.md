# @ibisllc/billing-metering

Usage metering for any service: per-account counters, plans with
allowances and `allow` / `throttle` / `stop` policies, idempotent edge
reports and budget leases. Zero dependencies, ESM, Node 22+ / Workers /
Deno / Bun. Part of [billing](../../README.md); start with its quick start.

```ts
import { meterRecord, meterCheck, InMemoryMeterStore } from "@ibisllc/billing-metering";
```

- `meterRecord(deps, account, resource, amount, need = 0)`: add usage, then
  judge the new total (+ `need`).
- `meterCheck(deps, account, resource, need = 0)`: judge without recording;
  `need = 1` asks "is anything left?".
- `meterReport(deps, { batchId?, items })`: record an edge's batch, at most
  once per `batchId`, and judge every account in it.
- `meterLease(verdict, policy, now)`: the budget lease for a verdict.
- `LeaseBook`: an edge's in-memory leases, adaptive reporting and retries.
- `meterPeriodKey`, `meterResetsAt`: UTC periods (month, ISO week, day,
  lifetime).
- `MeterStore`, `InMemoryMeterStore`; `meterSchemaSql(tables?)` and
  `schema/*.sql` for SQL stores.

Subpaths:

- `@ibisllc/billing-metering/conformance`: `meterStoreConformance`, the
  suite every store must pass ([docs/adapters.md](../../docs/adapters.md)).
- `@ibisllc/billing-metering/http`: `createReportHandler` (Request →
  Response), `bearerAuth`, `sendBatch` ([http-v1](../../docs/spec/http-v1.md)).

Stores for real databases: `@ibisllc/billing-store-sqlite`,
`@ibisllc/billing-store-postgres`, `@ibisllc/billing-store-d1`.

Specs: [metering-v1](../../docs/spec/metering-v1.md),
[report-and-lease-v1](../../docs/spec/report-and-lease-v1.md).

BUSL-1.1, Change Date 2030-05-03 → Apache 2.0.
