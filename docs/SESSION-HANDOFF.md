# Session handoff — portable cold-start (works on ANY dev machine)

**Read this FIRST.** This file is the in-repo, machine-portable source of
truth. The richer agent-memory (`~/.claude/projects/.../memory/
project_resume_2026_05_16.md`) is local to one machine and the harness
TaskList does NOT persist across sessions — so the authoritative backlog
lives **here, in git**. Rebuild your task list from §3 below.

Last updated: 2026-05-17 (**v1-launch program session 2**, Mac/darwin
box. Phase 1 AGENT: signer threaded through genesis/mandate/takeover
**and** release endorsement (one async signing path), **and** the
missing `ca-endorsement` command + the on-disk CA-lease store
convention — three security-critical commits on
`feat/piv-ed25519-signer`, each green+pushed, draft PR #2 tip
`3a4bbe9`, maintainers **270→277**. Flagship-side: `rotate-ca.mjs`
Step-2 + `ca-operations.md` Path B now reference the real
`yubikey-piv:` source; flagship gate held **2526/2526 · tsc clean**.
**Phase-1 AGENT remaining (next session START, attentively — NOT
tail):** `--dry-run` (needs the unsigned/sign split for byte-fidelity)
+ ceremony banner/typed-confirm + never-log-secrets test + native
PC/SC transport stub, then the 1B human gate. Session 1 (same day):
keystone `Ed25519Signer`+`loadSigner`/`PivTransport`, created
`docs/v1-launch-program.md`. See §0.)

## 0. Drift log (verify-before-trust findings, newest first)

