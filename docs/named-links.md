# Named links: custom voi.ci names for services

Status: **PLAN (pre-build), 2026-10-21.** Owner-directed in the session of
2026-10-21. Branch `feat/named-links`, off `feat/multilingual`; the two are
expected to ship in the same release. Everything below is decided unless it is
listed under "Open decisions" at the end.

> **Superseded in part by `docs/voici-namespace-spec.md` (owner-approved 2026-11-02, built in 0.3, migration 0127).**
> Custom names, codes and usernames are rows of ONE registry (`names`, `packages/storage/src/names.ts`) unique on a
> safety key (lower case, hyphens removed, 0 read as o, 1 as l), so `voici_names` and `voici_links` are no longer read.
> Where this file differs, the spec wins: the grammar is 3 to 30 characters (D12, owner clarification 4); a given-up name is **retired for
> good** (D7: 410, never claimable again) instead of waiting 30 days and freeing (§2.9 below is replaced); codes are
> minted with a digit first (D2) and never reused; reserved words live in `packages/control-plane/src/reservedNames.json`
> and a reserved word answers `taken` (one refusal: "Taken or too similar to an existing name"); a look-up matches the
> exact name, so `voi.ci/halloweenparty` no longer reaches `halloween-party`.

## 1. What it is

Every service has a short link `voi.ci/<name>`. Today `<name>` is a random
6-character code that `.com` mints and silently replaces on every service
rename. After this change:

- the random code is permanent, and is the service's **default name**;
- an admin can replace it with a **custom name** (`voi.ci/halloweenparty`) on
  the service's page;
- custom names are one namespace shared by every account, so they are
  limited, protected for `.com` holders for a while, released when unused,
  and quarantined before anyone else can take them.

## 2. Rules

### 2.1 Default name (the random code)

- Minted when the service is created (`/links` already lazy-mints; keep that
  for services that predate this). Lowercase base36, 6 characters, as now.
- **Permanent for the life of the service.** A service rename no longer
  deletes or re-mints it (`handleServiceRename`'s `deleteByService` cascade
  goes; the code row stays).
- Always redirects, including while a custom name is live.
- When the service is deleted, the code is **retired forever**: it answers 410
  and is never minted again (2.18 B keyspace, so tombstones are free).
- In the UI it looks exactly like a custom name in the same field. No "short
  code", "random" or "default" wording anywhere. Clearing a custom name, or
  losing it, shows the code again.

### 2.2 Custom name

- At most one per service.
- Grammar (as built, D12 of the namespace spec): lowercase `[a-z0-9-]`, 3 to 30 characters, no leading, trailing
  or doubled hyphen.
- **Uniqueness is on the safety key** (hyphens removed, 0→o, 1→l), so
  `halloween-party`, `halloweenparty` and `ha1loween-party` can't belong to two parties. The name
  is stored and shown as typed, and looked up exactly.
- A custom name may not equal any existing or retired code (same table, same
  unique key).
- Reserved words are refused: the existing `RESERVED_LABELS` in
  `serviceRename.ts` + `validateUserLabel`'s list + `flagship`, `voici`,
  `login`, `signin`, `support`, `help`, `security`, `status`.

### 2.3 Where links point

- Both the code and the custom name redirect to the service's **canonical
  address**: `https://<label>.<user>.flagship.services`, where `<label>` is the
  service's alias, else `deriveUrlFragment(serviceId, user)` (`<slug>`, or
  `<slug>--<author>` when the author isn't the account).
- It is worked out **on every visit** from the service id, never stored, so it
  follows service renames and later account renames (`feat/custom-names`).
- Answer: `302`, `Cache-Control: private, no-store` (as today). Never `301`.
  A test pins both.
- **It is the harness's job** that the canonical address always reaches a
  running instance of the app (the tier-2 route the app's gossip leader claims,
  `gossip/routeClaimer.ts`). Phase 11 proves it live; until it passes, the
  redirect keeps today's box address (`appHome`).

### 2.4 Who can change a link

Admin devices only: the order is signed with the sensitive-order key (admin
root, else IRK on accounts without one), like the server order. Other devices
and co-managers see the field read-only. (Open decision 1.)

### 2.5 Every change counts, except a quick correction

- **The link is first shown on the service's page, after the service is
  created.** The create flow has no link field.
