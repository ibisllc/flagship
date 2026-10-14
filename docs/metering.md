# Metering (Flagship wiring)

The generic core is `billing/` (`@ibisllc/billing-metering`, with the D1
store `@ibisllc/billing-store-d1`): the model is
`billing/docs/spec/metering-v1.md`, batches and leases are
`billing/docs/spec/report-and-lease-v1.md`, and growth in general is
`billing/docs/scaling.md`. This page is what Flagship plugs into it, and
Flagship's own numbers (last section).

| piece | where |
| ----- | ----- |
| resources + tier table (`egress`, `ai-tokens`) | `packages/control-plane/src/meter.ts` |
| relay ↔ `.com` contract, egress lease policy | `packages/control-plane/src/metering.ts` |
| counters | D1 `meter_counters` (migration 0069), `D1MeterStorage` (= billing's `D1MeterStore`) |
| report ids | D1 `meter_batches` (migration 0070), `D1MeterStorage.addBatch` |
| relay side | `apps/web/src/tunnel/usageMeter.ts` (a `LeaseBook`), `throttle.ts`, `sniRouter.ts` |
| AI tokens | `/api/llm-promo/usage` from the inference meter shim (not covered here) |
| load test | `npx tsc -b && npx tsx scripts/meter-load-test.ts` |

Privacy: account names and numbers only. `meter_batches` holds a random id,
a claim token and an expiry, no account. No per-request log anywhere.

## `/api/usage/*` (relay ↔ `.com`)

Both endpoints are internal: the relay presents `x-usage-secret`
(`USAGE_REPORT_SECRET`, the same value on the Worker and the Fly app; 401 on
a wrong one, 503 when the Worker has none).

### `POST /api/usage/report`

```
{ "batchId": "<16–128 chars [A-Za-z0-9_-]; the relay sends 32 hex>",
  "items":   [ { "username": "ann", "bytes": 1234 }, … ] }      ≤ 500 items
```

- With `batchId`, the batch is counted at most once (an id is remembered for
  an hour); a repeat answers `duplicate: true` with the current totals.
- Without it (relays from before leases), it is counted as it arrives. That
  form stays until every relay sends ids, then goes.
- Usernames are lowercased; repeated usernames are summed into one result;
  negative byte counts record nothing. 400 on a malformed body, a bad
  `batchId` or more than 500 items.

```
200 { "ok": true, "duplicate": false,
      "results": [ { "username": "ann",
                     "admit": true,            old wire: verdict on the total
                     "usedBytes": …, "quotaBytes": …,
                     "lease": { "action": "allow" | "throttle",
                                "grantBytes": …,  full-speed bytes before reporting again
                                "policy": "throttle" | "allow",  if the grant runs out first
                                "ttlMs": … } } ] }
```

Egress lease policy (`EGRESS_LEASE_POLICY`):

| account | lease |
| ------- | ----- |
| free, under 25 GB | allow, ¼ of what's left within 1–256 MiB (never more than is left), 10 min |
| free, at or over 25 GB | throttle, 0 bytes, 1 min (lifts within a minute of activity after an upgrade or the new month) |
| paid (hobby/maker) | allow, 256 MiB, policy `allow` (never slowed; overage billed), 10 min |

No lease outlives the month.

### `GET /api/usage/status?username=<u>`

Read-only quota status for the relay and admin reads:
`{ ok, tier, period, usedBytes, quotaBytes, remainingBytes, overQuota,
admit, overageUsd }`. Unchanged by leases.

## The relay

- Counts every byte both ways per account (`<server>.<user>.flagship.services`
  → `<user>`) in the SNI splice; custom domains aren't attributed yet.
- Enforces the lease locally: an account is slowed (256 kbit/s,
  `FLAGSHIP_OVER_QUOTA_KBPS`) the moment a throttle lease arrives or its grant
  runs out, never refused, so an owner can always reach their box.
- Reports adaptively: due accounts (no lease, half the grant spent, lease
  lapsed) within ~500 ms; everyone else every `USAGE_FLUSH_MS` (default 60 s).
- A failed report is retried with the same id (backoff 1–30 s) for up to
  10 minutes, then dropped. A 4xx other than 408/429 is dropped at once.
- `.com` unreachable: fails open (a spent grant doesn't slow anyone; existing
  throttles stay).
- Bounds per account per relay machine: overshoot past 25 GB ≤ 32 MiB each
  time the relay meets the account without a lease (first sight, restart,
  idle an hour), otherwise 0; with E machines carrying one account,
  ≤ (E − 1) × 256 MiB more. A relay crash loses at most the current grant
  (≤ 256 MiB) plus the batch in flight.
- Talking to a `.com` from before leases (no `lease` in results), it treats
  `admit` the old way: no local limit, throttle on `admit: false`.

## Deploying (order matters)

1. Apply migration 0070 to prod D1 and stamp it in the ledger:
   `cd apps/com && npx wrangler d1 execute flagship-state --file=../../packages/storage/migrations/0070_meter_batches.sql --remote`.
2. Deploy the `.com` Worker (`npx tsc -b && (cd apps/com && npm run deploy)`).
   It answers both wires; a relay without ids keeps working.
3. Deploy the `.services` relay (Fly). It starts sending ids and enforcing
   leases.

Step 1 before 2: the Worker's id path writes `meter_batches`. Step 2 before
3: a new relay retries failed batches, and an old Worker can't dedupe them,
so retries would double-count until the Worker is updated. Once every relay
runs the new code, the id-less path in `handleUsageReport` can be removed.

## Scaling: Flagship's numbers

The generic analysis (stores, triggers, the actor-per-account plan) is
`billing/docs/scaling.md`. Flagship's inputs:

`scripts/meter-load-test.ts` drives the real `/api/usage/report` handler over
10,000 accounts, against the in-memory store and the production D1 adapter
on node:sqlite with every migration applied, and times the relay's hot path.

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
  Move to `billing/docs/scaling.md` §4.

Counter table size: accounts × resources × months, ~100 B a row with its
index: 1M servers ≈ 16M rows ≈ 1.6 GB a year against D1's 10 GB cap, so old
periods get archived (they are only needed for billing disputes).

When D1 becomes the bottleneck, step 0 is the 5-minute slow pass and moving
`meter_counters` + `meter_batches` to their own D1 database, so metering
never queues behind identity writes in `flagship-state`; step 1 is the
per-account Durable Object in `billing/docs/scaling.md` §4.
