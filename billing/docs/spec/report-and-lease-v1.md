# Reports and leases v1

Status: implemented by `@ibisllc/billing-metering` after 0.1.0 (unreleased:
`meterReport`, `meterLease`, `LeaseBook`, the optional `MeterStore.addBatch`).
Builds on [metering-v1](./metering-v1.md); [http-v1](./http-v1.md) is an
optional HTTP binding.

An **edge** is whatever observes usage: a relay counting bytes, a proxy
counting requests, a model server counting tokens. **Central** holds the
counters (metering-v1). This spec covers how an edge reports usage so that
each unit is counted once, and how central tells the edge how much more it
may serve before asking again.

## 1. Batches

An edge sends usage in **batches**:

```
batch   = { batchId?, items: [ { account, resource, amount }, … ] }
batchId = 16–128 characters of [A-Za-z0-9_-]   (an edge sends 128 random bits)
```

Central records a batch with `meterReport` (one verdict per distinct
`(account, resource)`; repeated items are summed):

- **With a `batchId`**, the batch is counted **at most once**. The store's
  `addBatch` records the id and adds every item in one atomic step. A batch
  whose id is already on record changes nothing and is answered with
  `duplicate: true` and verdicts on the current totals, so an edge that lost
  an answer can resend the batch and get the answer it missed.
- **Without one**, the batch is counted as it arrives, so a resent batch is
  counted twice. This form exists only for edges that predate batch ids; a
  host accepts it for a transition window and then refuses it.

### Dedupe storage

The record is `(batch_id, claim, keep_until)`: a random id, a random token
for the request that claimed it, and an expiry. **Never an account or an
amount**, so the dedupe record says nothing about who used what.

- Kept for `keepMs` (default one hour), then forgotten: after `keep_until`
  the same id may count again. An edge must stop retrying a batch well before
  that (the reference edge stops after 10 minutes).
- Each `addBatch` prunes up to 32 expired ids, so the table holds about
  `reports per keepMs` rows (one edge reporting every 500 ms: at most 7,200).
- An id whose record has expired may be claimed again in the same step
  (an upsert that only replaces an expired row), so expiry never depends on
  pruning having reached it.
- The SQL form (`schema/meter_batches.sql`) runs in one transaction: prune,
  claim with `INSERT … ON CONFLICT … RETURNING`, then each counter add,
  only if the claim succeeded. A crash commits the whole batch or none of
  it. The SQLite, PostgreSQL and D1 stores in this repository each
  implement it this way (PostgreSQL as a single statement).

## 2. Leases

Central answers every account in a report with a **lease**:

```
lease = {
  action:  "allow" | "throttle" | "stop"   what the edge does now
  grant:   units the edge may serve, beyond what central counted when it
           answered, before it needs a new lease (0 unless action = allow)
  policy:  the plan's over-allowance policy, applied if the grant runs out
           before a new lease arrives ("allow" = keep serving)
  ttlMs:   how long the answer stands (relative: no clock agreement needed),
           never past the end of the period
}
```

A throttle or stop is a lease with `grant: 0` and that action.

### Sizing (`meterLease`)

With a policy `{ fraction, minGrant, maxGrant, ttlMs, overTtlMs }`:

| account                       | action     | grant                                                             | ttl         |
| ----------------------------- | ---------- | ----------------------------------------------------------------- | ----------- |
| plan policy `allow` (billed)  | allow      | `maxGrant`                                                        | `ttlMs`     |
| `remaining > 0`               | allow      | `min(remaining, clamp(fraction × remaining, minGrant, maxGrant))` | `ttlMs`     |
| `remaining = 0`, or over      | the policy | 0                                                                 | `overTtlMs` |

Both ttls are capped at the period's reset, so a new period lifts a throttle
at the first report after it.

### Edge semantics (`LeaseBook`)

Per account the edge keeps `pending` (used, not yet in a batch), `spent`
(used since the lease's base) and the lease:

- **Enforcement**, `action(account)`:
  - no lease: `allow` until `spent ≥ initialGrant`, then the edge's
    `unknownPolicy`;
  - lease action ≠ allow: that action (even after the lease lapses, until
    central answers otherwise);
  - lease allows: `allow` until `spent ≥ grant`, then the lease's `policy`.
- **Base.** When a lease arrives for batch B, `spent` becomes the usage since
  B was taken: the grant is relative to central's total, which includes B
  and nothing after it.
- **Due.** An account with pending usage is **due** (report early) when it
  has no lease, has spent `renewAt` (default ½) of its grant, or its lease
  has lapsed. The host sends due accounts promptly and everyone else on a
  slow pass. Grants shrink near the allowance, so accounts near it report
  more often with no extra rule.
- **One batch in flight.** A failed batch (network, 5xx, 408, 429) is kept
  and resent first, with the same id and contents, after a backoff (1, 2, 5,
  10, 30 s); after `retryForMs` (default 10 min) it is dropped, an
  under-count. A refused batch (any other 4xx) is dropped at once.
- **Fail-open.** While the last send failed to reach central, a spent grant
  or initial grant does not restrict (`failOpen`, default on); explicit
  throttle/stop leases still do.
- **Memory.** An idle account is forgotten `forgetAfterMs` (default 1 h)
  after its lease lapsed.

### Bounds

For one account carried by E edges:

- **Overshoot past the allowance.** A grant never exceeds what is left, so a
  single edge holding a lease stops exactly at the allowance. An edge that
  meets the account without a lease can serve `initialGrant` before its
  first answer. E edges holding leases at once overshoot by at most the other
  edges' grants, `≤ (E − 1) × maxGrant`, less near the limit since each grant
  is a fraction of what was left. During a central outage with `failOpen`,
  overshoot is unbounded by design.
- **Loss on an edge crash.** Unreported usage per account is at most what it
  spent on its current lease (`≤ grant ≤ maxGrant`) or `initialGrant`, plus
  the batch in flight; for an allow-policy account, plus up to one due-check
  interval of traffic past the grant.
- **Loss on a failed batch.** Only batches dropped after `retryForMs` or
  refused (counted in `droppedBatches`).

## 3. Privacy

The wire and the counter store carry account ids and numbers. The dedupe
record carries no account at all. Nothing about what was metered (content,
hosts, addresses, prompts) belongs in a batch, a lease or a store, and the
scheme keeps **aggregates only**: no per-request event log exists anywhere.

## 4. Transport

This spec defines what a report and a lease contain, not how they travel.
[http-v1](./http-v1.md) is a ready-made HTTP binding (`createReportHandler`
on central, `sendBatch` at the edge). A host that already has a wire can
carry the same fields in its own shapes.

### Moving from per-report verdicts to leases

A host whose edges used to act on a plain verdict per account (an
"admit: true/false" answer) can roll leases out in either order if central
keeps sending the old verdict next to the lease for a while: a lease-aware
edge that gets no lease treats "admit" as an unlimited lease and "deny" as
a throttle, which is the old behaviour.
