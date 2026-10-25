# Canary cohorts, update receipts and the stop rule

Architecture v2 work package V02 (`docs/architecture-v2/IMPLEMENTATION-PLAN.md` §12.3,
§13.1), on top of the signed release catalog (N13, `packages/protocol/src/releaseMetadata.ts`).
The release script runs it as step 23, "Canary cohorts" (`docs/runbooks/final-deploy.md` §9b).

The order the plan asks for: gym → maintainers' test boxes → consenting canary owners →
staged cohorts. Each step below says what it proves and what it cannot.

## 1. How a box lands in a cohort

- Every release in the catalog's targets carries a `rolloutPercent` (0..100). A box may take a
  release only when `rolloutBucket(salt, commit) < percent × 100`
  (`releaseCatalogGate.ts`). Every update path asks this first: an owner's update order, the
  first-boot move, a co-manager's update.
- The salt is the box's own secret: 32 random bytes in `<dataDir>/rollout-salt`, created on first
  start, mode 600, never sent anywhere (`packages/server-daemon/src/canary/updateReceipts.ts`).
  Before 0.3 the salt was the server's public name, so anyone could work out every box's cohort.
  Changing it moves each box to a new cohort once. That is harmless, because nothing had been staged
  on the old salt.
- The bucket is a different hash for every release, so being early for one release says nothing
  about the next one.
- The ladder is 1, 5, 20, 50, 100 (`CANARY_STAGES`). A box's cohort for a release is the smallest
  stage that already admits it.

## 2. Update receipts

After an update reaches a verdict (`<dataDir>/update-outcome.json`), a box whose owner agreed sends
**one** receipt to `POST /api/update-receipts` on `.com`:

| field | values |
|---|---|
| `release` | the 40-hex commit the box tried to move to |
| `cohort` | `1`, `5`, `20`, `50` or `100` |
| `healthGate` | `pass` or `fail` (the boot health gate, `updateHealthGate.ts`) |
| `rolledBack` | `true` when the gate failed and the box went back on its own |
| `arch` | `amd64`, `arm64` or `other` |
| `stack` | `classic` (Docker, TS keyd) or `arch-v2` (Podman, Rust path) |
| `nonce` | 32 random hex, new per receipt, only so a resend counts once |

What a receipt never carries: the server's name, the account, any key, an address, the release the
box came from, a time finer than the day `.com` stamps on arrival, boot attempts, or anything about
apps. A receipt with any extra field is refused (`parseUpdateReceipt`).

`healthGate: fail` with `rolledBack: false` means **stuck**. The new release failed its gate, but
the release before it is below the signed security floor, so the box did not go back. It stays in
restricted recovery until a fixed release arrives (`update-rollback-refused`, recorded as
`rollbackRefused: true` in the outcome file).

**Consent.** Sharing is off unless the owner turned it on with
`POST /api/update-reports {"share": true}` from an owner session (`GET` shows the choice and the
fields a receipt holds). Remote and co-manager sessions are refused. Maintainer and gym test boxes
may start with it on: `FLAGSHIP_UPDATE_RECEIPTS=1` in the daemon's environment. A verdict reached
while sharing was off is never sent later, and turning sharing off drops anything still queued.
SECURITY-HARDENING-PLAN.md §18.13 says to track what runs on *consenting* boxes.

**Timing.** The box queues the receipt when it sees the verdict, then sends it after a random delay
of up to three hours. The delay keeps a receipt from arriving next to the box's own heartbeat. The
box retries on a network error, a 5xx or a 429, and drops the receipt on any other 4xx.

**On `.com`.** Receipts are metered per network (`update-receipt` in `apps/com/src/rateLimit.ts`:
6 an hour, 24 a day per address). They are stored only as counts, in D1 `update_receipt_counts`
(release, cohort, arch, stack, day → passed / rolled back / stuck; migration 0119). Resend nonces
are kept 14 days and counts 400 days, both pruned in passing. Nothing about the caller is written.

## 3. Reading the receipts

```sh
FLAGSHIP_ADMIN_SECRET=… npm run canary                                    # every release, last 30 days
FLAGSHIP_ADMIN_SECRET=… npm run canary -- --release <commit> --opened-at <ISO time the stage opened>
FLAGSHIP_ADMIN_SECRET=… npm run canary -- --json                          # what release.sh reads
```

Each release shows its current percent from the published catalog (`/build/iso/catalog-targets.json`),
its counts, and with `--release` its counts per cohort, profile (`arch/stack`) and day. The verdict
comes from `canaryVerdict` (`packages/protocol/src/updateReceipt.ts`):

| verdict | when |
|---|---|
| **stop** | any stuck box; or rollbacks ≥ 2 (`--stop-rollbacks`); or a rollback share above 5% once a group has 20 receipts. Judged for all boxes and for each profile on its own. |
| **hold** | exactly one rollback: a person looks before anything widens |
| **wait** | the stage is younger than 48 h (`--min-hours`), or the release has fewer than 3 receipts (`--min-receipts`) |
| **widen** | none of the above, and there is a next stage |
| **complete** | the release is at 100% with nothing wrong |

