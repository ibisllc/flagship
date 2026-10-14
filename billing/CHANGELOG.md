# Changelog

All notable changes to the packages in this repository. They release
together at one version. Format: [Keep a Changelog](https://keepachangelog.com);
versions: [semver](https://semver.org) (see README, Versioning).

## Unreleased

### Added

- `@ibisllc/billing-store-sqlite`: `SqliteMeterStore` for node:sqlite,
  better-sqlite3 and bun:sqlite.
- `@ibisllc/billing-store-postgres`: `PostgresMeterStore` for pg, PGlite or
  any `query(text, values)` client; `addBatch` is one statement.
- `@ibisllc/billing-store-d1`: `D1MeterStore` for Cloudflare D1 and
  `d1MeterSchema()`.
- `@ibisllc/billing-metering/conformance`: `meterStoreConformance`, the
  store test suite every store here runs, for third-party stores.
- `@ibisllc/billing-metering/http`: `createReportHandler` (Request →
  Response), `bearerAuth` and `sendBatch` (spec: `docs/spec/http-v1.md`).
- `meterSchemaSql(tables?)` and `meterTableNames(tables?)`; every SQL store
  takes a `tables` option.
- Reports and leases (`docs/spec/report-and-lease-v1.md`): `meterReport`,
  `meterLease`, `LeaseBook`, the optional `MeterStore.addBatch`,
  `schema/meter_batches.sql`.
- `MeterDeps.plansOf`: an optional bulk plan lookup, used once per report.
- The `week` period (ISO 8601 weeks, `YYYY-Www`).
- Examples (`examples/`), a load test (`bench/`), adopter docs.

### Changed

- `schema/meter_batches.sql`: claiming a batch id re-claims an expired
  record in the same upsert (`ON CONFLICT … DO UPDATE … WHERE keep_until <
  :now`), so expiry no longer depends on pruning having reached the id. No
  schema change.

## 0.1.0

### Added

- `@ibisllc/billing-metering`: `meterRecord`, `meterCheck`,
  `meterPeriodKey`, `meterResetsAt`, `MeterStore`, `InMemoryMeterStore`,
  `schema/meter_counters.sql`.
