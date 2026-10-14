# Scaling metering

How far each counter store goes, what to watch, and what replaces it when it
stops being enough. Hosts differ, so the arithmetic in §3 is written to have
its assumptions swapped for your own measurements.

## 1. The shape that scales

- Edges report **batches with ids** and enforce **budget leases**
  ([spec/report-and-lease-v1.md](./spec/report-and-lease-v1.md)). A report is
  one store transaction (prune ≤ 32 expired ids, claim the id, one upsert per
  account) plus the host's plan lookup (`plansOf`, ideally one query per
  report).
- Reporting is adaptive. Accounts with no lease, with half their grant spent,
  or with a lapsed lease report within a due pass (the reference edge: every
  500 ms); everyone else once per slow pass (60 s). With grants of ¼ of what
  is left, clamped to [minGrant, maxGrant], a busy account far from its
  allowance reports every `maxGrant / 2`, one near it every few `minGrant`s.
- State is aggregates only: one counter row per (account, resource, period)
  and, for `keepMs`, each report's random id. No event log, so there is no
  usage-metadata trail to protect, subpoena or leak.

What it costs per report, by store:

| store                       | round trips per report             | atomicity                          |
| --------------------------- | ---------------------------------- | ---------------------------------- |
| `InMemoryMeterStore`        | none                               | one process only                   |
| `SqliteMeterStore`          | none (in process)                  | `BEGIN IMMEDIATE` transaction      |
| `PostgresMeterStore`        | 1 (one statement, any batch size)  | the statement                      |
| `D1MeterStore`              | 1 (`batch()`, any batch size)      | the D1 batch                       |

Plus your plan lookup. A host that looks plans up one account at a time
turns a 500-account report into 501 round trips; implement `plansOf`.

## 2. Load test

`bench/report-load.mjs` (`npm run build && npm run bench`) drives
`meterReport` + `meterLease` over 10,000 accounts on each store at three
report sizes, and times the edge hot path (`LeaseBook.use` + `action` per
16 KiB chunk). Set `BILLING_TEST_PG_URL` to include a PostgreSQL server.

Measured 2026-10-14 on an Apple M4 (Node 24.2, load average 3–7 from other
work; PostgreSQL 18.4 on the same machine over TCP loopback):

| store                           | accounts per report | reports/s | counter rows/s | p50 ms | p99 ms |
| ------------------------------- | ------------------- | --------- | -------------- | ------ | ------ |
| in-memory                       | 1                   | 634k      | 634k           | 0.00   | 0.00   |
| in-memory                       | 50                  | 27k       | 1.37M          | 0.03   | 0.06   |
| in-memory                       | 500                 | 2.8k      | 1.41M          | 0.34   | 0.89   |
| SQLite (node:sqlite, in memory) | 1                   | 119k      | 119k           | 0.01   | 0.01   |
| SQLite (node:sqlite, in memory) | 50                  | 7.8k      | 390k           | 0.13   | 0.15   |
| SQLite (node:sqlite, in memory) | 500                 | 859       | 430k           | 1.17   | 1.30   |
| PostgreSQL (PGlite, WASM)       | 1                   | 2.6k      | 2.6k           | 0.37   | 0.63   |
| PostgreSQL (PGlite, WASM)       | 50                  | 1.5k      | 73k            | 0.67   | 0.82   |
| PostgreSQL (PGlite, WASM)       | 500                 | 235       | 117k           | 4.1    | 10     |
| PostgreSQL 18 server            | 1                   | 3.4k      | 3.4k           | 0.29   | 0.51   |
| PostgreSQL 18 server            | 50                  | 1.9k      | 94k            | 0.52   | 0.73   |
| PostgreSQL 18 server            | 500                 | 297       | 148k           | 3.2    | 7.3    |

Edge hot path: ~22M chunks/s on one core (45 ns per chunk).

Reading it:

- **Batch, always.** Every store does far more counter rows per second in
  big reports than in small ones; the per-report overhead (a transaction, a
  round trip) dominates single-account reports.
- **Round trips matter more than SQL.** On loopback a round trip costs a
  fraction of a millisecond; to a hosted database (D1's single primary, a
  managed Postgres in another zone) it is milliseconds, so plan on
  `reports/s ≈ 1 / RTT` per concurrent reporter, and size reports to carry
  many accounts. Before batch ids and `plansOf`, the same 500-account report
  cost 1,000 round trips (an upsert and a plan read per account); now it is
  one store call and one plan query.
