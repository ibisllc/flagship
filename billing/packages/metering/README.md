# @ibisllc/billing-metering

Per-account usage metering: resources, periods, per-plan allowances and
over-allowance policies (`allow` / `throttle` / `stop`), with a pluggable
counter store. Part of [billing](../../README.md); the model is specified
in [docs/spec/metering-v1.md](../../docs/spec/metering-v1.md).

- `meterRecord(deps, account, resource, amount, need = 0)`: add usage,
  then judge the new total (+ `need`).
- `meterCheck(deps, account, resource, need = 0)`: judge without
  recording; `need = 1` asks "is anything left?".
- `MeterStore` + `InMemoryMeterStore`; `schema/meter_counters.sql` for SQL
  stores (SQLite/D1 and PostgreSQL).

BUSL-1.1, Change Date 2030-05-03 → Apache 2.0.
