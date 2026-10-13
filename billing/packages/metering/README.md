# @ibisllc/billing-metering

Per-account usage metering: resources, periods, per-plan allowances and
over-allowance policies (`allow` / `throttle` / `stop`), with a pluggable
counter store. Part of [billing](../../README.md); the model is specified
in [docs/spec/metering-v1.md](../../docs/spec/metering-v1.md).

- `meterRecord(deps, account, resource, amount, need = 0)`: add usage,
  then judge the new total (+ `need`).
- `meterCheck(deps, account, resource, need = 0)`: judge without
  recording; `need = 1` asks "is anything left?".
- `meterReport(deps, { batchId?, items })`: record an edge's batch, at most
  once per `batchId`, and judge every account in it.
- `meterLease(verdict, policy, now)`: the budget lease for a verdict.
- `LeaseBook`: an edge's in-memory leases, adaptive reporting and retries.
  Batches and leases are specified in
  [docs/spec/report-and-lease-v1.md](../../docs/spec/report-and-lease-v1.md).
- `MeterStore` + `InMemoryMeterStore`; `schema/meter_counters.sql` and
  `schema/meter_batches.sql` for SQL stores (SQLite/D1 and PostgreSQL).

BUSL-1.1, Change Date 2030-05-03 → Apache 2.0.
