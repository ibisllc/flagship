# Scaling metering

How far the counter store goes, what to watch, and what replaces it when it
stops being enough. Written for a host on Cloudflare (Workers + D1), with
Flagship as the reference host: its `.services` relay is the edge, its `.com`
Worker is central. Nothing here is built beyond §1; §3 and §4 are the plan.

## 1. What runs today

- Edges report **batches with ids** and enforce **budget leases**
  ([spec/report-and-lease-v1.md](./spec/report-and-lease-v1.md)). A report is
  one D1 `batch()` (one transaction: prune ≤ 32 expired ids, claim the id,
  one upsert per account) plus one tier query per 100 accounts.
- Reporting is adaptive. Accounts with no lease, with half their grant spent,
  or with a lapsed lease report within ~500 ms; everyone else once per slow
  pass (60 s). Grants are ¼ of what is left, 1–256 MiB, so a busy account far
  from its allowance reports every ~128 MiB, and one near it every few MiB.
- State is aggregates only: one counter row per (account, resource, period)
  and, for an hour, each report's random id. No event log, so there is no
  usage-metadata trail to protect, subpoena or leak.

## 2. Load test

`scripts/meter-load-test.ts` in Flagship (`npx tsc -b && npx tsx
scripts/meter-load-test.ts`) drives the real `/api/usage/report` handler over
10,000 accounts, against the in-memory store and against the production D1
adapter on node:sqlite with every migration applied. It also times the
relay's hot path (`LeaseBook.use` + `action` per 16 KiB chunk).

Measured 2026-10-13 on an Apple M4 (Node 24.2) that was shared with other
build jobs (load average 35–70 on 10 cores), so each figure is a range: the
quietest run first, the most contended last. Rerun on a quiet machine before
leaning on the upper ends.

| store                     | accounts per report | D1 calls per report | reports/s  | counter rows/s  | p50 ms    | p99 ms    |
| ------------------------- | ------------------- | ------------------- | ---------- | --------------- | --------- | --------- |
| in-memory                 | 1                   | –                   | 46k–440k   | 46k–440k        | 0.002     | 0.003–0.03 |
| D1 adapter on node:sqlite | 1                   | 2                   | 1.8k–21k   | 1.8k–21k        | 0.04–0.06 | 0.06–12   |
| in-memory                 | 50                  | –                   | 2.9k–23k   | 145k–1.2M       | 0.04      | 0.09–4    |
| D1 adapter on node:sqlite | 50                  | 2                   | 98–650     | 4.9k–32k        | 0.9–3.6   | 5–97      |
| in-memory                 | 500                 | –                   | 260–2.5k   | 130k–1.3M       | 0.35–0.9  | 0.9–65    |
| D1 adapter on node:sqlite | 500                 | 6                   | 10–108     | 4.9k–54k        | 8.6–99    | 13–208    |
| same, old wire (no id)    | 500                 | 505                 | 12–151     | 5.9k–75k        | 6.2–67    | 13–290    |

Edge hot path: 2.6M–34M chunks/s per core (29–390 ns per chunk).

Reading it:

- **Round trips matter more than SQL.** On node:sqlite a call costs
  microseconds; on D1 each is a network round trip (single-digit ms) to the
  database's one primary. A 500-account report is now **6 D1 calls**; before
  this work it was **1,000** (an upsert and a tier read per account, one at a
  time), i.e. seconds of wall time per report on real D1. The old wire, still
  accepted for the transition, costs 505.
- **The SQL ceiling is not the limit.** Even contended, our statements
  sustain ~5k counter rows/s on one core; D1's own write path (one primary,
  serialised transactions, durable commits) will cap below that, so plan on
  the D1 numbers in §3, not these.
- **The edge is free.** At 10 Gbit/s a relay carries ~76k chunks/s, under
  3% of one core at the contended rate.

## 3. Back of the envelope

Assumptions, stated so they can be replaced with measurements: 1.5 servers
per account; 20% of accounts carry public traffic in any minute; 1 GiB of
public egress per server per day on average (the free allowance is ~0.8
GiB/day); a relay machine per ~10k servers; slow pass 60 s; renewals every
128 MiB.

```
counter rows/s  = 0.2 × accounts / 60            (slow pass)
                + servers × 1 GiB / 86,400 s / 128 MiB   (renewals)
reports/s       ≤ relay machines × 2             (due passes; slow pass adds 1/60)
D1 calls/s      ≈ reports/s + rows/s / 100       (one batch + tier chunks)
rows/month      = rows/s × 2.63M                 (D1 bills writes per row)
```

