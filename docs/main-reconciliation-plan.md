# Main reconciliation plan — `origin/main` vs unpushed local `main`

> READ-ONLY investigation memo. No code was changed. This proposes an order and
> surfaces the decisions; it does **not** pick winners. Generated 2026-06.

## 0. Ground truth (verified)

| ref | commit | state |
| --- | --- | --- |
| `origin/main` | **3746f20f** | pushed / shared |
| local `main` | **2f480ce6** | the primary checkout `/Users/harrywinner/flagship`, **UNPUSHED** |
| common ancestor | **489aff0c** | "merge: integrate parallel main into transfer-a-box landing" |

`origin/main` has **24** commits since the split; local `main` has **15**.
Neither is an ancestor of the other — they have genuinely DIVERGED.
(This worktree's HEAD is `feat/session-followups-v2` @ a3e8ec7c; investigation
was done by diffing the two named commits, not HEAD.)

`git merge-tree --write-tree origin/main 2f480ce6` reports **exactly ONE textual
conflict**: `packages/control-plane/src/schemaStatus.ts`. **This is the trap.**
The dangerous conflicts are SEMANTIC and live in files only ONE side touched, so
git merges them with zero conflict markers and ships a broken hybrid (see §2/§5).

---

## 1. Inventory — the two commit sets, grouped by feature

### `origin/main` (24) — the username-suggestion / dashed-username / `--` line

**Service-id grammar (the irreversible core; these move as ONE bundle):**
- `a626f36e` protocol/daemon service-id delimiter `-` → `--` (`composeServiceId`/`parseServiceId`/`deriveUrlFragment` now split on `SERVICE_ID_DELIM = "--"`).
- `a7c4702e` usernames allow interior single dashes (TS + webapp validators).
- `99ceefcd` migrate iOS + Android to `--` service ids and dashed usernames.
- `580b406b` finish dashed-username grammar in the webapp validators.

**Random-handle cover + suggestion feature (depends on the grammar):**
- `7e50e511` drop the no-credential "claim after a wait" from the cover.
- `cb71306e` **cover flip** — sign-up assigns a random handle; the username field is sign-in only.
- `ac53a742` control-plane random-username generator + `GET /api/username/random`.
- `a0c89ac7`/`8c860c85`/`af890edf` design + storage + throttled serving of ONE random handle from a pre-validated queue.
- `e0279e9b` webapp one suggested handle + throttled regenerate.
- `9c9d0bfc`/`f2f12cd8` iOS / Android suggested-handle sign-up screens + suggest client.

**Claim-gate (depends on the suggestion roster):**
- `580ae1a8` recently-offered-handles roster storage.
- `778dfbcd` gate username claims to recently-suggested names (`usernameClaim.ts` grows `offers`/`bypassOfferGate`).

**Plumbing / migrations / status / e2e / edge (this session):**
- `87ad549c` register migration 0060 in `KNOWN_MIGRATIONS`.
- `74915980`/`5c36e510` status-log entries; `e2b542f0`/`e0ca22c1` naming + recovery + paid-name-change docs.
- `f8e206cb`/`83440ead` route direct-claim test tools (vps-e2e) through the suggestion endpoint.
- `562ff533` fix a redeclaration in the onboarding smoke UITest.
- `3746f20f` HTTP→HTTPS redirect on the `.services` :80 edge (independent; cherry-pickable anywhere).

### local `main` (15) — phone-provisioned SWK + Box Request Inbox + transfer entry

**Phone-provisioned SWK:**
- `3afbfe99` provision the Service Workload Key from the phone at first boot (TS layers); `cbe798c5` merge of SWK TS plumbing (daemon first-boot consume + burner `swkHex` sibling + `deriveSWK` vector).
- `2a790598`/`dbbadd85`/`b35225df` iOS / Android / webapp derive + embed the box SWK in the recipe at create-time.
- `56511f06` burner-mac preserves the `swkHex` recipe sibling through the envelope flatten.

**Box Request Inbox unification:**
- `cd178bad` unify the two parallel approval sets into one Box Request Inbox.
- `2a232d5b` drop the two legacy `/pods` `awaitingUnlock`/`awaitingEntitlement` booleans.
- `bcb56bbd` split unlock-approval copy on first boot vs established reboot.

**Misc:**
- `312607c7` wire "Transfer to another account" entry on server-detail.
- `78d7c12b` iOS pop-to-Home after deleting a dead server.
- `d86aa25b` show "server isn't set up to build services" on a platform-absent 404.
- `9baf2438` register migration 0060 in `KNOWN_MIGRATIONS`.
- `be538364`/`2f480ce6` docs (do-now sweep; record phone-provisioned SWK + build-404 copy).