- Every set, replace or clear of a custom name is a change, with two exceptions
  (0.4, from the 2026-10-21 service-names plan, journal F8):
  - **Correction window:** a replace or clear within **15 minutes** of a counted
    set fixes it (a typo) without counting against the service's limits. One
    correction per counted set: correcting the correction counts. The mistyped
    name is still retired for good (D7), and the correction still counts toward
    the account's claim budget and daily brake.
  - **A deleted app:** clearing the name of an app no server of the account
    runs any more is never limited (the apps send it when an app is deleted).

### 2.6 Limits

| Limit | Value | Notes |
|---|---|---|
| **N**: changes per service | 3 in any rolling 30 days, and at most 1 in any 7 days | Counts set, replace and clear; corrections (2.5) skipped. |
| **C**: claims per account | Free 10, Pro 100, Pro Max 500 in any rolling 30 days | Every set or replace, corrections included; clears are not claims. Refused as `change-limit` with `scope: "account"` and the date, so the apps show the same "Next change" line. |
| **X**: custom names held per account | Free 5, Pro 25, Pro Max 100 | Live names only; names in their wait don't count. Per tier, in `packages/control-plane/src/meter.ts`'s plan table. |
| Account brake | 10 changes per day | A `rateLimit.ts` bucket (`voici-name-set`), not a product rule. |
| Availability checks | per IP and per account | Bucket `voici-name-check`. |

**X rule: a change is allowed only if afterwards the account holds no more than
X custom names.** So:

- a new name (default → custom) needs at most X−1 held;
- a replace (custom → custom) needs at most X held;
- a clear (custom → default) is always allowed (it is still a change against N).

After a downgrade the account keeps its names but can't add or replace any
until it has released enough. Coasting over the limit is not possible.

### 2.7 Dibs (`.com` holders first)

- **Window: 6 months from this release**, shared with account-name dibs
  (`DIBS_WINDOW_START` / `DIBS_WINDOW_END` on `.com`; both unset = off).
- While it is open, a custom name whose `<key>.com` is **registered** (NS
  records exist; checked over DNS-over-HTTPS) can be taken only by an account
  that proved control of that domain. A lookup failure counts as registered
  (fail closed).
- **One proof covers both kinds:** proving `nike.com` lets the account take the
  link `voi.ci/nike` and (on `feat/custom-names`, paid) the account name `nike`.
- Checked **only when a name is taken**. A `.com` registered later never
  evicts anyone. Nobody is ever kicked out.
- A proven claim is free but is a change (N) and counts toward X.
- First verified claim wins. When the window closes, every blocked name opens
  to everyone at once.
- Registration answers are cached 24 h in D1 (`dotcom_registration_cache`).

### 2.8 Losing a name

- **Inactivity:** a custom name is released when no server of the account has
  reported running the app (`runsServices` in the heartbeat; a box too old to
  send it counts as running everything, as in `appHome`) for **60 days**.
  Warnings in Activity and by content-free push at 30 and 7 days before.
- **Deleting the app or the account** releases its custom names at once (and
  retires the code, 2.1).
- The rule is stated under the field (2.9) so it is never a surprise.

### 2.9 A given-up name (replaced by D7 of docs/voici-namespace-spec.md)

- After any release (replace, clear, lapse, deletion) the name is **retired for good**: it answers a neutral **410**
  and redirects nowhere, and nobody can take it or a look-alike of it again, the account that gave it up included.
- (Planned before 0.3: a 30-day wait, then free to anyone. Not built: the owner's spec keeps retired link names
  blocked forever, like codes.)
- Availability answers `taken` for a retired name.

## 3. The link field (service page, all three apps)

```
Your link
voi.ci/ [ k3x9qa            ] ✎
Unused for 60 days, it's released.        ← only while a custom name is live
```

The prefix is fixed; the box is editable and shows the current name. Local
checks run per keystroke; the server check 400 ms after typing stops. Save
appears once the typed name is `Available`.