- **The edge is free.** At 10 Gbit/s an edge sees ~76k chunks of 16 KiB per
  second, well under 1% of a core.

## 3. Back of the envelope

Write down your own assumptions; these are placeholders:

```
A   accounts
a   share of accounts active in a minute            (e.g. 0.2)
u   average metered units per active account per s  (e.g. bytes/s)
g   typical grant renewal size, maxGrant / 2         (e.g. 128 MiB)
E   edge machines; s slow pass (60 s); d due pass (0.5 s)

counter rows/s  ≈ a × A / s                (slow pass)
                + a × A × u / g            (renewals)
reports/s       ≤ E / d + E / s            (one due + one slow batch each)
store calls/s   ≈ reports/s × (1 + plan queries per report)
rows/month      ≈ rows/s × 2.63M           (what row-billed stores charge for)
```

For example, 1M accounts, a = 0.2, 1 GiB/day per active account, g = 128
MiB, 100 edges: ~3.3k rows/s from the slow pass plus ~19 rows/s from
renewals, ≤ 200 reports/s, ~8.8B rows written a month. The slow pass
dominates, which points at the first lever below.

- **Slow-pass interval** is the cheap lever: report accounts far from their
  allowance every 5 minutes instead of every 60 s (rows ÷ 5); crash loss per
  account is still capped by its grant.
- **Counter table size** is accounts × resources × periods, ~100 B a row with
  its index. Archive closed periods once billing for them is settled.
- **Isolation:** give metering its own database (or at least its own
  connection pool) so reports never queue behind your other writes.

## 4. When one database is the bottleneck

**Triggers** (any one, sustained over a day; all from aggregate metrics,
never per-request logs):

1. Report handling p99 > 250 ms or p50 > 50 ms at the store.
2. Counter rows written > ~1,000/s on a single-primary store, or the write
   bill becomes a line item you watch.
3. Store overload errors on > 0.1% of reports, or edges dropping batches
   (`LeaseBook.droppedBatches`) outside a known outage.

**Step 0:** the longer slow pass and a dedicated metering database above.

**Step 1: one actor per account.** Shard by account into something that
serialises an account's operations: a Cloudflare Durable Object per account
(`idFromName(account)`), an Orleans/Akka actor, or a Postgres partition
keyed by account hash. Each holds:

```
counters (resource, period, amount)          the account's current periods
batches  (batch_id, keep_until)              ids of reports that touched it
leases   (edge_id, resource, outstanding, expires_at)
plan     (plan, fetched_at)                  cached; pushed on subscription change
```

- **Report path.** Central authenticates the edge and fans the batch out by
  account, concurrently. Each actor dedupes the batch id itself (it only
  sees ids of reports naming its account), adds to its counters locally and
  answers with that account's lease. Each actor is a `MeterStore` of its
  own; the core functions run unchanged inside it.
- **Tighter leases.** An actor serialises everything for its account, so it
  can size a grant from `remaining − outstanding grants held by other
  edges`. The multi-edge overshoot `(E − 1) × maxGrant` drops to the
  initial-grant term alone.
- **Rollup.** On a timer (e.g. every 15 min, and at each period's end) the
  actor writes the account's totals to a shared `meter_counters` table,
  which becomes the read model for dashboards and invoicing.
- **Fan-out cost.** A 500-account report becomes 500 actor calls; if that
  becomes the cost, route through a fixed number of shard actors (e.g. 1,024
  by account hash) without changing the per-account state.
- **Migration.** Dual-write behind a flag; an actor seeds its current period
  from the shared table on first touch (counters only grow, so `max` of the
  two is safe); compare totals for a period; then serve leases from the
  actors and keep only the rollup writes.

**If the report path ever needs buffering** (a store outage longer than the
edges' retry window): a managed queue, consumed through the same idempotent
`meterReport`, so at-least-once delivery is safe. Keep message retention
short: the messages are aggregates, but a long-retained queue is still a
per-report log of who used how much and when, which the aggregates-only
design otherwise avoids. Prefer that to a retained event log such as Kafka.