---

## 2. Conflict map

### 2a. Textual conflicts (git actually flags these)

| File | Origin side | Local side | Class | Resolution |
| --- | --- | --- | --- | --- |
| `packages/control-plane/src/schemaStatus.ts` | adds `"0060","0061","0062"` to `KNOWN_MIGRATIONS` | adds `"0060"` | **textual-only / trivial** | UNION → `…"0059","0060","0061","0062"`. Both 0060 registrations point at `0060_server_transfer_disk_key.sql`, which **predates the split** (no SQL-file collision). `0061`/`0062` are origin-only new files. |

That is the **only** marker `git merge` will raise.

### 2b. SEMANTIC conflicts (auto-merge clean → silent broken hybrid)

These files were touched by **only one** side, so a merge takes that side wholesale.

| Area | Files | Touched by | Why it's a hidden conflict |
| --- | --- | --- | --- |
| **Cover design** | `apps/web/public/webapp/views/bootstrap.js`, `index.html`, `lib/modal.js`, `lib/openAccount.js`, `lib/accountResolve.js`, `lib/state.js`, `lib/apex.js` | **origin only** | Merge silently adopts origin's random-suggestion cover (`#bootstrap-create` + `inlineSuggestUsername` modal + `/api/username/suggest`). Local's single typed-resolve `#bootstrap-continue` cover is **gone** with no marker. The two cannot coexist — a design choice. |
| **Username grammar** | `packages/services-zone/src/validation.ts`, `packages/control-plane/src/labels.ts`, webapp `USERNAME_RE` in `bootstrap.js` | **origin only** | Merge adopts origin's dashed grammar (`/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/` + `--` ban + new `isValidUsernameShape`). Local's stated "3–30 lowercase letters and digits, no hyphens" is overwritten. |
| **Service-id `--` delimiter** | `packages/protocol/src/serviceId.ts` (`SERVICE_ID_DELIM`), `services-zone/validation.ts#parseAppLabel` | **origin only** | Merge adopts `--`. This is the IMMUTABLE on-box id and the public URL label. **Grammar + delimiter are inseparable**: dashed usernames are only unambiguous *because* the delimiter is `--`. You cannot take one without the other. |
| **Mobile mock fixtures** | `apps/mobile/shared/.../MockScreensClient.swift`, `android/.../MockBuildClient.kt` | **BOTH** (the only mobile overlap) | Auto-merges clean: origin rewrites fixture serviceIds `harry-plants`→`harry--plants`; local adds an orthogonal `entryFailStatus`/`simulatedFailureStatus` 404 hook. The MERGE keeps both — but the hybrid is only correct if every other local fixture/assert is updated to `--` too. **Verify, don't trust.** |
| **`/pods` booleans** | `packages/control-plane/src/podInventory.ts`, mobile `AppState`, watchers, `views/home.js` | **local only** | Merge adopts local's removal of `awaitingUnlock`/`awaitingEntitlement` + the unified inbox. Safe as long as no origin commit reads those booleans (none do — origin didn't touch the pod-approval path). |
| **Status log** | `packages/control-plane/src/schemaStatus.ts` *text* + status docs | both append | Covered by 2a; the prose docs are append-only (no real conflict). |

---

## 3. The decisions the team MUST make (these can't both be "right")

1. **Which cover?** Origin's *random-suggestion* sign-up (`Create a new account` →
   server-suggested handle, username field is sign-in-only) **vs.** local's
   *typed-resolve* single-field cover (`Continue` → resolve → branch).
   - **Downstream of choosing origin's cover:** you MUST also keep the suggestion
     endpoint (`/api/username/suggest`), the random-username generator
     (`randomUsername.ts`), the offer roster storage (migrations `0061`/`0062`),
     the suggested-handle screens on iOS + Android, AND the claim-gate
     (`778dfbcd`) — they are one indivisible feature. The vps-e2e / test-tools
     (`f8e206cb`, `83440ead`) also now route through `/suggest` and will FAIL if
     the endpoint is dropped.
   - **Downstream of choosing local's cover:** you must REVERT origin's cover +
     suggestion feature + claim-gate, and decide whether sign-up still claims a
     typed name (which re-opens the grammar question below).

