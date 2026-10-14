# Metering (Flagship wiring)

The generic core is `billing/` (`@ibisllc/billing-metering`): the model is
`billing/docs/spec/metering-v1.md`, batches and leases are
`billing/docs/spec/report-and-lease-v1.md`, and growth is
`billing/docs/scaling.md`. This page is what Flagship plugs into it.

| piece | where |
| ----- | ----- |
| resources + tier table (`egress`, `ai-tokens`) | `packages/control-plane/src/meter.ts` |
| relay ↔ `.com` contract, egress lease policy | `packages/control-plane/src/metering.ts` |
| counters | D1 `meter_counters` (migration 0069), `D1MeterStorage` |
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
