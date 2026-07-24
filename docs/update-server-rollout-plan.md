# "Update this server" — end-to-end rollout plan

**Status (updated 2026-07-24):** Phases 1–3 are BUILT, tested, and committed on
`plan/update-server-feature` (pushed). The whole tree is green (`npx tsc -b` +
`npx vitest run` = 570 files / 7332 tests). Phase 4 (live validation) has its
SOLO portion done — a faithful real-git rehearsal of the entire box pipeline
passes — and now needs the infra/human steps (a box running the Phase-1 gate,
plus the owner's YubiKey for the real ceremony). See "Progress log" at the end.

Written 2026-07-23; being executed 2026-07-24.

**Goal:** the "Update this server" button works seamlessly from all three
clients (webapp, iOS, Android) — an owner taps it, the box pulls the endorsed
target commit, rebuilds, restarts into it, and rolls back automatically if the
new code fails its boot health gate. No SSH, no rescue, no manual box surgery.

**One-line summary of the situation:** almost the entire feature is ALREADY
BUILT and wired. It is blocked on exactly one thing — a maintainer *release
authority* that can endorse a commit — and that was deliberately deferred at
genesis (2026-05-19). This plan unblocks it the way the owner chose in
conversation: **one root authority endorses releases too** (collapse), rather
than standing up a separate release key right now.

---

## 0. What already exists (do NOT rebuild any of this)

Verified in the tree on 2026-07-23:

| Piece | Location | State |
|---|---|---|
| Box-side update consumer (fetch→gate→checkout→rebuild→exit0→health-gate→rollback) | `packages/server-daemon/src/updateConsumer.ts` + `updateHealthGate.ts` | built, wired in `index.ts` (~L2791) |
| `.com` update lane (deposit + consume-once) | `POST/GET /api/server/:domain/update` — `secretMailbox.ts` L1300+, route `controlPlaneRoutes.ts` L530 | built |
| 2-of-2 authorization gate (admin-root master gate) | `authorizeSensitiveOrder` (`adminAuthorityLocal.ts`), tag `flagship/server-update/v1` | built |
| 2-of-2 authenticity gate (maintainer endorsement) | `selfUpdateReleaseGate.ts` → `releaseVerifier.ts` | built — **fails closed today** (see §1) |
| `currentCommit` reported by the box | `screens/screensHttp.ts`, surfaced on all 3 clients | built |
| **Webapp** Update UI (card + button + signer) | `views/server-detail.js` L284-334, `lib/serverUpdate.js` | **built** — signs the order with the owner's admin root / UMK |
| iOS Update UI | `UpdateServerViewModel.swift`, `ServerUpdateFlow.swift` | built |
| Android Update UI | `viewmodels/UpdateServerViewModel.kt`, `ui/screens/ServerDetailScreen.kt` | built |
| Endorsement-minting CLI | `maintainers/packages/cli` → `endorsement`, `upsert-mandate` (YubiKey-signed) | built |
| Spec | `docs/server-update-mechanism.md` | written |

So this is NOT a feature build. It is a **trust-bootstrap + validation** task.

---

## 1. The single blocker

The box's authenticity gate requires a **maintainer release endorsement** whose
`commitHash` is the target commit, verified against a **release-track authority**
that verifies FORWARD from the baked `MAINTAINER_PINNED_MANDATE_HASH`.

Proven empirically (ran the real `@ibisllc/maintainers` verifier, 2026-07-23):

```
ca track    -> root: ANCHORED   authority: yes
release trk -> root: null       rootError: pin-not-in-log   authority: no
```

Two facts make this a deliberate gap, not a bug:

1. **One baked pin anchors exactly one track.** `verifyMandateChainFromPin`
   matches a mandate by its exact canonical bytes; the baked pin equals the `ca`
   origin mandate's `mandatePinHash` (confirmed: `5016749377de…801ae`). No
   release mandate can share that hash.
2. **The release track was deferred ON PURPOSE.** `docs/ca-operations.md` §370
   (LOCKED SCOPE, owner, 2026-05-19): *"genesis signs the `ca` track ONLY …
   `release` is deferred to its own later isolated genesis if a release-role ever
   exists."* So there is no release mandate, no release key, and the daemon gate
   fails closed on every update — by design, until now.

Result today: tap Update → order authorizes → box fetches → gate returns
`halted-unendorsed` → nothing is applied. Correct, safe, and useless.

---

## 2. The decision (owner, 2026-07-23): collapse to one authority

We are NOT standing up a separate release key right now. The existing `ca`-track
holder (key#1, `2137e739…71d7`, the YubiKey) will endorse releases too.

**Why this is acceptable for where we are:**
- There is exactly ONE holder key in existence anyway (`.maintainers/keys/`
  holds only `hello@harrywinner.com` + its backup). A separate release *track*
  today would point at the *same key* — separation on paper, zero real key
  separation.
- Code-push already requires TWO more independent factors beyond the
  endorsement: (a) a commit that exists in the hardcoded GitHub remote, enforced
  by the first-parent lineage walk (`verifyEndorsementChainAgainstGit`) — a
  hostile mirror can't substitute commits; (b) an **admin-root-signed
  `UpdateOrder` from the owner's phone/webapp behind biometrics**. The phone
  factor is cryptographically independent of the YubiKey.
- For a one-box, one-user, pre-release system this layering is enough.

**The two conditions attached to the decision:**
1. Make it an EXPLICIT, commented choice in code + correct the docs that
   currently advertise three working tracks. No silent drift.
2. Leave the door open: a future real `release` track must take precedence
   automatically with no further code change.

**What we are NOT doing (and why):**
- NOT re-baking the pin to a release mandate — that would break the LIVE `ca`
  track (`CA_ENDORSEMENT_ENFORCE=true` in prod).
- NOT merging the tracks in the maintainers protocol itself — the protocol's
  multi-track model stays intact; only Flagship's *daemon gate* chooses to accept
  a ca-signed endorsement as a fallback.

---

## 3. Implementation phases

### Phase 1 — Box gate: accept the `ca` chain as the release authority (fallback)

The ONLY code change to the trust logic. One seam, in the daemon, commented as a
deliberate pre-release posture.

- **File:** `packages/server-daemon/src/releaseVerifier.ts`, `verifyStore()`.
  Where it resolves the release chain to verify endorsements against
  (`chainsByTrack.get("release")`), fall back to the `ca` chain:

  ```ts
  // PRE-RELEASE POSTURE (docs/update-server-rollout-plan.md §2): with no
  // dedicated release track yet, the ca-track authority (the single YubiKey
  // holder) also endorses releases. A real `release` track, once it exists,
  // wins automatically — this fallback only fires when `release` is absent.
  const releaseChain =
    chainsByTrack.get("release") ?? chainsByTrack.get("ca");
  ```

  Apply the same `?? get("ca")` at every `chainsByTrack.get("release")` site
  (there are a few — endorsement verification, takeover-alarm derivation). Audit
  each: the takeover-alarm one may want to stay release-only; decide per-site,
  document the choice inline.

- **`ReleaseEndorsement` has no `track` field** (confirmed — it binds to a chain
  purely via `signedBy`/signatures). So a ca-holder-signed endorsement verifies
  cleanly against the ca chain with zero protocol change.

- **Tests** (`packages/server-daemon/tests/releaseVerifier*.test.ts`):
  - POSITIVE: a ca-holder-signed `ReleaseEndorsement` for commit X is accepted
    when only the `ca` track exists; `currentRelease.commitHash === X`.
  - NEGATIVE (must stay red): an endorsement signed by a NON-holder key is
    rejected. A forged endorsement whose declared lineage doesn't match the git
    walk is rejected. An endorsement for a commit not in the repo is rejected.
  - PRECEDENCE: when BOTH a `release` chain and a `ca` chain exist, the
    `release` chain is used (the fallback does not shadow a real track).
  - Mutation-check each positive by breaking the fallback and confirming red.

- **Correct the docs the change contradicts:**
  - `.maintainers/README.md` — the "three tracks" table; note release rides `ca`
    pre-release.
  - `docs/ca-operations.md` §370 LOCKED SCOPE — add a dated superseding note:
    the release role is now filled by the ca authority as a deliberate
    pre-release collapse (this plan), not by app-store signing.
  - `docs/server-update-mechanism.md` — reflect the fallback.

### Phase 2 — The endorsement ceremony (one YubiKey signature, per release)

Mint a `ReleaseEndorsement` for the target commit, on the `ca` track, with key#1.

- **Tooling:** `maintainers` CLI `endorsement` verb (`--track ca`,
  `--commit <sha>`, `--signing-key <yubikey source>`). It reads the ca mandates,
  the holder key signs, emits a `ReleaseEndorsement` envelope.
- **Where it lands:** committed under `.maintainers/endorsements/` (the verifier
  reads `<rootDir>/endorsements/*.json`, filename-sorted). NOTE the endorsement
  for commit X is typically committed AFTER X, so the box reads it from
  freshly-FETCHED refs (`origin/main`, `FETCH_HEAD`) — which the consumer fetches
  before consulting the gate. So: endorse HEAD, commit the endorsement on top,
  push; the box fetches both.
- **Lineage:** `previousCommitHash` / `intermediateCommits` must describe the
  real first-parent path from the box's current commit to the target, or the
  git-walk defense rejects it. The CLI computes/validates these; feed it the
  box's reported `currentCommit` as the "from".
- **Dry-run first** (`--dry-run`) — nothing is signed until the real tap.
- **Write a thin wrapper script** `scripts/endorse-release.mjs` that: reads the
  box's `currentCommit` (or takes `--from`), takes `--to <sha>` (default: current
  `main` HEAD), runs the CLI dry-run, prints the envelope for review, then on
  confirm does the real signed run and stages the commit. Owner runs it; the
  YubiKey tap is theirs.

### Phase 3 — Client verification (already built — exercise, don't build)

All three UIs exist. This phase is *proving they work against a real endorsed
update*, and fixing whatever surfaces.

- **Webapp** (`lib/serverUpdate.js` + `server-detail.js`): confirm the OWNER
  profile signs `flagship/server-update/v1` with the admin root and deposits to
  `.com`. Confirm a COMPANION/remote session cannot (no seed → the sensitive
  signer throws; it is not in `companionGuard` UNAVAILABLE_IDS, so ALSO add
  `update-server-btn` there for an honest disabled state — small gap to close).
- **iOS / Android:** rebuild is required regardless (they also carry the Remote
  rename). Confirm `fromCommit` is read from the box's `currentCommit` (never
  guessed), the biometric fires once, the order deposits.