- **2026-05-17 (v1-launch program session 2, Mac/darwin):**
  - **No env-sync drift this session** (verify-before-trust): the
    gitignored `maintainers/` clone was already on
    `feat/piv-ed25519-signer` @ `9e7c495` (clean) from session 1 —
    `pull-maintainers.sh` was therefore NOT run (it would discard the
    branch checkout for the pin). Gate at start confirmed: flagship
    **2526/2526 · tsc clean**, maintainers (on branch) **270/270 · tsc
    clean**. Continue rule holds for the next cold start: if the clone
    is stale, `pull-maintainers.sh` then `git fetch && git checkout
    feat/piv-ed25519-signer`; if already on the branch & clean, do NOT
    pull.
  - **Phase-1 #28 — three security-critical commits landed (green,
    pushed, draft PR #2):**
    - `d2027df` thread the external signer through genesis/mandate/
      takeover: async `build*`, keys via `loadSigner`/`loadSignerPubKey`
      (+ new `loadSignerPubKeyList` for a `yubikey-piv:` second key in a
      successors/holder CSV — §11.2), `signMandateWith`. `dispatch`/
      `run` async; each command `await`ed inside the try so a `CliError`
      still maps to exit 1; bin shim awaits. `CliEnv` gains optional
      `pivTransport`/`pivPin` (real transport fail-closes — NEVER a
      silent hex fallback). New test proves the YubiKey-PIV genesis is
      byte-identical to the hex path and verifies (the §11.1 linchpin
      end to end). 270→271.
    - `5148bbf` thread the signer through release `endorsement` too
      (§10.1: ALL maintainer-key ceremonies on the one path; the legacy
      `loadPrivKey` had also *rejected* `yubikey:`). 271.
    - `3a4bbe9` add the missing **`ca-endorsement` command** +
      `store.ts` `writeCaEndorsement` defining
      `.maintainers/ca-endorsements/<ts>-<id>.json` — exactly what
      `rotate-ca.mjs` `readCaEndorsements` already reads. Closes the
      real gap from session-1 §0 (Op 1 Path B referenced a nonexistent
      command). Non-fatal advisory when the signer is not the on-disk
      ca authority; never hard-fails (authority is the verifier's call
      at its own clock; overlapping leases/takeovers are legitimate).
      Cross-checked end to end vs `verifyCaEndorsements`/
      `authorizedCaKeys`. 271→**277**.
    - ZERO protocol/canonical/wire/spec delta across all three (a
      PIV-Ed25519 signature over the canonical bytes is byte-identical
      RFC-8032 Ed25519). `tsc -b` clean throughout.
  - **Flagship-side (→ origin/main):** `scripts/rotate-ca.mjs` Step-2
    fallback now references `--signing-key yubikey-piv:slot=9c` (file:
    documented as the lower-assurance air-gapped/successor fallback);
    `docs/ca-operations.md` Path B corrected — the command + signer
    source now exist, "staged" note removed. `rotate-ca.test.ts` is
    pure-logic (doesn't exercise the print path) so the string change
    is test-safe; flagship gate held **2526/2526 · tsc clean**.
  - **Phase-1 AGENT remaining (next session START, attentively — do NOT
    tail-bolt; security-critical ceremony surface):** (1) `--dry-run`
    for genesis/mandate/takeover/ca-endorsement — print the EXACT
    canonical bytes + the would-write `.maintainers` diff and sign/
    write nothing; resolve pubkeys via the no-PIN public read only.
    **This requires refactoring each `build*` to first compute the
    *unsigned* envelope + target path, then sign**, so the dry-run
    preview is the same bytes the real run signs (fidelity is the
    point; uuid/timestamps differ across separate invocations — note
    that in the banner). (2) Plain-language per-ceremony banner + typed
    explicit confirm before any token-touch/write (injectable;
    `--yes`/non-interactive bypass for tests) + a regression test
    asserting PIN/seed never appears in any emitted line + second-key/
    successor guidance. (3) Native PC/SC `PivTransport` stub: APDU
    encode/parse (SELECT PIV AID `A0 00 00 03 08`, VERIFY PIN, GENERAL
    AUTHENTICATE Ed25519, GENERATE) as pure tested functions behind a
    channel seam; the libpcsclite round-trip fail-closes precisely (no
    new mandatory dep; NEVER a hex fallback), verified only at the
    YubiKey gate. Then 1B human gate.
- **2026-05-17 (v1-launch program session 1, Mac/darwin):**
  - **NEW authoritative tracker:** `docs/v1-launch-program.md` created
    (first run from the `/alpha` Phases-1-8 prompt). It is now the
    source of truth for *which phase + what's done*; this file stays
    the fine-grained backlog/drift/gate source. Cold-start read order
    adds it after §0/§3/§5.
  - **Cold-start env-sync drift (found+fixed, NOT a regression):** on
    this Mac the gitignored `maintainers/` clone was stale at
    `c009900` (pre-CaEndorsement) → `npx tsc -b` RED on two
    `packages/server-daemon/src/caTrustChain.ts` imports of
    `authorizedCaKeys`/`CaEndorsement`. Fix is the documented one:
    `bash scripts/pull-maintainers.sh pull` (idempotent; resets to the
    pin `10c65aa`). Then flagship gate **2526/2526 · tsc -b clean**,
    maintainers suite **257/257**. **Every cold start on a fresh
    machine must run pull-maintainers first** (the clone is not
    vendored). `timeout(1)` is absent on macOS — don't wrap commands
    in it.
  - **Environment delta (this box):** darwin/Mac, Xcode 16.4
    (xcodebuild present → iOS verifiable here), **no real JDK**
    (`/usr/bin/java` stub → Android review-only here). Inverse of the
    resume-#2 Linux box. iOS sim UDIDs in memory may be stale.
  - **Phase 1 / #28 — two keystone pieces built+green+pushed:**
    `protocol` external `Ed25519Signer` (`f646f99`: interface +
    `privKeySigner` wrapper [ONE signing path] + `sign*With` async
    variants; **ZERO canonical/verifier/wire/spec change** — the
    §11.1 linchpin; back-compat with all `{privKey}` callers) and
    `cli` `loadSigner`/`PivTransport` seam (`9e7c495`: injectable PIV
    transport, fail-closed `realPivTransport` [no silent hex
    fallback], `loadSignerPubKey` no-PIN read, PIN-never-logged
    test). maintainers **257→270** green, `tsc -b` clean. On upstream
    branch `feat/piv-ed25519-signer`, **draft PR
    `ibisllc/maintainers#2`** (push+PR pre-authorized §10.4; merge
    governed; on merge bump `scripts/maintainers.pinned-sha` +
    re-pull). Branch is PUSHED (durable — not lost like the original
    `feat/ca-endorsement`).
  - **Real gap surfaced (verify-before-trust):** `docs/ca-operations.md`
    Operation 1 Path B invokes `node packages/cli/dist/index.js
    ca-endorsement …` but **no `ca-endorsement` CLI command exists**
    (commands = genesis/mandate/endorsement[=Release]/takeover/verify/
    status; the CaEndorsement *protocol* sign/verify landed in PR #1,
    the *issue-a-lease command* did not). Blocks Operation 1 (weekly
    lease) at the human gate. Tracked in the #28 row + program doc
    Phase 1; build it with the command-threading increment.
  - **Phase 1 remainder (deliberately NOT tail-bolted — security-
    critical ceremony surface):** thread `loadSigner` through
    genesis/mandate/takeover (async `build*` refactor); genesis/
    ceremony UX hardening (banner, `--dry-run` = print canonical
    bytes + `.maintainers` diff & write nothing, typed confirm,
    never-log-secrets, fail-closed reasons); the `ca-endorsement`
    command; native PC/SC `PivTransport` (verified only at the
    YubiKey human gate). Start the NEXT session attentively, not at a
    tail.
- **2026-05-16 (resume #2, #8 done + #9/#10 SCOPE CORRECTED):** the
  governed PR #1 was merged by the maintainer (authorized via the
  session prompt); re-pinned `scripts/maintainers.pinned-sha` →
  `10c65aa` (merge commit, NOT branch tip `5cace76`); `0697bab`.
  `pull-maintainers.sh` reset the snapshot cleanly;
  `@maintainers/protocol` now exports the CA API. **#8 daemon port
  built + tested** (`beb6279`: `caTrustChain.ts` + `releaseVerifier.ts`
  `verifiedTrackFromFolder`; 7 tests; gate 2521). **But the handoff's
  "#8/#9/#10 = mechanical 1-liner per call site via `authorizedCaKeys`"
  was inaccurate** (verify-before-trust): (a) there is **NO production
  call site** of the #30 chokepoint anywhere in flagship — only tests
  reference the raw `verifyDemoDirective`/`verifyUserPubKeyBinding`;
  (b) the maintainers store reader (even post-merge) only knows
  `endorsements/` = `ReleaseEndorsement` — there is **no on-disk
  CaEndorsement directory convention** in the spec or store, and
  flagship's `.maintainers/` has zero endorsements; (c) genesis stays
  empty so the #30 chokepoint fail-closes and the port is never
  consulted regardless. So #8 took CaEndorsements as an **injected
  arg** (invents no disk path); #9 (webapp) needs the upstream store
  convention + a bundled browser verifier; #10 (iOS/Android) ALSO
  needs a Swift+Kotlin reimpl of the TS-only maintainers verify — it
  is the heaviest item, NOT a session-tail 1-liner. #9/#10 re-scoped
  in §3; the real unblock is the upstream CaEndorsement store
  convention (#31/#27 territory), not flagship wiring.
- **2026-05-16 (resume #2, #3 flake — CORROBORATED):** the §0
  parallel-run flake **reproduced once** under heavy concurrent load
  (`1 failed / 2513 passed`) during the post-re-pin gate, then was
  **deterministically green on the immediate verbose re-run**
  (`2514/2514`) and again at `2521/2521` after #8. `tsc -b` clean
  throughout; the changed files (pin SHA, Android, `maintainers/`) are
  provably outside the flagship TS/vitest graph. `personalize.test.ts
  > personalizeStream` was observed at **~19 s** under load (30 000 ms
  `testTimeout`) — consistent with the #3 verdict (rare
  timeout-under-CPU-contention, not a logic bug). No new action;
  watch procedure unchanged.
- **2026-05-16 (resume #2, #33 — FULLY CLOSED):** after the
  `assembleDebug` `@Composable` fix, `./gradlew :app:testDebugUnitTest`
  surfaced a second never-run layer — 4 latent test failures (was the
  whole point of #33). Root causes + faithful fixes: (a) 3 Robolectric
  classes missing the `@Config(sdk = [33])` pin every passing class
  here already carries (Robolectric 4.13 max SDK 34 < targetSdk 35);
  (b) `KeystoreIrkVersionTest`/`KeystoreWipeTest` called production
  `Keystore.attach()` (needs hardware AndroidKeyStore) instead of the
  `attachForTest(prefs)` seam their own docstrings describe; (c)
  `MockScreensClientTest.appsList_returnsKnownApps` asserted the
  pre-#20 bare-name shape vs the iOS source-of-truth namespaced IDs.
  Fixed in `d960691`; **`assembleDebug` green + `testDebugUnitTest`
  190/190, 0 failures.** #33 done. Note: `build-tasks §S:624`
  ("Android on internal-track Play, 5+ testers") is a *launch gate*
  (signing + Play upload + testers), NOT this build/test prerequisite —
  deliberately left unticked; ticking it would be false.
- **2026-05-16 (resume #2, #3 vitest flake — TRIAGED, no code change):**
  the one-off "1 failed / 2503 passed" parallel-run flake. Both §0
  named candidates ruled out **by inspection**:
  `renewIfNeeded.test.ts` is fully deterministic (injected `now`, fake
  issuer, no I/O/shared state); `dns-broker/test/index.test.ts` mutates
  only `globalThis.fetch`/`_internal.ipBuckets` and restores them in
  `afterEach` — and vitest 2.x here runs the **default `forks` pool
  with per-file isolation** (no custom `pool`/`isolate` in
  `vitest.config.ts`), so cross-file contamination is structurally
  impossible. They were "candidates" only because they emit expected
  negative-path stderr (visually noticeable in a failed run's tail) —
  correlation, not the failing assertion. Verdict: **rare
  timeout-under-CPU-contention at maximal fork parallelism, not a
  logic/product bug** (additive-only changes since; `tsc -b` clean;
  2514/2514 green on this session's cold full run). No safe
  evidence-based deterministic fix exists; a speculative spec-pin or
  retry is forbidden by the §0 note itself and would mask. **Watch
  procedure:** on recurrence, capture `npx vitest run
  --reporter=verbose` (names the failing spec + its duration vs the
  30 000 ms `testTimeout`); only then pin/raise that specific spec's
  timeout. #3 closed as triaged.
- **2026-05-16 (resume #2, this Linux box — ENVIRONMENT DELTA):** the
  prior handoff repeatedly asserted "Android review-only (no JDK —
  `/usr/bin/java` is the macOS stub)". **False on this machine:** this
  is a Linux box with **OpenJDK 17 + Gradle 8.10.2 + a populated
  `ANDROID_HOME=/home/kamdemharry/android-sdk`** (platforms 34/35,
  build-tools 34.0.0). #33 is therefore **UNBLOCKED here** and was
  executed. Conversely iOS xcodebuild is **not** available on Linux —
  #7/#79A/iOS-port verification flips from "verifiable here" to
  "review-only here". Pin paths absolutely: the harness shell keeps
  cwd across calls, so a bare `cd apps/mobile/android` compounds.
- **2026-05-16 (resume #2, #33 — REAL never-compiled drift FOUND+
  FIXED):** first real `./gradlew :app:assembleDebug` failed at
  `:app:compileDebugKotlin` — a misplaced `@Composable` annotation in
  `AppDetailScreen.kt` landed on the top-level `STEM_RE` regex const
  (591) instead of `ReplaceStemDialog` (596); the `STEM_RE` decl + its
  comment had been inserted between the annotation and its fn. 3 Kotlin
  errors. Exactly the latent review-faithful drift #33 predicted.
  Fixed by moving the annotation back onto the fn. (Note: a
  `… | tail` pipe masks Gradle's exit code as the pipe's — always read
  `BUILD SUCCESSFUL/FAILED` or `${PIPESTATUS[0]}`, never trust the
  background "exit 0".)
- **2026-05-16 (resume #2, #34 — TRIAGED → v2-deferred):**
  `inheritance.ts` (#77) verdict: **deliberate v2 seam, not a v1 gap.**
  Built+exported+unit-tested (`inheritance.test.ts`), NOT route-wired,
  NOT cron-wired; absent from `build-tasks §S` and `CLAUDE.md`
  outstanding work. Recorded in the new `docs/policy/inheritance.md`
  (the decision record the module's own docstring already pointed at —
  it had been dangling). No v1 action; #34 closed.
- **2026-05-16 (resume, CRITICAL):** `feat/ca-endorsement`
  (`496abae7`) — claimed in `docs/maintainer-ca-endorsement.md` §8/§9
  as "BUILT, durable locally in `./maintainers`" — **did NOT exist on
  this machine and was never pushed anywhere reachable.** `maintainers/`
  is git-ignored and pulled fresh by `pull-maintainers.sh` at the
  pinned SHA (`c009900`); the prior session's local-only branch was
  lost with the original Mac. **Resolution:** the `CaEndorsement`
  workstream was **faithfully reconstructed** from the authoritative
  spec (`docs/maintainer-ca-endorsement.md` §4 + §9, with
  `ReleaseEndorsement` as the explicit template), 4 commits on a fresh
  `feat/ca-endorsement` (tip `5cace76`), **257 maintainers tests green**
  (was 231; +26), `tsc -b` clean across the maintainers workspace;
  pushed to `ibisllc/maintainers`; **PR #1 open**
  (https://github.com/ibisllc/maintainers/pull/1) — merge is governed.
  Exports delivered exactly per §9: `verifyCaEndorsements`,
  `authorizedCaKeys`, `verifyTrackFromCheckpoint`,
  `checkpointFromVerifiedTrack` (+ `signCaEndorsement`,
  `canonicalCaEndorsement`, `CaEndorsement` type).
- **2026-05-16 (resume, minor):** maintainers repo at base `c009900`
  `tsc -b` is clean; adding `CaEndorsement` to the `Envelope` union
  necessarily touched every dispatch site in `cloudflare-worker
  policy.ts` + `web-ui adapter.ts` (parse/canonical/signatures/
  authority/commit-message) — all handled in commit 1, no behavior
  change to existing envelopes.
- **2026-05-16 (resume):** flagship ground truth verified —
  `git log` matches, `tsc -b` clean, `vitest run` **2492 / 221**
  (baseline holds); spot-checked #4/#12/#14/#23 exist in code.
- **2026-05-16 (resume, flake — DISCOVERY):** one intermittent test
  failure observed once under the full `vitest run` (`1 failed | 2503
  passed`), deterministically green on every isolated + full re-run
  (`2504`/`2509` passed). Not introduced by the resume changes (tsc
  clean; additive-only). Likely a parallelism/timing-sensitive spec
  (candidates seen emitting expected negative-path stderr under load:
  `apps/dns-broker/test/index.test.ts`,
  `packages/server-daemon/tests/renewIfNeeded.test.ts`). Triage in
  the discovery sweep — pin the flaky spec or add a deterministic
  wait; do not mask with a blanket retry.

- **2026-05-16 (resume, Android build-blocker — FOUND+FIXED):** while
  wiring #20, found `AppDetailScreen.kt` + `TrustedDevicesScreen.kt`
  construct 3 plain (non-`androidx.lifecycle.ViewModel`) classes via
  Compose `viewModel(factory=…)` (`fun <VM:ViewModel> viewModel`) —
  the Android module would NOT compile (latent in the #80/#81
  review-faithful work; Android is review-only here so it was never
  caught). Fixed: `RenameAppViewModel`/`ReplaceDeviceViewModel`/
  `WipeRestartViewModel` now `: ViewModel()` (commit `c06ca9f`),
  matching the already-correct `TrustedDevicesViewModel`. Other
  screens that construct plain VMs via `remember{VM()}`
  (ActivityScreen/ServerDetailScreen) are fine — that is the correct
  convention for a plain VM and is what #20's AppsListScreen uses.
  Next JDK-equipped session should still run a real Gradle build to
  shake out any further never-compiled Android drift.

- **2026-05-16 (resume, discovery sweep — step 4):** systematic
  TODO/FIXME/501/stub grep + spot-checked ✅-done claims
  (#4/#5/#6/#12/#14/#23) — all substantively real in code.
  Net-new findings:
  - **`packages/control-plane/src/inheritance.ts`**: a built module
    (`InheritanceStorage` + declaration handlers) with **no
    `apps/com` route wiring** and a deliberately-deferred
    `recordSigningActivity` cross-call (rePair/username-claim don't
    invoke it). Not in §S or this backlog → likely v2/future, but
    needs a one-line triage verdict (v1-unwired vs v2-deferred) →
    discovery task added.
  - **`scripts/check-push-secrets.mjs`**: covered by a vitest test
    but NOT wired into any CI workflow (manual/operator guard only).
    Minor — `marketplace-scan.yml` is the pattern to copy if the
    next session wants it auto-run; recorded, not built (no repo
    secrets in a CLI session to validate a live check).
  - 501s in `luksKeys.ts`/`screensHttp.ts` + `backupLoop.ts` TODO-v2
    + `serverMetrics` stubbed history + `stableIdReissuer.ts`
    "stubbed" are all intentional/documented or already-tracked
    (stableIdReissuer = the known Recovery J.4 v1 item) — NOT new.

## 1. Cold-start read order

1. **This file** (state + backlog).
2. `docs/plan-external-domains-and-demo.md` — the master tracker; every
   phase has a progress note with exact commit SHAs + what's done/open.
   Its **Track P** + `docs/maintainer-ca-endorsement.md` **§10–§12** are
   the maintainer→CA design (read §10/§11/§12 in order).
3. `docs/build-tasks.md §S` — the v1-alpha ☐→☑ checklist.
4. `docs/ca-operations.md` — CA/maintainer runbook (+ the 2026-05-16
   "SECURITY-MODEL CORRECTION" / "CEREMONY SURFACE UPDATE" /
   "OSS-GENERIC REFRAME" sections).
5. `CLAUDE.md` — repo orientation + ops commands.
6. If on the original Mac: the `~/.claude` memories add live context;
   on any other machine, this file + the docs above are sufficient.

## 2. Live production state (verify before relying)

- **Gate:** `npx tsc -b` clean · `npx vitest run` → **2526 passed / 225
  files** on `main` (resume #2: +7 #8 caTrustChain → 2521; then +5 from
  the user's own `5b7d140` `/alpha` route tests → 2526). One
  pre-existing intermittent flake under heavy parallel load
  (deterministically green on re-run) — see §0 #3 + watch procedure.
  Everything pushed to `origin/main` (direct-to-main is this repo's
  convention; pushes work without prompt).
- **`.com` Worker `flagship-com`:** last deploy version `70a43eea`
  (the #24 install-policy fan-out). D1 migrations applied through
  **`0025`** (`0025_install_policy_fanout`, applied remote 2026-05-16
  resume: `changed_db:true`, 16 tables; `install_policy_fanout`
  confirmed live; `/api/health` ok). Secrets verified live: all 4
  `APNS_*` + `WEBPUSH_*` + `SERVICES_CONTROL_SECRET` set (run
  `node scripts/check-push-secrets.mjs`). `SERVICES_BASE_URL=
  https://flagship-services.fly.dev:8443` (the `.services` API is on
  the **:8443** TLS-term port, NOT apex :443).
- **`.services` Fly app `flagship-services`:** deployed earlier this
  session-chain; the lazy-SNI resolver + commit changes since are
  build-to-seam (not wired into the raw-TCP hot path — task #22).
- **iOS app:** builds clean from HEAD (`cd apps/mobile/ios/App &&
  xcodegen generate && xcodebuild -project FlagshipApp.xcodeproj
  -scheme FlagshipApp -destination 'platform=iOS Simulator,id=<udid>'
  build`); 232 XCTests green. *(Verified on the original Mac;
  **not** re-verifiable on the current Linux box — no xcodebuild.
  See §0 ENVIRONMENT DELTA.)*
- **Android app:** `cd apps/mobile/android && ./gradlew
  :app:assembleDebug :app:testDebugUnitTest` — green on this Linux
  box (JDK17 + `ANDROID_HOME`); **190 unit tests, 0 fail** as of
  `d960691`. Android is the CLI-verifiable mobile target here.
- **Known benign:** `apps/mobile/ios/App/FlagshipApp.xcodeproj/
  project.pbxproj` shows perpetually-modified — it is a deterministic
  xcodegen artifact regenerated by `xcodegen generate` from
  `project.yml`. NOT a source change; intentionally never staged;
  regenerates identically on any machine. Do not commit it.

## 3. THE BACKLOG (rebuild your TaskList from this table)

Status key: ✅ done · ⛔ blocked-by-design/governed/real-infra (seam
built + documented; not effort-blocked) · ▶ buildable now.

| # | Item | Status | What's needed / where |
|---|---|---|---|
| 1 | Phase 6 webapp #80/#81 | ✅ | deployed+verified |
| 2 | Phase 6 Android #80/#81 | ✅ | review-faithful → now **compile+test-verified** on Linux (#33: assembleDebug + 190 unit tests green) |
| 3 | #85 demo LLM cap | ✅ | deployed |
| 4 | #83 demo provision/decommission CLI | ✅ | `scripts/demo-account.mjs` |
| 5 | C4.1c daemon ACME+sibling seam | ✅ | runtime wiring = #21 |
| 6 | replace-time DELETE(old fqdn) | ✅ | deployed |
| 7 | #79A C2.4 iOS Live setCustomDomain | ✅ | 232 XCTests green |
| 8 | maintainer→CA link-4 daemon | ✅ | **Built+tested** (`beb6279`): `caTrustChain.ts` `makeCaTrustChain` (adapts `@maintainers/protocol` `authorizedCaKeys`→#30 `CaTrustChain`; now-ms→Date) + `releaseVerifier.ts` `verifiedTrackFromFolder` disk bridge; 7 tests; gate 2521. Correctly inert (#30 fail-closed until genesis). |
| 9 | maintainer→CA link-4 webapp | ⛔ | **Scope corrected (§0): NOT a 1-liner.** Same shape as #8 in `apps/web`, but blocked on the genuine upstream gap (no on-disk CaEndorsement store convention — see §0) + needs a bundled maintainers verifier / browser `.maintainers` source. No #30 call site exists yet. Post upstream-store-convention. |
| 10 | maintainer→CA link-4 iOS/Android | ⛔ | **Scope corrected (§0): the heaviest, NOT a 1-liner.** Needs a Swift+Kotlin reimplementation of maintainers `verifyTrack`/`verifyCaEndorsements`/`authorizedCaKeys` (TS-only today) + the upstream CaEndorsement store convention + a call site. Explicitly do-not-bolt-at-session-tail (security-critical crypto). |
| 11 | **Track P 1-2: push `feat/ca-endorsement` + PR** | ✅* | **RECONSTRUCTED (drift §0) + pushed; PR #1 open** (`ibisllc/maintainers#1`, tip `5cace76`, 257 green). *Remaining = governed: on merge bump `scripts/maintainers.pinned-sha` to the merge SHA + run `pull-maintainers.sh` (do NOT pin to the unmerged branch tip). |
| 12 | lazy-SNI seam+endpoint | ✅ | deployed; socket wiring = #22 |
| 13 | C-iso verify+tick §S | ✅ | |
| 14 | B-scan auto-trigger | ✅ | deployed (`400186b0`) |
| 15 | B-e2e rig | ✅ | Rig was already built + green (B-tsc done, e2e `tsc` clean, **46 tests / 17 files** collect; last-run passed). The real gap = no CI ran it. Added `.github/workflows/e2e.yml` (chromium-only; README's wrangler-dev procedure; pull_request + dispatch). First green run is on a real GitHub runner (CLI can't run Actions — same seam as build-iso.yml). |
| 16 | B-A2 Replace-device "Take over now" UI | ⛔ | v1.1-deferred by the project's own code/copy; needs the live cross-device recovery exercise. VM complete; initiate leg wired |
| 17 | B-A3 webapp full Wipe ceremony | ⛔ | v1.1-deferred by CLAUDE.md/in-product copy; needs live cross-device WebAuthn-PRF exercise. Seam exists (keystore IDB + lib/recovery.js + WipeRestart envelope) |
| 18 | C-A1 live WebAuthn wrappers | ⛔ | needs a real authenticator/device; iOS ASAuth PRF stub, iOS18+ only — document the iOS17 fallback |
| 19 | Audit | ✅ | 17 findings → tasks #23–#26 + #14 rescope |
| 20 | Android apps-list /links fan-out | ✅ | `AppsListViewModel.kt` (Kotlin mirror of the iOS VM) + `AppsListScreen` rewired off `sampleApps()` via the `remember{VM}` convention (ActivityScreen pattern, NOT the broken `viewModel()` one); merge faithful to iOS AppsTab.AppRow; fixed 2 pre-existing dead nav routes now exercised (`apps/`→`app-detail/`, `vibe-code/describe`→`vibe/describe`). Review-only (no JDK). Spun off the ViewModel-base build-blocker fix |
| 21 | C4.1c runtime wiring + live exercise | ⛔ | real-infra (real CNAME→LE cert→green padlock→sibling failover). Steps in plan-doc Phase 4 note |
| 22 | lazy-SNI → routeToTunnel wiring | ⛔ | raw-TCP :443 hot path, no unit harness — focused pass; correctness core (push+cold-start) already shipped |
| 23 | verify push secret injection (audit N3) | ✅ | verified live; `scripts/check-push-secrets.mjs` guard |
| 24 | N0d-2 install-policy push fan-out | ✅ | `install_policy_fanout` store (types/inMemory/d1/0025) + serverRegister best-effort at-most-once empty-payload "server-registered" fan-out + apps/com wiring; 8 tests. build-tasks:664 ☑. Deployed (mig 0025 + Worker) |
| 25 | N0e-2 daemon sibling-WS auto-dial | ✅* | `siblingHandshakeClient.ts`: `startPersistentSiblingHandshakeClient` + `SiblingHandshakeClientManager` (reconnect/backoff/jitter/`setPeers`) at parity with cert-sync `SiblingClientManager`; router setSibling/removeSibling symmetric with the inbound accept; 5 tests; exported. build-tasks:666 ☑. *Joint runtime `setPeers`-from-discovery instantiation = live exercise (→ #16; neither persistent supervisor is runtime-instantiated by precedent) |
| 26 | verify Forgejo + real-LLM streaming (audit N1/N2) | ⛔(mostly) | largely real-infra: real provider key + live daemon; add Forgejo+vibe-code e2e smoke |
| 27 | Track P 3 genesis ceremony (app-primary + CLI fallback) | ⛔ | Upstream `ibisllc/maintainers` CLI, sequenced **post PR #1 merge** (§5); the real genesis run is human+YubiKey. Seam = the complete design in maintainer-ca §10.3/§11.2 + ca-operations "Operation 0" + the now-reconstructed PR #1 protocol; tests use the deterministic placeholder genesis (#30 already fail-closed-tested). Don't pile more unmerged upstream behind the governed PR. |
| 28 | Track P 4 PIV-Ed25519 signer (**Phase 1**) | ◐ | **Keystone + signer-threading + `ca-endorsement` DONE+green+pushed** (2026-05-17): `protocol` `Ed25519Signer` (`f646f99`) + `cli` `loadSigner`/`PivTransport` (`9e7c495`) + threaded through genesis/mandate/takeover (`d2027df`) + release endorsement (`5148bbf`) + the missing `ca-endorsement` command & `.maintainers/ca-endorsements/` store convention (`3a4bbe9`). ZERO wire/spec delta; maintainers 257→**277**; `feat/piv-ed25519-signer` tip `3a4bbe9`, **draft PR `ibisllc/maintainers#2`** (merge governed → re-pin). **Remaining (next session START, attentively — NOT tail):** `--dry-run` (needs the unsigned/sign split for byte-fidelity) + ceremony banner/typed-confirm + never-log-secrets test + native PC/SC transport stub. Then 1B human gate. Design: maintainer-ca §10.1/§11.1 + program doc Phase 1 progress log. |
| 29 | Track P 5 OPTIONAL hosted committer | ✅* | IS the upstream `maintainers/.../server-adapters/cloudflare-worker` Model A worker (`worker.ts` POST /commit — holds only a GitHub PAT, no maintainer/CA key; `policy.ts` = verify→commit gate). M1 (`6beb3dd`, PR #1) made `policy.ts` CaEndorsement-aware incl. `checkCaEndorsementAuthority` (NOW-clock + lease window). §12.1 downscopes to opt-in (default = app-direct-commit #32); NOT a launch blocker. *Remaining = governed/operator: deploy Worker + provision `GITHUB_MAINTAINERS_PAT` (post PR #1 merge). A flagship `.com` route would duplicate the upstream worker + contradict §12.1 — intentionally not built. |
| 30 | Track P 6 baked `MAINTAINER_GENESIS_PUBKEYS` + fail-closed link-1 | ✅ | `@flagship/protocol` `maintainerCa.ts`: empty baked const + `verifyCaSigned{DemoDirective,UserPubKeyBinding}` chokepoint, fail-closed `genesis-unconfigured` (chain port never consulted); injectable-genesis seam for #8/#9/#10; 9 tests. Flagship baseline now **2514** |
| 31 | Track P maintainers web-ui status/preview only | ⛔ | Upstream maintainers web-ui, **post PR #1 merge** (§5). NO signing view ever. Seam = ca-operations.md "Next upstream increment" (REPLACED by status/preview/commit-trigger-only per §10.1) — design complete; it's upstream-after-merge, not flagship code. |
| 32 | **Track P generic OSS maintainers NFC-tap app** | ⛔ | Largest: a NEW Android-first app, home **upstream `ibisllc/maintainers`**, review-only here (no JDK; cf. #33). Multi-week; **post PR #1 merge**. Seam = the complete §11+§12 design (per-repo profile, hardware-stored git cred, tap→PIV-Ed25519→app-direct-commit; PIV-Ed25519 == std Ed25519 ⇒ no protocol change). Not closeable at a CLI session tail. |
| 33 | Android real Gradle build (never-compiled drift) | ✅ | **DONE on this Linux box** (JDK17+SDK present — env delta §0). `7c37d5e` main-source `@Composable` fix → `assembleDebug` green; `d960691` 4 never-run test fixes → `testDebugUnitTest` **190/190, 0 fail**. Remaining for C-Android = the operator Play-upload gate (`§S:624`: signing + internal track + 5 testers), NOT a code/CLI item. |
| 34 | Triage `inheritance.ts` (v1-unwired vs v2-deferred) | ✅ | **Verdict: v2-deferred, deliberate seam.** Built+exported+unit-tested, not route/cron-wired, absent from §S + CLAUDE.md. Recorded in new `docs/policy/inheritance.md` (the decision record the module docstring already pointed at — was dangling). No v1 action. §0. |
| 35 | **Transition maintainers consumption: clone-SHA pull → adopter-friendly (MUST)** | ⛔ trigger-gated | The `scripts/maintainers.pinned-sha` + `pull-maintainers.sh` clone-at-build model is a **pre-1.0 dogfooding bootstrap ONLY**, not a distribution mechanism — a bespoke clone script is the opposite of the maintainers objective ("usable by others' projects easily"). **MUST transition when the spec is deemed mature = flagship↔maintainers co-development ends (expected SOON: primitives all coded, only e2e testing remains):** (a) `npm publish @maintainers/protocol` (semver, `--provenance`, lockfile/`npm ci` pinnable); (b) versioned spec + **published conformance test vectors** as the primary portable artifact (de-risks #9/#10 + every non-TS adopter) — these vectors **MUST include the mandatory fail-closed negative cases** (absent genesis ⇒ reject; forked/unknown genesis ⇒ reject; endorsement gap / substituted intermediate ⇒ reject) so no port can pass conformance while silently weakening fail-closed; (c) flagship drops the pull-script and consumes the published package like any adopter (makes the dogfooding honest). Full rationale: `docs/maintainers-deployment.md` → "Adoption: the pull-script is a bootstrap, NOT the distribution" + "Threat model & applicability boundary" (maintainers propagates trust from a pinned root, never creates it; guarantee scales with the independent population that can detect divergence — for agreed-canonical-source projects). Do NOT let the pull-script ossify into the integration story. |

Maintainer→CA progress: **#11 push+PR ✅ → merge (governed) ✅ →
re-pin `10c65aa` ✅ → #8 link-4 daemon ✅ → #28 keystone + signer
threading + `ca-endorsement` command & `.maintainers/ca-endorsements/`
**write-side** store convention ✅** (2026-05-17 session 2;
`feat/piv-ed25519-signer`, draft PR #2). **Next:** #28 finish
(`--dry-run`/banner/native-transport, NEXT session START). The
remaining **read-side** gap is the **upstream CaEndorsement on-disk
store convention** consumed by verifiers — the CLI now writes
`.maintainers/ca-endorsements/<ts>-<id>.json` (and `rotate-ca.mjs`
reads it), but the maintainers *store reader* / spec §3.7 directory
convention + a bundled browser verifier are still Phase 2 work that
unblocks #9 (webapp) + #10 (iOS/Android Swift/Kotlin reimpl). Then the
human/hardware ceremony cluster: #28 finish + #27 genesis-flow + #32
app + #29 optional committer + #31 web-ui + #30 baked-genesis. Design fully specified in maintainer-ca-endorsement.md
§9–§12; protocol needs ZERO upstream change (PIV-Ed25519 == std
Ed25519 over the canonical bytes).

## 4. Working discipline (non-negotiable — this is how the tree stayed clean)

- One logical change per commit, each individually tested. `npx tsc -b
  && npx vitest run` must stay green (**2526 baseline**) before every
  commit. Commit with `git commit -F -` (heredoc — NEVER `-m` with
  backticks/`$()`). No `Co-Authored-By` trailer. Push each tested
  commit to `origin/main`.
- After any backend change: deploy + live-smoke. `.com`:
  `cd apps/com && npx wrangler d1 execute flagship-state --file=… 
  --remote --yes` (migrations) then `npx wrangler deploy`. `.services`:
  `$HOME/.fly/bin/flyctl deploy --remote-only --strategy=immediate
  --yes -a flagship-services`. `.services` HTTP is on `:8443`, not :443.
- Keep `docs/plan-external-domains-and-demo.md` per-phase notes,
  `docs/build-tasks.md §S`, and THIS file current as you close items.
- Real-infra/governed/live-exercise items: build to the seam + tests +
  document the live step; don't bolt unverifiable changes into proven
  hot paths (cert plane, raw-TCP :443) at session tail.
- iOS verifiable here via xcodebuild+XCTest; Android review-only (no
  JDK — `/usr/bin/java` is the macOS stub); webapp = `node --check` +
  vitest served-asset tests.

## 5. Recommended next-session order (highest value, unblocked first)

> **2026-05-17: `docs/v1-launch-program.md` governs phase order** (the
> `/alpha` Phases 1-8). We are in **Phase 1** (genesis ceremony / #28).
> **Session 2 landed (green+pushed, draft PR #2 tip `3a4bbe9`, 277):**
> signer threaded through genesis/mandate/takeover/endorsement (one
> async path) + the missing `ca-endorsement` command + the
> `.maintainers/ca-endorsements/` store convention; flagship-side
> `rotate-ca.mjs`/`ca-operations.md` now point at `yubikey-piv:`.
> **Immediate next action (next session START — attentively,
> security-critical, do NOT tail-bolt):** on `feat/piv-ed25519-signer`,
> (1) refactor each `build*` to compute the *unsigned* envelope + target
> path then sign, and add `--dry-run` (print exact canonical bytes +
> the would-write `.maintainers` diff; sign/write nothing; no-PIN
> public read only); (2) plain-language ceremony banner + typed
> explicit confirm + never-log-secrets regression test + successor
> guidance; (3) native PC/SC `PivTransport` stub (pure tested APDU
> encoders behind a channel seam; libpcsclite round-trip fail-closes —
> verified only at the gate). Each commit green, push, keep draft PR #2
> current; flip it out of draft only when #28 is fully complete. THEN
> the 1B human gate: merge PR #2 (governed) → re-pin → Operation 0
> genesis with the real YubiKey → bake `MAINTAINER_GENESIS_PUBKEYS`
> (#30 flips live) → re-run #8. The list below is later-phase detail
> (Phase 2 = #35 → #9 → #10).

**Resume #2 2026-05-16 (Linux box) closed #33 (real Gradle build +
190 unit tests green; 2 latent-drift fixes), #34 (triaged →
v2-deferred), #3 (flake triaged + corroborated), #4 (GOVERNED PR #1
merged by the maintainer + re-pinned `10c65aa`), and #8 (link-4
daemon port built+tested). Prior resume: #11/#30/#24/#25/#20/#15/#29.
Net: flagship 2526/2526 (incl. the user's own `/alpha` commit),
Android 190/190, all pushed.** Next
session, in order:

1. **Define the upstream on-disk CaEndorsement store convention.**
   This is the real gap surfaced this resume (§0): the maintainers
   store reader knows only `endorsements/` = `ReleaseEndorsement`;
   there is no directory/spec for CaEndorsements. It is upstream
   `ibisllc/maintainers` work (spec §3.7 + `cli/src/lib/store.ts` +
   the protocol's `verifyCaEndorsements`). It unblocks #9 + #10 and
   makes #8's injected-arg seam loadable from disk. Sequence it with
   #31 (upstream web-ui) post-merge.
2. **#9 (webapp) → #10 (iOS/Android)** link-4 — only AFTER step 1.
   #9 = the #8 adapter shape in `apps/web` + a bundled browser
   verifier. #10 = a Swift+Kotlin reimplementation of the TS-only
   maintainers verify (`verifyTrack`/`verifyCaEndorsements`/
   `authorizedCaKeys`) — the heaviest, security-critical; NOT a
   1-liner, do not bolt at a session tail. (#8 is the done reference
   implementation: `caTrustChain.ts`.)
3. **#27/#28/#31/#32** the maintainer→CA ceremony build — upstream
   `ibisllc/maintainers`. #28 is security-critical (rotate-ca) +
   needs a real YubiKey; #27 genesis run is human; #32 is a
   multi-week new app. Design 100% in maintainer-ca §9–§12 +
   ca-operations.md. #30 baked-genesis flips #8's port live.
4. ⛔ real-infra/live-device backlog (#16-row items: C4.1c live cert
   exercise, lazy-SNI socket wiring, B-A2/B-A3, C-A1, Forgejo/LLM,
   the joint sibling-supervisor runtime instantiation) — only when
   the device/infra is available; each documented to the seam. Note:
   on a Linux box iOS xcodebuild is unavailable (#7/#79A/iOS-port
   verification is review-only here); Android is now the
   CLI-verifiable mobile target.
5. If the flake (§0 #3) recurs: follow the §0 watch procedure
   (`--reporter=verbose`, then pin/raise that *specific* spec) —
   do NOT blanket-retry or guess-pin.