| servers | accounts | relays | counter rows/s | reports/s | D1 calls/s | rows written/month | before this work (rows/s, D1 calls/s) |
| ------- | -------- | ------ | -------------- | --------- | ---------- | ------------------ | ------------------------------------- |
| 10k     | 6.7k     | 2      | ~23            | ≤ 4       | ≤ 5        | ~60M               | 67, 133                               |
| 100k    | 67k      | 10     | ~230           | ≤ 20      | ≤ 23       | ~610M              | 670, 1,330                            |
| 1M      | 670k     | 100    | ~2,300         | ≤ 200     | ≤ 225      | ~6.1B              | 6,700, 13,300                         |

("Before" = the 20 s report of every active account with two D1 calls per
account, which is what ran until this branch.)

- **10k servers:** nothing to do. D1 is idle and writes fit the included
  allowance.
- **100k servers:** comfortable on D1 (~20 transactions/s), but ~610M rows a
  month is a real bill. The cheap lever is the slow pass: report accounts far
  from their allowance every 5 min instead of 60 s (rows ÷ ~4; crash loss
  per account is still capped by its grant).
- **1M servers:** ~200 write transactions/s and ~2.3k rows/s on one D1
  primary, which also serves identity and everything else in Flagship's
  `flagship-state`. That is past what we should ask of one database, and the
  write bill (~$6k/month at $1 per million rows) is the bigger problem.
  Move to §4.

Counter table size: accounts × resources × months, ~100 B a row with its
index: 1M servers ≈ 16M rows ≈ 1.6 GB a year against D1's 10 GB cap, so old
periods get archived (they are only needed for billing disputes).

## 4. When D1 is the bottleneck: one Durable Object per account

**Triggers** (any one, sustained over a day; all from aggregate metrics, the
D1 dashboard or the relay's own counters, never per-request logs):

1. `/api/usage/report` D1 time p99 > 250 ms or p50 > 50 ms.
2. Counter rows written > 1,000/s, or metering's D1 writes > $500/month.
3. D1 "overloaded" / queue-full errors on > 0.1% of reports, or relays
   dropping batches (`droppedBatches`) outside a known outage.
4. More than ~250k servers or ~50 relay machines reporting.

**Step 0 (cheap, first):** the 5-minute slow pass above, and move
`meter_counters` + `meter_batches` to their own D1 database so metering
never queues behind identity writes.

**Step 1: `AccountMeter`, a SQLite-backed Durable Object per account**
(`idFromName(account)`). It holds, in its own storage:

```
counters (resource, period, amount)          the account's current periods
batches  (batch_id, keep_until)              ids of reports that touched it
leases   (edge_id, resource, outstanding, expires_at)
plan     (tier, fetched_at)                  cached; pushed on subscription change
```

- **Report path.** The Worker authenticates the relay and fans the batch out
  by account: `stub.report({ batchId, edgeId, items })`, concurrently. Each
  DO dedupes the batch id itself (it only ever sees ids of reports naming
  its account), adds to its counters in a local transaction (microseconds,
  no network), and answers with that account's lease.
- **Tighter leases.** A DO serialises everything for its account, so it can
  size a grant from `remaining − outstanding grants held by other edges`.
  The multi-edge overshoot `(E − 1) × maxGrant` drops to the initial-grant
  term alone. D1 can't do this without a lease table and row locks.
- **Write coalescing.** Counters live in DO storage, written per report but
  local and cheap; the DO can also hold sub-second bursts in memory and
  persist once per report batch.
- **Rollup.** A DO alarm (every 15 min, and at each period's end) writes the
  account's totals to D1 `meter_counters`, which becomes the read model for
  dashboards and billing, and drops periods it has rolled up and closed.
- **Fan-out cost.** A 500-account report becomes 500 DO calls. That is within
  a Worker's subrequest limit, and DO calls are cheap, but if it becomes the
  cost, group accounts by a hash shard (e.g. 1,024 router DOs) without
  changing the per-account state.
- **Migration.** Dual-write (D1 as today + DO) behind a flag; a DO seeds its
  current period from D1 on first touch (counters only grow, so `max` of the
  two is safe); compare totals for a period; then serve leases from DOs and
  stop the per-report D1 writes, keeping the rollup.

**If the report path ever needs buffering** (a DO or D1 regional outage
longer than the relay's 10-minute retry): Cloudflare Queues, not Kafka. The
Worker enqueues the batch `{ batchId, items }` and a consumer applies it
through the same idempotent path, so at-least-once delivery is safe. Messages
are the same aggregates the report carries, deleted on ack with a short
retention, so the queue is a buffer, not an event log. Kafka would add a
cluster to run and, worse, a retained per-report log of who used how much
and when: the usage-metadata trail the no-logs posture rules out.