- **`fromCommit` freshness across all three:** the order's `fromCommit` MUST equal
  the box's live HEAD or the consumer rejects (anti-skip). All clients already
  source it from server-detail; verify no staleness window after the box updates.

### Phase 4 — End-to-end validation on the live box

The demo box (`home.openai-build`) is the test rig. It is currently on commit
`~2026-07-21` with a DIRTY working tree (the CORS hand-patch — see §5).

1. **Reconcile the dirty tree FIRST** (§5) or the `git checkout` step conflicts.
2. Pick a small, safe target commit (e.g. current `main`), endorse it (Phase 2),
   push endorsement.
3. From the webapp, tap "Update this server". Watch:
   - order deposits on `.com`;
   - box consumes, fetches, gate passes (endorsed), checks out, rebuilds,
     `exit(0)`, systemd restarts;
   - boot health gate COMMITS the update on a healthy boot;
   - `currentCommit` now reports the target.
4. Repeat from iOS and Android once rebuilt.
5. **Rollback drill:** endorse a commit known to fail the health gate (or inject
   a failure) and confirm the box auto-rolls-back and reports the old commit —
   proving a bad update can't brick the one box before the competition.

---

## 4. Definition of done

- [x] Box gate accepts a ca-holder-signed release endorsement; precedence + all
      negative tests green; mutation-checked. (`releaseVerifier.ts`
      `resolveReleaseChain` + 4 new tests; mutation-checked 2026-07-24.)