| Key (English, wrapped for i18n) | When |
|---|---|
| `Your link` | label |
| `At least 4 characters` | local |
| `Letters, numbers and hyphens only` | local |
| `Available` ✓ | free |
| `Taken` | taken, in its wait, or a code |
| `Reserved` | reserved word or ≤3 chars |
| `Reserved for the owner of {0}` · **`I own it`** | dibs; `{0}` = `halloweenparty.com` |
| `Couldn't check {0}. Try again.` | registration lookup failed |
| `Next change {0}` | N reached; shown on focus, field read-only; `{0}` = locale date |
| `All {0} names in use` · **`Free one up`** | X reached; shown on focus, field read-only |
| `Too many changes today` | account brake (429 with `retryAfterSec`) |
| `Only an admin device can change this` | non-admin device; field read-only |
| `Replace voi.ci/{0}?` / `It stops working now and can't be taken back.` / `Replace` / `Cancel` | confirm before a replace or clear |
| `Unused for 60 days, it's released.` | under the field while a custom name is live |
| `voi.ci/{0} is released on {1}` | Activity warning (30 / 7 days) |
| `voi.ci/{0} was released` | Activity after a lapse |
| `Use default` | each row of the Free one up sheet |

- **Clear** = empty the box (or Use default) → the code comes back after the
  confirm.
- **Free one up** opens a sheet listing the account's services with custom
  names, each with `Use default` (same confirm). Sheet title: `Your names`.
- **I own it** opens the dibs claim screen (moved from `feat/custom-names`,
  §4.2) with the label filled in; once verified it returns to the field with
  the name in it, ready to save.
- Copy rules: no sentences where a word does; no explanations of codes,
  quarantine or dibs in the field. `docs` / FAQ carry the full rules.
- i18n: every string through `tr()` / `trn()` (webapp), `stringResource` /
  `FSStrings` (Android), `String(localized:)` / SwiftUI keys (iOS). Dates via the
  platform formatter. `.com` returns codes and data only, never sentences.
  Pushes carry no text; the device writes it.

## 4. Server design (`.com`)

