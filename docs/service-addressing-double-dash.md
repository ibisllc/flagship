# Service addressing: `--` delimiter + dashes in usernames

Status: **SPEC (pre-build)**. Owner-directed 2026-06-22. Reverses the
"usernames stay dashless" decision in `naming-recovery-and-name-change.md` §3.

## 1. Decision

- The slug↔creator composite delimiter becomes a **double dash `--`** instead of
  a single dash. `--` is the precise, system-wide unique service identifier and
  is present everywhere internally, user-visible or not.
- **Usernames may contain single dashes** (e.g. `happy-turtle`); **slugs** already
  may. Neither half may contain `--` (it's the reserved delimiter), nor a
  leading/trailing dash. With `--` banned inside both halves, the composite parses
  unambiguously by splitting on the (single) `--`.
- The `--` is **user-visible only when it must be** — see §6 (display rule): the
  bare slug is shown normally; the qualified `<slug>--<creator>` surfaces only
  when the user has two installed services that share a slug. voi.ci stays the
  friendly short link.
- **Short slugs are allowed.** All `*.flagship.services` traffic terminates at the
  Fly SNI passthrough, which routes on the opaque leftmost label (it splits on the
  first dot, never a dash), so a `slug--creator` or punycode-shaped (`xn--`) label
  routes fine; any browser display quirk of an `xn--`-shaped label is an accepted
  cosmetic corner.

## 2. The two composite forms (both in `packages/protocol/src/serviceId.ts`)

| Form | Today | New | Parser |
|---|---|---|---|
| **App-id** (global unique service id) | `<creator>-<slug>` | `<creator>--<slug>` | split on the single `--` |
| **URL label** (leftmost host label) | `<slug>-<creator>` (cross-creator) | `<slug>--<creator>` | split on the single `--` |

`deriveUrlFragment(serviceId, runningUser)` keeps its existing logic — **bare
`<slug>` when `creator === runningUser`, `<slug>--<creator>` when cross-creator** —
only the delimiter changes. The URL label is the leftmost label of the tier-1
host `<urlLabel>.<server>.<user>.flagship.services`, covered by the per-box
wildcard `*.<server>.<user>` (no cert change).

## 3. Grammar

**Username** (was `^[a-z0-9]{3,30}$`, dashless) →
`^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])?$`, length 3–30, **no leading/trailing dash,
no `--`**. **Slug** keeps `^[a-z0-9](-?[a-z0-9])*$` (already no leading/trailing/
doubled dash — the single-dash ban already forbids `--`; confirm). Both halves
must reject `--` so the delimiter is unambiguous. Mirror the username grammar in
**all 18 locations** (§4.A).

## 4. Propagation map (every touchpoint, from the audit)

### A. Username grammar — 18 copies to move to the dash-allowing regex
- TS/control-plane: `labels.ts:13` (canonical), `auditEvents.ts`, `serviceRename.ts`,
  `usersDevices.ts`, `voici.ts`, `customDomain.ts`, `usersCheck.ts`
  (`DEMO_USERNAME_RE`), `serverRegister.ts` (inline `/^[a-z0-9]{3,30}$/`),
  `serverTransfer.ts` (inline).
- services-zone: `validation.ts:29` (`USERNAME_RE`) + the error string at :95.
- webapp: `lib/accountResolve.js`, `lib/state.js`, `lib/openAccount.js`,
  `views/bootstrap.js`.
- iOS: `FlagshipServerClient.swift` (`usernameRe` + the "no hyphens" message).
- Android: `ui/screens/ChooseUsernameScreen.kt` (`usernameRegex`),
  `api/FlagshipServerClient.kt`.
- **Consolidate where cheap:** the 7 control-plane copies should import the one
  in `labels.ts` rather than re-declaring (kills future drift). The webapp copies
  should import `USERNAME_RE` from one module.

### B. App-id `<creator>-<slug>` → `<creator>--<slug>`
- `packages/protocol/src/serviceId.ts`: `composeServiceId` (gen → `${creator}--${slug}`),
  `parseServiceId` (split on the FIRST `--` via `indexOf("--")`, validate exactly
  one `--`, both halves non-empty + `--`-free).
- Daemon duplicates of the parse: `server-daemon/src/cloneService.ts:118-128`,
  `server-daemon/src/updateClient.ts:670-678` (both re-implement the first-dash
  split — switch to `--`, or better, call `parseServiceId`).
- Daemon generation: `server-daemon/src/llm/deploySession.ts:94`,
  `server-daemon/src/buildmodes/deployArtifact.ts:91` (`${creator}-${slug}` →
  use `composeServiceId`).
- `server-daemon/src/servicePlatform.ts:46-48` comment + `serviceId()`/`urlLabel()`.

### C. URL label `<slug>-<creator>` → `<slug>--<creator>`
- `packages/protocol/src/serviceId.ts:deriveUrlFragment` (`${slug}--${creator}`).
- `services-zone/src/validation.ts:parseAppLabel` (split on `--`; today
  `lastIndexOf("-")`) + the slug/username validators + comments.
- Daemon `servicePlatform.ts:urlLabel` (delegates to deriveUrlFragment) + the
  `byUrlLabel` collision gate (unchanged logic, new delimiter).

### D. Client local-derivation fallbacks (re-split on dash — switch to `--`)
- iOS `FlagshipServerClient.swift:~2477-2500` (the `firstIndex(of: "-")` split →
  `--`; prefer the daemon-provided `urlLabel`, this is only the fallback).
- Android `FlagshipServerClient.kt:~1515-1558` (the `indexOf('-')` split → `--`).

### E. UNAFFECTED (confirm + leave) — and WHY
- **Routing:** `tunnel-protocol/src/sni.ts` reads the raw SNI; `apps/web/src/tunnel/
  registry.ts:findBySni` splits on the **first dot** and treats the leftmost label
  as opaque, matching the full registered FQDN. No dash logic → no change.
- **Cert:** per-box wildcard `*.<server>.<user>` (services-zone `serverWildcardSans`)
  covers any leftmost label incl. `slug--creator`. No change.
- **Tier-2 canonical:** `servicePlatform.canonicalUrl` = `<slug>.<creator>.flagship.services`
  — DOTTED, no dash delimiter. No change.
- **voi.ci:** mints against an opaque target URL. No change.

### F. Tests to update (expected values flip to `--`)
- `protocol/tests/serviceId.test.ts` (compose/parse/deriveUrlFragment).
- `services-zone/tests/validation.test.ts` (parseAppLabel, username dash cases).
- `server-daemon/tests/servicePlatform.test.ts` (urlLabel cross-creator, serviceId).
- `control-plane/tests/serviceRename.test.ts` (displayLabel/canonicalUrl defaults).
- `control-plane/tests/labels.test.ts` (username grammar — dashes now valid).
- The username-grammar mirror tests on each client surface.

## 5. Vendor vs owner (clarified)

There is **no vendor/publisher distinct from `creator`**. `creator` = whoever
**authored** the service (immutable, in the install envelope); the **host/owner**
(the running user, whose IRK signs the install) is separate. So a "same slug from
multiple vendors" collision is really **same slug from multiple *creators*** —
e.g. installing `alice--blog` and `bob--blog` on your box. The `--<creator>`
qualifier disambiguates by author, which is exactly the precise-canonical intent.

## 6. Display rule — `--` visible only on collision

Two layers:
- **Canonical / hostname (always precise):** app-id always `<creator>--<slug>`;
  the URL label is bare for self-authored and `<slug>--<creator>` for cross-creator
  (unchanged logic). This is what addresses/certs/links use.
- **UI display label (friendly):** show the **bare `<slug>`**; surface the
  qualified `<slug>--<creator>` only when the user's installed-services set
  contains **≥2 services sharing that slug** (the genuine collision). This is a
  client-side computation over the service list (group by slug; qualify only the
  colliding members). The href/canonical stays the precise form; only the visible
  text shortens. (Phase 2 — the core delimiter change is Phase 1 and already gives
  "bare for your own, qualified for others'".)

## 7. Backward-compat / cutover

Existing services carry single-dash app-ids (`alice-blog`); under `--` they no
longer parse. Options: (a) pre-GA clean cutover — the repo already wipes prod
between e2e runs, so wipe + redeploy is simplest and fits the launch sequencing;
(b) a parse fallback that accepts a single dash for a deprecation window (more
code, only if real installed services must survive). **Recommend (a)** given
pre-GA. Note it in the launch runbook.

## 8. Build order

1. **Protocol foundation:** `serviceId.ts` (`--` compose/parse/deriveUrlFragment)
   + its tests. Everything else depends on this.
2. **Grammar:** the dash-allowing username regex in `labels.ts` + services-zone +
   consolidate/import the duplicates; slug `--` ban; tests. Update the random
   generator (it can now emit `happy-otter-4821`).
3. **services-zone `parseAppLabel`** (`--`) + tests.
4. **Daemon:** switch the parse/gen duplicates to call `serviceId.ts`; comments;
   tests (`servicePlatform`).
5. **Clients:** the iOS/Android local-derivation fallbacks (`--`); the webapp +
   native grammar mirrors; native builds.
6. **Display rule (Phase 2):** collision-aware bare/qualified label in the service
   lists (webapp/iOS/Android).
7. **Cutover:** wipe-on-launch note.

## 9. Open questions

1. **Slug min length** — allow 1-char slugs (punycode `xn--` corner accepted), or
   require ≥2/≥3 to dodge the `--`-at-positions-3-4 IDN zone? (Decision: allow,
   per the "Fly handles it" call; just confirm.)
2. **Backward-compat** — clean cutover (recommended) vs single-dash fallback window.
3. **Display rule scope** — ship the collision-aware label in Phase 1 or Phase 2?
4. **Grammar consolidation** — how aggressively to de-duplicate the 18 copies now
   vs. update-in-place (de-dup is better but touches more surface).