- [x] `scripts/endorse-release.mjs` exists; a dry-run produces a valid envelope.
      (Dry-run + a full software-signed rehearsal both verified.)
- [x] `.maintainers/README.md`, `ca-operations.md` §370, `server-update-mechanism.md`
      corrected to describe the collapse.
- [x] `update-server-btn` added to webapp companion UNAVAILABLE_IDS (+ test).
- [x] Full `npx vitest run` + `npx tsc -b` green. (570 files / 7332 tests.)
- [x] Faithful local rehearsal of the whole pipeline passes
      (`scripts/update-pipeline-rehearsal.mjs`): real git fetch→gate→checkout→
      rebuild→commit, replay + unendorsed refusals, and a real auto-rollback.
- [ ] Merge `plan/update-server-feature` to `main` (owner sign-off — it puts the
      pin-override seam + ca fallback on trunk).
- [ ] Live: webapp-initiated update moves a box to a new endorsed commit and
      commits on healthy boot (dummy box with the pin override, and/or the real
      `home.openai-build` after the YubiKey ceremony).
- [ ] Live: iOS + Android initiate the same successfully (post app rebuild).
- [ ] Live: rollback drill proves auto-recovery on a real box.

---

## 5. Reconciliations / traps (read before starting)

- **The demo box tree is DIRTY, and the consumer will NOT force past it.**
  CONFIRMED: `updateConsumer.ts` L506 runs a plain `git checkout <target>` — no
  `-f`, no `git reset --hard`, no stash. Plain checkout ABORTS if it would
  overwrite a locally-modified file. The 2026-07-23 CORS fix was hand-applied to
  `/opt/flagship/packages/server-daemon/src/cors.ts` (backup on-box:
  `cors.ts.bak-20260724-005404`), so `cors.ts` is locally modified.
  - Git only blocks the checkout when the local content *differs from the target*
    AND *differs from HEAD*. `main` already carries these exact CORS origins
    (`3320e859`), so a target on recent `main` may be byte-compatible enough that
    checkout succeeds — but do NOT rely on byte-luck.
  - **Deterministic fix (do this):** in the SAME rescue pass that bootstraps the
    Phase-1 gate onto the box (§6 step 2), run `git -C /opt/flagship checkout --
    packages/server-daemon/src/cors.ts` to discard the local edit, THEN
    `git checkout <bootstrap-commit>` (which already contains the CORS origins).
    After that the tree is clean and every future OTA update checks out cleanly.
  - Alternative, considered and rejected: patching the consumer to `git reset
    --hard` before checkout. That would let an update silently discard box-local
    state — the opposite of what we want. Keep checkout non-destructive; clean the
    tree out-of-band instead.