### 4.1 API

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/voici/names/:name` | none, rate-limited | `{status: available\|taken\|reserved\|invalid\|dibs, domain?, until?, unchecked?}` |
| `GET /api/users/:u/apps/:id/links` | read token (as today) | gains `link: {name\|null, code, changesLeft, nextChangeAt\|null, held, limit, releasesAt\|null, canEdit, correctionUntil\|null, claimsLeft, claimBudget}` (`changesLeft` / `nextChangeAt` already fold in the weekly cooldown, an open correction and the claim budget) |
| `GET /api/users/:u/voici-names` | read token | the Free one up list: `[{serviceId, name, setAt}]` |
| `POST /api/users/:u/apps/:id/voici-name` | signed order | set / replace / clear |
| `GET /api/name-dibs/window` | none | moved |
| `POST /api/name-dibs/initiate`, `/verify` | signed | moved; claim recorded per account + label, valid for both kinds |

Signed order, new canonical bytes:

```
flagship/voici-name/v1|<user>|<serviceId>|<name or "">|<op set|clear>|<issuedAt>|<nonceHex>
```

5-minute freshness, single-use nonce, signed by the sensitive-order key.
Vectors in `packages/protocol/test-vectors/voici-name/` for TS, webapp, Swift,
Kotlin. The dibs challenge bytes `flagship/name-dibs/v1|…` are unchanged, so
their existing vectors stay valid.

Refusal codes (`{error, code, …}`): `invalid`, `reserved`, `taken`, `dibs`
(+`domain`, `until`), `dibs-unchecked` (+`domain`), `change-limit`
(+`nextChangeAt`), `name-limit` (+`held`, `limit`), `rate-limited`
(+`retryAfterSec`), `not-admin`, `stale`, `replayed`.

### 4.2 Moved from `feat/custom-names` (the domain-check mechanism)

Moves to `feat/named-links`, made generic (a claim names its `kind`, but one
verified proof serves both):

- `packages/protocol/src/nameDibs.ts` + tests and vectors
- `packages/control-plane/src/nameDibs.ts`: window, registration lookup
  (fail closed), challenge, DNS TXT / HTTPS proof, claim ledger
  (`allocateDibsName` stays on `custom-names`)
- `packages/storage/migrations/0092_name_dibs_claims.sql` + storage types,
  D1, in-memory, `nameDibsClaimStorage.test.ts`
- `apps/com` dibs routes + `nameDibsRoutes.test.ts`, `apps/web/public/dibs.html`
- webapp `lib/nameDibs.js`, `views/name-dibs.js`, `webappNameDibs.test.ts`
- iOS `NameDibs.swift`, `NameDibsClient.swift`, `NameDibsScreen.swift`,
  `NameDibsViewModel(.swift|Tests)`
- Android `NameDibs.kt`, `NameDibsClient.kt`, `NameDibsScreen.kt`,
  `NameDibsViewModel(.kt|Test)`

Stays on `feat/custom-names`: `nameChange.ts`, `accountRename.ts`, vouchers,
`0093`, `0094`, the paid account-name flow and its Settings entry.

### 4.3 Storage (migration `0111_voici_names.sql`)

- `voici_names`: `key` PK (hyphens removed), `display`, `username`,
  `service_id`, `state` (`live` | `waiting`), `set_at`, `released_at`,
  `release_reason` (`replaced` | `cleared` | `lapsed` | `deleted`), index on
  `(username, service_id)` and on `(state, released_at)`.
- `voici_name_changes`: `username`, `service_id`, `at` (N count; rows older
  than 30 days pruned by the cron).
- `voici_links` gains `retired_at` (code tombstone).
- `dotcom_registration_cache`: `label` PK, `registered`, `checked_at`.
- `0092_name_dibs_claims` gains `kind`. It has never been applied in prod or
  gym (check `schema-status` and the gym ledger first); if so it is edited in
  place, else a `0108` alters it.
- Interfaces in `packages/storage/src/types.ts`, D1 + in-memory, parity test.
- The custom-name key and the code share one uniqueness check (a name may not
  equal a code, live or retired).

### 4.4 Behaviour changes in existing code

- `serviceRename.ts`: drop the `deleteByService` cascade and re-mint; the
  service label rename no longer touches voi.ci.
- `voici.ts` `handleVoiciRedirect`: look up a custom name first, then a code;
  `waiting` name or retired code → 410; target = canonical address (2.3).
  `resolveAppUrl` becomes the canonical builder (behind the phase-11 switch).
- App deletion and account deletion paths: release names, retire codes.
- `cronPlan.ts`: one budgeted step (warnings at 30/7 days, lapses, wait
  expiry, change-log pruning), covered by `cronBudget.test.ts`.
- `pushBridge.ts`: a content-free `voici-name` category; Activity events
  `voici.name.warning`, `voici.name.released`.
- `rateLimit.ts`: `voici-name-check`, `voici-name-set`, tests.
- `apps/com/test/cpuBudget.test.ts`: the redirect and the availability check
  stay inside the budget.

## 5. Work phases (commits on `feat/named-links`)

Each phase is one or more commits with imperative subjects; each batch is
pushed only after `npx tsc -b`, `npx vitest run` (affected packages),
`npm run i18n` and `npm run parity` pass.

1. **Spec**: this file (where it lives: open decision 2).
2. **Move the domain check** (§4.2): bring the files over from
   `origin/feat/custom-names` (`git checkout origin/feat/custom-names -- <paths>`),
   strip the account-name allocation and payment, generalize to `kind`, wire
   the routes, make tests green on this base.
3. **Protocol**: `voici-name/v1` bytes, vectors, TS tests.
4. **Storage**: migration 0111 (+0092 change), interfaces, D1, in-memory,
   tests.
5. **Control-plane + Worker**: routes, rules (2.2–2.9), redirect, cascade
   removal, deletion paths, cron, push and Activity, rate limits, CPU budget,
   audit events. Tests for every refusal code and every rule, including: X after
   a downgrade (new needs X−1, replace X, clear always), a released name
   untakeable by its previous owner during the wait, 410 during the wait, a
   code surviving a service rename, a retired code never re-minted, a later
   `.com` registration not evicting, a failed lookup refusing.
6. **Webapp**: `lib/linkField.js` on the service page (not the create flow),
   the Your names sheet, the dibs hand-off, the confirm, the read-only states.
   `tr()` everywhere, `node scripts/i18n-pwa.mjs extract`, shell **v158**
   (multilingual is v157), source-grep tests, gym scenarios
   `web-named-links-*`.
7. **iOS**: `LinkField` view + view model, the sheet, the dibs hand-off,
   `String(localized:)`, `scripts/i18n-ios.mjs harvest`, the `voici-name`
   vectors in `CanonicalBytesVectorsTests`, view-model tests, mock-gym
   scenarios. **Not buildable in this Linux container**: needs a build and test
   run on the Mac.
8. **Android**: the same with `stringResource` / `FSStrings`,
   `scripts/i18n-android.mjs extract`, vectors in `CanonicalBytesVectorsTest`,
   view-model tests, emulator mock-gym scenarios (Gradle run here if a JDK 17
   is available, else on the Mac).
9. **i18n**: draft translations of every new and moved key in es, fr, de,
   pt-BR, ja, zh-Hans (glossary-checked), `npm run i18n` green,
   `i18n/REVIEW.md` lists the dibs and release wording for native review.
10. **Parity**: rows `named-links`, `named-links-dibs`, `named-links-limits` in
    `parity/features.json`; `npm run parity -- --report`.
11. **Routing guarantee**: live gym group `named-links` in
    `tools/live-e2e` (set; collide; dibs refusal; replace; 410 during the
    wait; previous owner refused; code survives a service rename; the redirect
    lands on a running instance with one box, and with two boxes after the
    app moves). If the canonical address isn't served reliably with two boxes,
    fix the route claim (open decision 3). Then switch the redirect target to
    the canonical address.
12. **Docs and status**: FAQ / docs page for the rules (inactivity and the wait
    stated plainly), `AGENTS.md` status entry and branch list.
13. **Re-parent the dependent branches** (§6.3).

## 6. Git operations

### 6.1 Setup

```sh
git fetch --unshallow origin            # this clone is shallow; rebases need history
git fetch origin main feat/multilingual feat/marketplace feat/custom-names \
                 feat/custom-domains feat/outbound-proxy