2. **Which username grammar?** Origin's *dashed* (`interior single dashes, no
   `--`, no leading/trailing`) **vs.** local's stated *no-hyphen* (`[a-z0-9]{3,30}`).
   - This is **coupled to decision 4**: dashed usernames are only safe with a `--`
     delimiter. No-hyphen usernames are what make a single-dash delimiter safe.
     You cannot mix "no-hyphen username" with "`--` delimiter" arbitrarily, nor
     "dashed username" with single-dash delimiter (that's the ambiguity the whole
     origin line exists to remove).
   - The grammar regex is duplicated in **three** places (control-plane
     `labels.ts`, services-zone `validation.ts`, webapp `bootstrap.js`) — whatever
     you choose, all three must match. Origin's `isValidUsernameShape` helper was
     introduced to kill that drift; keep it if you keep dashed.

3. **Is the `--` service-id delimiter kept?** This is the IMMUTABLE on-box id and
   the public service URL (`<slug>--<creator>`). If ANY box already minted ids
   with `--`, reverting is a data-migration problem, not a code revert. Confirm
   whether any real/gym box has persisted a `--` id before treating this as
   reversible. **Recommendation surfaced, not decided:** decisions 2, 3, 4 are
   really ONE decision — adopt the whole dashed-grammar+`--` bundle, or none of it.

4. **(Implied) Keep the claim-gate?** `778dfbcd` makes a username claimable ONLY
   if the server recently suggested it (`offers` roster). This hard-depends on the
   suggestion feature (decision 1) and migrations 0061/0062. If the suggestion
   cover is dropped, the gate must be dropped or every claim 403s.

---

## 4. Recommended reconciliation ORDER

The two sets are ~90% disjoint by file. The asymmetry that drives the order:
**origin's grammar/delimiter/cover/claim-gate are an interlocked bundle that
auto-merges INVISIBLY; local's SWK + inbox + transfer are largely additive and in
files origin never touched.** So make origin the base and RE-APPLY local on top
**as a real merge with eyes open**, not a fast clean merge.

> Use `origin/main` as the **base** (it's the shared/pushed ref; rebuilding it
> from local would orphan 24 shared commits). Bring local's 15 commits onto it.

**Step 0 — Decide §3 first.** Steps below assume the team chose to KEEP origin's
dashed-grammar + `--` + suggestion + claim-gate bundle (the no-revert path). If
the team instead rejects that bundle, insert a "revert the bundle on origin"
sub-track before Step 1 and re-run the gates — that is a larger, separate effort.

1. **Merge `2f480ce6` into `origin/main`** (or rebase local's 15 onto origin).
   Expect the single `schemaStatus.ts` marker → resolve as the UNION
   (`…0059,0060,0061,0062`).
   - **Gate:** `npm run typecheck` (`tsc -b`) + `npm run test` (`vitest run`) on
     the merged tree. Both must pass before continuing.

2. **Manually reconcile the mobile mock fixtures** (`MockScreensClient.swift`,
   `MockBuildClient.kt` — the only true both-sides files besides schemaStatus).
   Git merges them clean, but VERIFY every fixture serviceId is `--` form and
   local's `entryFailStatus`/`simulatedFailureStatus` 404 hooks still compile and
   assert against `--` ids. Sweep the rest of local's mobile diff (AppState,
   ServerDetail, HomeTab, build-404 copy) for any hard-coded single-dash id or any
   reference to the removed `/pods` booleans that origin might still read (none
   found, but confirm).
   - **Gate:** iOS build + `swift test`; Android build + the JVM unit tests
     (`MockScreensClientTest`, `BuildModeViewModelsTest`, `BootApprovalWatcherTest`).

3. **Reconcile the webapp cover boundary.** Local's webapp SWK work
   (`keystore.js`, `lib/api.js`, `views/create-server.js`) and inbox work
   (`lib/boxInbox.js`, `lib/bootApproval.js`, `views/home.js`, `views/boot-approval.js`)
   live in DIFFERENT files than origin's cover (`bootstrap.js`, `modal.js`,
   `openAccount.js`) — they should compose. Confirm local's create-server SWK-embed
   path is still reached from origin's random-handle sign-up flow (the create flow
   moved behind `createAccount`). This is the one webapp seam where a silent hybrid
   could break: trace sign-up → wizard `secure-account` → create-server → SWK embed.
   - **Gate:** `vitest run` for `apps/web/tests/*` (createServerView, webappBoxInbox,
     webappKeystore, webappHomePendingServers, plus origin's webappAccountAccess /
     bootstrap tests).

4. **Run the every-merge gym gate** (`npm run gym:every-merge`, or
   `gym:locked` for the full mock matrix) across web · iOS · Android. This is the
   first thing that exercises the cover + create-server + inbox END TO END on the
   real app and would catch a hybrid that compiled but mis-wires the flow.

5. **Run e2e tooling** that origin re-pointed at `/suggest`
   (`tools/vps-e2e/src/runE2E.ts`, `scripts/smoke-register.ts`,
   `tools/live-e2e/recipe-provision.ts`). These FAIL fast if decision 1 dropped
   the suggestion endpoint — a useful tripwire.
   - **Gate:** `gym:total` (overnight, real cloud) before the reconciled `main`
     is pushed, since it provisions a real box and drives the backend chain
     (this is where a phone-provisioned-SWK × random-handle interaction would surface).

**Validation gate summary per step:** `tsc -b` and `vitest run` after Step 1;
native builds + native unit tests after Step 2; webapp vitest after Step 3;
`gym:every-merge`/`gym:locked` after Step 4; e2e + `gym:total` before push.

---

## 5. Risks

- **The headline risk — silent hybrid.** `git merge` raises ONE marker
  (`schemaStatus.ts`) and reports success. Everything else "auto-resolves." A
  naive merger sees a clean tree and pushes a `main` that ships origin's
  random-handle cover **plus** local's typed-resolve assumptions in adjacent
  webapp/mobile code, or local fixtures still on single-dash ids next to origin's
  `--` grammar. It compiles. The decisions in §3 were never actually made by a
  human — they were made by "whoever touched the file last." **Mitigation:** treat
  §3 as a required pre-merge sign-off; do NOT let a clean merge stand in for a
  decision.
- **`userdata.ts` / recipe seam.** Local's `flagship-burner/src/userdata.ts` +
  `loadBlob.ts` (SWK sibling preservation) and origin's grammar changes don't
  share a file, but both feed the recipe → install-blob → daemon chain. A clean
  textual merge can still produce a recipe whose `swkHex` sibling survives but
  whose serviceIds are single-dash, or vice-versa. Step 2/Step 5 are the catch.
- **Claim-gate × dropped suggestion.** If the team picks local's cover but a sloppy
  merge keeps origin's claim-gate (`778dfbcd`), every username claim returns
  `403 "pick one of the suggested handles"` because no `offers` roster is ever
  populated. tsc/vitest may pass (the gate is wired behind optional `deps.offers`);
  only the gym/e2e claim path catches it.
- **What the gates DO catch:** `tsc -b` catches type drift from the `--`/grammar
  helper signatures; vitest catches the validator + serviceId parse tests (origin
  ships `serviceId.test.ts`, `validation.test.ts`, `usernameClaimGate.test.ts`,
  `randomUsername.test.ts`); the gym catches the cover→create→inbox wiring; the
  vps-e2e `/suggest` routing is a tripwire for decision 1. **What they DON'T:** a
  cosmetically-correct-but-wrong-design cover (both designs "work"), and any
  single-dash id already persisted on a real box (a data problem no test sees).

### Gym slowness note (~2min/test on local main)

Investigated briefly. Findings (medium confidence):
- The gym package (`tools/gym/**`) is **untouched** by all 15 local-main commits.
- The SWK first-boot path local main added (`server-daemon/src/index.ts`
  `swkHexFromInstallBlob`/`persistSwkHex`) is all non-blocking local file I/O
  (`tryReadFile` returns `null` on miss; no network, no unbounded await) — **not a
  plausible boot hang.**
- Local main's "poll" additions (`BootApprovalWatcher.pollOnce`, web `bootApproval.js`)
  are single-shot, closure-injected, and in tests run at latency 0 / interval 1ns
  — **not a hang.**
- The gym README states it drives the **real app** per surface (native simulator /
  browser cold-launch + screenshot capture). ~2 min/test is consistent with
  per-scenario app cold-boot + screenshot overhead, i.e. **environmental**
  (simulator/browser/screenshot), not a regression introduced by one of the 15
  commits. **Recommendation:** before blaming a commit, profile one gym scenario
  in isolation (cold-launch timing vs. assertion timing) and check the
  simulator/headless-browser warm-up; bisecting the 15 commits is lower-priority
  given none touch the harness or add a blocking boot await.

---

## 6. One-line conclusion

The merge is *mechanically* trivial (one benign `schemaStatus.ts` union) and
*semantically* dangerous: origin's interlocked **dashed-username + `--` delimiter +
random-handle cover + claim-gate** bundle auto-merges with no markers and would
silently overwrite local's cover/grammar stance. Decide §3 first, base on
`origin/main`, re-apply local's 15 (SWK + inbox + transfer) with the §4 gates,
and rely on the **gym + vps-e2e `/suggest` tripwire** — not `git merge`'s clean
exit — to prove the result.