- **`ca` mandate expires `2026-08-27` (~5 weeks).** Once releases ride the `ca`
  authority, that expiry ALSO kills the ability to update boxes (expired mandate →
  `currentAuthority` null → endorsements rejected). AGENTS.md already tracks
  "re-mint the lease before 2026-08-31" — now that task gates updates too. Re-mint
  is a `upsert-mandate` succession on the ca track (existing runbook).
- **App-store-signing alternative is now bypassed.** §370 named "app-store
  signing + reproducible-build CI" as the v1 update-integrity story. This plan
  chooses the maintainer-endorsement path instead (it's what the daemon actually
  enforces). Note the supersession so the two docs don't contradict.
- **Webapp companion honesty gap:** `update-server-btn` is not in
  `companionGuard`'s UNAVAILABLE_IDS. Functionally safe (a keyless session has no
  seed to sign), but the button should visibly disable for companions. One-line
  add.

---

## 6. Order of operations (the short version)

1. Phase 1 code + tests on this branch → green → merge to `main`.
2. Deploy nothing yet (box-side change ships to the box via the update itself —
   chicken/egg: the FIRST update must be applied by a box already running the
   fallback). **Resolve the bootstrap:** the box that will do the updating needs
   the Phase-1 gate code. For `home.openai-build`, fold Phase 1 into the target
   commit AND get it onto the box via one more rescue (or a reburn) — after that,
   all future updates are seamless over-the-air. Document this one-time bootstrap
   explicitly; it is the same chicken/egg every self-update system has.
3. Phase 2 ceremony → endorse the target.
4. Phase 3 rebuild clients.
5. Phase 4 live validation + rollback drill.

> The bootstrap in step 2 is the one unavoidable manual touch. After it, "Update
> this server" is fully seamless from every client, forever.