git checkout -b feat/named-links origin/feat/multilingual
git push -u origin feat/named-links     # once the first phase is committed
```

### 6.2 While building

- One commit per phase step, pushed after the checks pass
  (`git push -u origin feat/named-links`, retry on network errors only).
- If `feat/multilingual` moves: `git rebase origin/feat/multilingual` on
  `feat/named-links`, rerun the checks, `git push --force-with-lease`.
- No commits to `main` from this work except what open decisions 2 and 3
  allow.

### 6.3 Re-parenting (after `feat/named-links` is green)

New chain:

```
main → feat/multilingual → feat/named-links → feat/marketplace → { feat/custom-names,
                                                                    feat/custom-domains,
                                                                    feat/outbound-proxy }
```

```sh
for b in marketplace custom-names custom-domains outbound-proxy; do
  git tag backup/$b-pre-named-links-2026-10-21 origin/feat/$b
done
git push origin 'refs/tags/backup/*-pre-named-links-2026-10-21'

# scripts/rebase-features.sh: add "feat/named-links:feat/multilingual" and
# change "feat/marketplace:main" to "feat/marketplace:feat/named-links"
# (feat/multilingual:main is listed too), then:
bash scripts/rebase-features.sh            # dry run: behind counts and conflicts

git rebase --onto feat/named-links $(git merge-base origin/main origin/feat/marketplace) feat/marketplace
git rebase --onto feat/marketplace backup/marketplace-pre-named-links-2026-10-21 feat/custom-names
#   ↳ drop the commits/hunks that added the moved dibs files (§4.2)
git rebase --onto feat/marketplace backup/marketplace-pre-named-links-2026-10-21 feat/custom-domains
git rebase --onto feat/marketplace backup/marketplace-pre-named-links-2026-10-21 feat/outbound-proxy
```

Per branch after its rebase: resolve the i18n conflicts (wrap the branch's own
strings with the surface tools, draft translations), renumber the webapp shell
above its parent (marketplace v159, custom-domains v160, custom-names v161,
outbound-proxy v162), `npx tsc -b`, `npx vitest run`, `npm run i18n`, then:

```sh
git push --force-with-lease origin feat/marketplace feat/custom-names \
                                   feat/custom-domains feat/outbound-proxy
