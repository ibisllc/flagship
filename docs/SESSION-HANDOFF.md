# Session handoff — portable cold-start (works on ANY dev machine)

**Read this FIRST.** This file is the in-repo, machine-portable source of
truth. The richer agent-memory (`~/.claude/projects/.../memory/
project_resume_2026_05_16.md`) is local to one machine and the harness
TaskList does NOT persist across sessions — so the authoritative backlog
lives **here, in git**. Rebuild your task list from §3 below.

Last updated: 2026-05-16 (resume session: maintainer-CA reconstruction
+ push/PR; see §0 drift log).

## 0. Drift log (verify-before-trust findings, newest first)

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

- **Gate:** `npx tsc -b` clean · `npx vitest run` → **2514 passed / 224
  files** on `main` (was 2492/221; +9 #30 fail-closed link-1, +8 #24
  fan-out). One pre-existing intermittent flake observed under full
  parallel run (deterministically green on isolated re-run) — see §0
  / discovery task. Everything pushed to `origin/main` (direct-to-main
  is this repo's convention; pushes work without prompt).
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
  build`); 232 XCTests green.
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
| 2 | Phase 6 Android #80/#81 | ✅ | review-faithful |
| 3 | #85 demo LLM cap | ✅ | deployed |
| 4 | #83 demo provision/decommission CLI | ✅ | `scripts/demo-account.mjs` |
| 5 | C4.1c daemon ACME+sibling seam | ✅ | runtime wiring = #21 |
| 6 | replace-time DELETE(old fqdn) | ✅ | deployed |
| 7 | #79A C2.4 iOS Live setCustomDomain | ✅ | 232 XCTests green |
| 8 | maintainer→CA link-4 daemon | ⛔ | after #11 land + #30; then 1-liner via `authorizedCaKeys` |
| 9 | maintainer→CA link-4 webapp | ⛔ | after #11 land + #30 |
| 10 | maintainer→CA link-4 iOS/Android | ⛔ | after #11 land + #30 |
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
| 28 | Track P 4 PIV-Ed25519 signer | ⛔ | **Security-critical key ceremony** (touches `scripts/rotate-ca.mjs` + the upstream maintainers CLI signer source) — explicitly do-not-bolt-at-session-tail; needs a real YubiKey to verify. Seam = the staged/hex-file source already in `rotate-ca.mjs`+CLI (ca-operations.md) + the full §10.1/§11.1/§28 design (PIV-Ed25519 == std Ed25519 over the canonical bytes ⇒ ZERO upstream spec change). Post PR #1 merge + hardware. |
| 29 | Track P 5 OPTIONAL hosted committer | ✅* | IS the upstream `maintainers/.../server-adapters/cloudflare-worker` Model A worker (`worker.ts` POST /commit — holds only a GitHub PAT, no maintainer/CA key; `policy.ts` = verify→commit gate). M1 (`6beb3dd`, PR #1) made `policy.ts` CaEndorsement-aware incl. `checkCaEndorsementAuthority` (NOW-clock + lease window). §12.1 downscopes to opt-in (default = app-direct-commit #32); NOT a launch blocker. *Remaining = governed/operator: deploy Worker + provision `GITHUB_MAINTAINERS_PAT` (post PR #1 merge). A flagship `.com` route would duplicate the upstream worker + contradict §12.1 — intentionally not built. |
| 30 | Track P 6 baked `MAINTAINER_GENESIS_PUBKEYS` + fail-closed link-1 | ✅ | `@flagship/protocol` `maintainerCa.ts`: empty baked const + `verifyCaSigned{DemoDirective,UserPubKeyBinding}` chokepoint, fail-closed `genesis-unconfigured` (chain port never consulted); injectable-genesis seam for #8/#9/#10; 9 tests. Flagship baseline now **2514** |
| 31 | Track P maintainers web-ui status/preview only | ⛔ | Upstream maintainers web-ui, **post PR #1 merge** (§5). NO signing view ever. Seam = ca-operations.md "Next upstream increment" (REPLACED by status/preview/commit-trigger-only per §10.1) — design complete; it's upstream-after-merge, not flagship code. |
| 32 | **Track P generic OSS maintainers NFC-tap app** | ⛔ | Largest: a NEW Android-first app, home **upstream `ibisllc/maintainers`**, review-only here (no JDK; cf. #33). Multi-week; **post PR #1 merge**. Seam = the complete §11+§12 design (per-repo profile, hardware-stored git cred, tap→PIV-Ed25519→app-direct-commit; PIV-Ed25519 == std Ed25519 ⇒ no protocol change). Not closeable at a CLI session tail. |
| 33 | Android real Gradle build (never-compiled drift) | ⛔ | DISCOVERY (#20). Android has only ever been review-faithful (no JDK). Found+fixed 1 hard blocker (3 VMs ⊄ ViewModel, `c06ca9f`) + 2 dead nav routes. Needs `./gradlew assembleDebug` on a JDK box to surface any remaining latent Kotlin errors across #80/#81/#20 before the Play upload. Belongs with C-Android. |
| 34 | Triage `inheritance.ts` (v1-unwired vs v2-deferred) | ⛔ | DISCOVERY (sweep). Built control-plane module, no `apps/com` route + deferred `recordSigningActivity`; not in §S/backlog. One-line verdict needed: if v1 → wire routes; if v2 → mark it. §0. |

Maintainer→CA future-session order (mostly CLI/code-doable; only the PR
*merge* + the one real-YubiKey genesis need a human): **#11 push+PR →
(merge, governed) → re-pin → #28 signer + #27 genesis-flow + #32 app +
#29 optional committer + #31 web-ui + #30 baked-genesis → #8/#9/#10
link-4.** Design is fully specified in maintainer-ca-endorsement.md
§10–§12; protocol needs ZERO upstream change (PIV-Ed25519 == std
Ed25519 over the canonical bytes).

## 4. Working discipline (non-negotiable — this is how the tree stayed clean)

- One logical change per commit, each individually tested. `npx tsc -b
  && npx vitest run` must stay green (**2514 baseline**) before every
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

1. **#11** — push `feat/ca-endorsement` + open the PR (pre-authorized;
   1 action; unblocks the whole maintainer→CA chain on merge).
2. **#30** baked-genesis const + fail-closed link-1 (gates #8/#9/#10;
   pure code; testable with the placeholder genesis).
3. **#24** install-policy push fan-out (audit BLOCKER; backend; testable).
4. **#25** daemon sibling auto-dial (audit; daemon-runtime; careful).
5. **#20** Android /links fan-out (review-only; completes #81 e2e).
6. **#15** B-e2e rig (largest; high confidence-to-ship value).
7. **#27/#28/#32/#29/#31** the maintainer→CA build (post #11 merge),
   then **#8/#9/#10** link-4 (mechanical once #30 + re-pin land).
8. ⛔ items only when their gate clears (governed merge / live device /
   real-infra exercise) — each is documented to the seam.