---

## Progress log

**2026-07-24 — Phases 1–3 shipped on the branch; Phase 4 solo portion done.**

- **Phase 1** (`e1384d66`): `releaseVerifier.ts` `resolveReleaseChain` prefers a
  real `release` track and falls back to `ca`. Takeover-alarm stays release-only
  (documented). 4 new tests (accept ca-signed; reject non-holder; precedence both
  ways) + mutation-checked. Docs corrected.
- **Phase 2** (`5970e61e`): `scripts/endorse-release.mjs` — dry-run preview +
  `--sign`. Computes the endorsement's lineage the way the box re-walks it
  (genesis ⇒ full first-parent history; else the delta). Added
  `FLAGSHIP_MAINTAINER_PIN_OVERRIDE`, a loudly-logged bring-up seam so a dummy
  box can use a throwaway ca authority. Rehearsed: a scratch ca track signs a
  genesis endorsement for HEAD and both halves of the box gate (crypto + git
  walk) return PASS.
- **Phase 3** (`099950ad`): `update-server-btn` added to the webapp companion
  `UNAVAILABLE_IDS` (+ test). Confirmed all three clients source `fromCommit`
  from the box-reported `currentCommit`.
- **Phase 4 (solo)** (`5910fbf3`): `scripts/update-pipeline-rehearsal.mjs` drives
  the REAL consumer + boot gate + release gate + 2-of-2 auth against REAL local
  git. Proven: good update commits on healthy boot; replay rejected; unendorsed
  refused; endorsed-but-unhealthy update auto-rolls-back. All assertions pass.

**2026-07-24 (later) — LIVE end-to-end validation PASSED on a real Hetzner box.**
Merged Phases 1–3 to `main` (`cebbbc16`), provisioned a throwaway demo box
`home.update-drill.flagship.services`, and ran the FULLY-REAL-authority update:

- **Demo-box authority gap found + closed.** A demo account's admin authority
  (admin root + primary-device `admin` grant) is entirely KEK-derived and
  Worker-held; demo pairing only hands a device a keyless session. So no
  phone/webapp can order an update on a demo box (incl. `openai-build`). Added
  `handleOrderDemoUpdate` → `POST /api/dev/sample-user/:u/order-update` (admin-
  gated): the Worker re-derives the demo admin root and deposits a real
  admin-signed `UpdateOrder`. Real USER accounts are unaffected (phone signs
  directly). Dev tool — remove at GA with the other `/api/dev/*`.
- **Shallow-clone bug found + fixed** (`cebbbc16`): real boxes are `git clone
  --depth 50`; the genesis endorsement's first-parent walk needs full history.
  The consumer now `git fetch --unshallow`es a shallow clone before the gate.
  Would have blocked the first update on EVERY box; surfaced by the rehearsal.
- **Verification vehicle** (`83a5c0bf`): the box now advertises its running
  commit on public `/api/leads` — the unauthenticated proof signal.
- **The run:** owner tapped the YubiKey (real ca endorsement of `83a5c0bf` via
  the Phase-1 fallback); admin route deposited the demo-admin-signed order;
  box consumed → unshallowed → gate passed → checked out → rebuilt → restarted
  (a ~30s `root=000` blip) → boot-health COMMITTED. `/api/leads` flipped from
  no `commit` field → `commit:83a5c0bf`, stable, cert valid. **Every layer of
  the real 2-of-2 exercised on real infra.**

**Remaining:**
- **`openai-build` (reviewer box).** Messier than the throwaway: old unknown
  HEAD, shallow, dirty tree (last session's `cors.ts` hand-patch), no SSH.
  Decide in-place update (needs its HEAD read + the dirty `cors.ts` reconciled;
  `main` now carries those CORS origins so a checkout MAY be byte-clean — §5)
  vs a clean reprovision onto latest `main`.
- **iOS/Android** initiate the update for REAL user accounts once rebuilt.
- **Live rollback drill** on a real box (proven in the rehearsal; optional live).
- **Tear down `update-drill`** (`sample-user cleanup update-drill`) when done.
- **Re-mint the ca mandate before 2026-08-27** — it now also gates updates.