```

Expected cost: `feat/multilingual` rewrote every user-visible string into
`tr()` / `stringResource` / `String(localized:)`, so marketplace's webapp,
iOS and Android files will conflict, and its own strings need wrapping and
6-language drafts before `npm run i18n` passes (open decision 4).

## 7. Deploy (with the multilingual release, not before)

1. D1 migrations `0092` (if not yet applied) and `0111` before the `.com`
   deploy.
2. `.com` deploy (`npm run deploy` in `apps/com`; webapp shell v158) with
   `DIBS_WINDOW_START` = release day, `DIBS_WINDOW_END` = +6 months.
3. iOS and Android store builds.
4. No endorsed box release, unless phase 11 needs a box-side route fix.
5. Announce the dibs window and the rules (FAQ).

## 7a. The 2026-10-21 service-names plan, reconciled (0.4, journal F8)

`docs/voici-service-names-todo.md` (the "human voi.ci service names" plan from the same day's discussion) is folded
in here and deleted. Most of it was already built by this feature; where it differed from a later binding decision,
the later decision stands. Point by point:

| Plan item | 0.4 outcome |
|---|---|
| One free user-chosen `voi.ci/<name>` per service, a 302 to the service's `flagship.services` address, following the service between boxes; never a `<name>.voi.ci` origin | Already built (§2.2, §2.3; codes stay too). |
| Globally unique, case-insensitive, `[a-z0-9-]`, reserved and impersonation words | Already built, stricter: the safety key (D9) and 3 to 30 characters (D12, clarification 4). |
| Free to choose; no per-name or dibs fee | Already so. |
| Exposure cap per plan (working Free 5 / Pro 50 / Pro Max 250); decide whether it covers all exposed services | **Names only**, so the promise that an account may install and run any number of apps holds. Values stay **5 / 25 / 100** (the lower, already shipped numbers). Owner question 1. |
| `.com` dibs for service slugs in the shared window, IRK-bound proof valid for both pools, no charge | Already built (§2.7). |
| Lease held by a live service: Flagship-side liveness, never visitor traffic; warn at 21 days, expire at 30 | Liveness is the boxes' own `runsServices` report (daemon service state; visitor traffic never renews it), not an HTTP probe from `.com` (no Worker subrequests to boxes). Timing stays **60 days, warnings 30 and 7 days before** (the translated copy says 60). Owner question 2. |
| After expiry or a change: 30-day 410 quarantine, then claimable again, the old owner included with no priority | **Not built**: D7 of the namespace spec (owner-approved 2026-11-02, later than the plan) retires a given-up link name for good. Owner question 3. |
| Delete or rename ends the claim at once | A rename never touched the name (it follows the service id). `.com` still has no delete signal, but clearing the name of an app no server runs any more is now **never limited**, so "Free one up" releases a deleted app's name at once. |
| 15-minute correction window after a selection | **Built** (§2.5): once per counted set; the typo is still retired (D7) and still counts toward the account's claim budget. |
| One finalized change per service per 7 days | **Built**, on top of the existing 3 in 30 days (both apply). |
| Account claim budget (Free 10 / Pro 100 / Pro Max 500 per 30 days); checks and failed claims don't consume it | **Built** (§2.6 C). Refusals and checks never record a change; the existing check rate limits stay. |
| Custom domains: Pro subscription only, included verification, no dibs fee | Already so (`customDomainEntitlement.ts`). |
| On subscription lapse: 30-day grace, then fail closed; canonical and voi.ci addresses unaffected; resubscription restores after reverification | **Built**: the verifier marks an active domain outside the plan (`custom_domain_orders.lapsed_at`, migration 0137), keeps serving it (and the hub lookups answer for it) for 30 days, then suspends it; back within the plan clears the mark; a suspended domain is reactivated only after its CNAME checks again. |
| Custom-domain replacement cooldown (one per 30 days) | **Not built**: today's refusal is an English sentence in seconds ("Too soon — try again in Ns.") shown verbatim by all three apps; a 30-day wait needs a coded, localized refusal in each app first. Owner question 4. |
| Tests for races, rename/delete, offline recovery, reassignment, downgrade, lapse, abuse limits | `packages/control-plane/tests/voiciNames.test.ts`, `customDomainTier.test.ts`, the storage parity tests; the live gym group `named-links` checks the correction and the weekly cooldown. |

## 8. Open decisions

1. **Who can change a link**: admin devices only (proposed) or any device.
2. **Where this spec and the migrations live**: `main` (the Conventions rule:
   docs and migrations are workspace artifacts; means a push to `main` now,
   reserving 0111) or the branch (as 0092–0094 are today).
3. **A tier-2 routing bug found in phase 11** is shipped behaviour: fix it on
   `main` (proposed) or on this branch.
4. **Re-parenting timing**: do §6.3 as the last phase here (proposed), or wait
   until `feat/multilingual` merges into `main`.
5. **Service-names plan (0.4, §7a), owner to confirm:** (1) name caps 5 / 25 / 100 or the plan's 5 / 50 / 250;
   (2) liveness 60 days with warnings 30 and 7 days before, or the plan's 30 days with a warning at 21; (3) keep D7
   (a given-up link name is retired for good) or the plan's 30-day quarantine and reclaim; (4) a 30-day
   custom-domain replacement cooldown (needs a localized refusal in the three apps).