Always read the denominators. Ten passes from a fleet of a thousand prove less than three passes
from a fleet of five.

## 4. Widening

```sh
curl -fsS https://flagshipserver.com/build/iso/catalog-targets.json   -o served-targets.json
curl -fsS https://flagshipserver.com/build/iso/catalog-timestamp.json -o served-timestamp.json
npx tsx tools/release-catalog/catalog.ts rollout --root release/catalog-root.json \
  --list release/catalog-releases.json --commit <commit> --percent <next stage> \
  --key <offline>/catalog-root-1.key.json --timestamp-key <offline>/catalog-timestamp-1.key.json \
  --previous-targets served-targets.json --previous-timestamp served-timestamp.json --out-dir out
# upload out/{targets,snapshot,timestamp}.json as flagship-iso/catalog-<name>.json (wrangler r2 object put … --remote)
git add -- release/catalog-releases.json && git commit -m "Canary: <commit> to <N>%" && git push origin HEAD:main
```

`rollout` signs a new targets version above both the list and the published catalog. Before
writing anything, it checks the result the way a box holding the published catalog would.
`release.sh` (step 23) does all of this and records when each stage opened.

**Before the first widening:**

1. This release's gym run (step 12) is green for the `update` group (an endorsed update applied and
   rolled back on a real box) and the `canary` group (receipts counted once, extra fields refused,
   only the owner turns sharing on).
2. One deliberate rollback drill has sent its receipt. On a maintainer box with sharing on, order an
   update to a release whose boot gate cannot pass (the gym's `update` group does this for its box).
   Then check that the box went back, that its server page says so on every client (§7), and that
   `npm run canary -- --release <that commit>` shows one rolled-back receipt within about three
   hours.
3. The maintainers' own boxes took the release at the 1% stage (or were ordered to directly) and
   their receipts passed.

**Keep cohorts separable.** Do not combine engine, crypto, GPU-driver and disk-layout changes in one
release (plan §12.3). If a release must carry two of them, stage it through every step with
`--min-hours 96`.

## 5. Stop

When the verdict is **stop**, or when anything outside the receipts shows an unauthorized effect, key
exposure, data corruption, a failed recovery or a security-state rollback:

```sh
npx tsx tools/release-catalog/catalog.ts rollout … --commit <commit> --percent 0 …   # as in §4, then upload and commit
```

- **Use `--percent 0`, not `--remove`, while a security floor is set.** A release the catalog no
  longer lists stops being a rollback target. A box halfway through an update to the next release
  would then end in restricted recovery instead of going back (adversarial test AT-CAT-15).
- A stop only blocks *new* updates. Boxes that already took the release keep running it. The fix is
  a new release with a higher security version, staged from 1% again. Raise the security floor only
  when running the bad release is itself unsafe. A raised floor cannot be lowered.
- Versions only go up, so replaying the published 5% catalog cannot undo a stop
  (`tools/release-catalog/tests/rollout.test.ts`).
- **Known gap:** a box only learns of the stop when it fetches the catalog (every 6 hours). If the
  fetch is blocked, the box keeps its last accepted view, and that view never turns stale by the
  clock alone (AT-CAT-07 in `docs/security-assessment/adversarial-tests.md`). Until that is fixed,
  treat a stop as reaching boxes within hours, not at once, and not boxes that cannot reach the
  artifact bucket.

## 6. What receipts cannot prove

- **They are anonymous, so they can be forged.** A flood from many networks can make a release look
  healthy or sick. Bad news stops the canary, and good news only lets a person widen, together
  with the gym, the maintainers' boxes and the observation time.
- **They see the boot health gate only.** It checks that the tunnel came up, a signed heartbeat went
  out and the Rust binaries still run. It does not see a broken app, slow pages, lost data, a key
  leak or a revocation that failed. Those come from the gym, the maintainers' boxes, support
  messages and the incident drills (`docs/runbooks/security-incident-drills.md`).
- **They come only from boxes whose owners agreed.** No client has the switch yet (§8), so today
  receipts come from maintainer and gym boxes started with `FLAGSHIP_UPDATE_RECEIPTS=1`.
- **The source address.** `.com` stores no address. A dishonest `.com` could still log the address a
  receipt came from and match it to the box's heartbeat. Sending through an OHTTP relay would close
  that; the relay exists only on the `feat/outbound-proxy` branch.
- **A compromised box** can lie in its receipt or suppress it.

## 7. What an owner sees (support)

`docs/support/update-rollback.md` is the owner-facing explanation of each outcome on each client.

## 8. Open items

- Done in 0.3: the "Share update results" switch on iOS, Android and the webapp (server page,
  Software update card, owner sessions; `/api/update-reports`), and the client sentence for
  `rollbackRefused` (support doc §2-§3). Still open: the box's Activity line for that case says
  "rolled back" in English.
- The stop rule depends on the box treating an old catalog view as stale by the clock (AT-CAT-07).
