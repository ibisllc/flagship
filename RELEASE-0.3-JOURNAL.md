# Flagship 0.3 mega release: release-manager journal

**If you are a new session taking over: read this whole file, then continue the "Plan" from the first
unchecked item.** Update this file as you go: tick items, add a dated line to the "Log", and commit it
(explicit path, `git add RELEASE-0.3-JOURNAL.md`) on `integrate/0.3-arch`, pushing each time. When the
release lands on `main`, fold what is still true into `AGENTS.md` "Current status" and delete this file.

Owner: Harry (they/them in writing). Budget is limited: don't regenerate things that exist, don't
re-run long suites without a reason, ask before buying or publishing anything.

## What the release is

One linear history: `main` → the isolated 0.3 security commit `cc5425c8a` → UX's 139 commits (first
contact on web/Android/iOS) → the Architecture work (138 commits replayed, then the "Integrate" commit
`ced988cfe`) → follow-up commits listed in the Log. It ships everything: 0.3 hardening, UX, arch-v2
(Rust keyd/broker/core, Podman), milestones 7 (WASI, app groups, per-app databases, GPU G01–G05,
AI01/AI02 local AI) and 8 (V01 adversarial suite + assessment package, V02 canary).

## Where things are

- Worktree: `/Users/harrywinner/flagship-0.3`, branch **`integrate/0.3-arch`** (pushed to origin). All
  release work happens here. The main checkout `/Users/harrywinner/flagship` is on `feat/multilingual`;
  don't build there.
- `release/0.3` is still at `cc5425c8a`; it gets fast-forwarded to the final tip (Plan step 9).
- `integrate/0.3` (`db830ba70`) = 0.3 + UX only, kept for reference.
- Backups of every pre-integration tip: `backup/feat-architecture-pre-integration-2026-10-24`
  (`44910d943`), `backup/feat-UX-pre-integration-2026-10-24`, `backup/ux-fc-*`, `backup/gym-ux-*`,
  `backup/ux-{marketplace,custom-names,custom-domains,outbound-proxy}-2026-10-24`,
  `backup/ux-fc-ios-wip-2026-10-24`, `backup/ux-rb-wt-wip-2026-10-24`. Never delete them.
- Arch handover detail: `docs/architecture-v2/HANDOVER.md`, `docs/architecture-v2/IMPLEMENTATION-PLAN.md`.
  Security plan: `SECURITY-HARDENING-PLAN.md`, progress `SECURITY-0.3-PROGRESS.md`.
- Scratch logs (may vanish on reboot): `/private/tmp/claude-501/-Users-harrywinner-flagship/bf7d42bb-5736-4a9a-83e8-bcfb63f1f061/scratchpad/`.
  Full-VM results persist in `gym-results/full-test-*`.

## Owner decisions (binding)

1. Ship everything now; build all code and test it in gyms. Tests needing unpurchased hardware
   (AMD/Intel/MIG/multi-GPU) may come after the release.
2. New-box stack: the **release gym decides** (`release/box-release.json` `newBoxStack`, set with
   `node scripts/set-new-box-stack.mjs arch-v2|classic`). Every 0.3 security finding must hold on the
   Rust stack too.
3. History linear on `cc5425c8a`; no merge commits of the feature lines; old tips stay as `backup/*`.
4. Name-dibs window opens on release day (`release.sh` asks, sets `DIBS_WINDOW_START/END`, 6 months).
5. Policed app browser ships ON only if the gym's browser group is green
   (`node scripts/set-app-browser.mjs true|false`). Redirects leaving the manifest list are allowed when
   the start URL was approved; local/metadata/Flagship-control destinations always refused; other
   people's public Flagship apps reachable like any public site.
6. Older, still in force: chat to `app.user` (no `.com` lead lookup); per-server `*.<user>` cert grant;
   first contact = pin on first sight + enrollment secret + 6-digit code; `slug--author` labels; the
   webapp is co-equal; passkey recovery check; passphrase min 8 with "Longer is stronger…"; N11 origin
   generations; TOTP never replaces a passphrase.

## Rules

- Commits: imperative subject, body says why, end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and the session line. No Codex trailer.
- Stage explicit paths. Subagents share the worktree and never run git; I stage their work.
- Every user-facing string goes through i18n: webapp `node scripts/i18n-pwa.mjs extract|build`;
  Android add to `i18n/android/en.json` then `node scripts/i18n-android.mjs build` (never edit
  strings.xml); iOS `String(localized:)` + harvest; box pages `scripts/i18n-box.mjs`. Gate: `npm run i18n`.
- AI never learns who/where the owner is (`buildModelRedactor`). Never tear down `playstore-test-0725`.
  Never bulk-wipe accounts. Only `main` is deployed. Owner-only secrets/keys/YubiKey steps: ask, don't do.
- Webapp shell is **v178** (minimumSecurity 176); bump on any webapp change and move test pins.
- D1 migrations on this line: 0110–0119 (0114–0118 = arch's renumbered, 0119 update receipts).

## Commands

- Typecheck/tests: `npx tsc -b`, `npx vitest run`, `npm run i18n`, `npm run parity`, `npm run ready`.
- Full suite on a throwaway UpCloud VM (~1 h, deletes itself):
  `bash scripts/full-test-vm.sh --commit <sha>` (token `~/.config/flagship/upcloud-token`; logs in
  `gym-results/full-test-<stamp>/`). crypto-graph fails by design (known Q05/Q08/Q09 classical bypasses).
- CI: only runs on `main`/`release/**`; dispatch on this branch:
  `gh workflow run ci.yml --ref integrate/0.3-arch` and `rust.yml`.
- Release gym (two passes, arch-v2 then classic): `bash scripts/gym-release-run.sh`. Exit 0 green,
  3 skips, 4 lock held, 5 arch-v2 failed but classic green (→ set classic), 6 only browser-grants failed
  (→ app browser off).
- Release: `bash scripts/release.sh --list`, then `--phase A`, `--phase B` (36 steps, prompts before each
  outward step).
- Android Gradle needs `JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`.
  iOS: project `apps/mobile/ios/App/FlagshipApp.xcodeproj`, scheme `FlagshipApp`, Xcode RC at
  `/Applications/Xcode-27.1.0-Release.Candidate.app`. Disk is tight: clear DerivedData first.

## State at 2026-10-25 ~02:15 UTC

Tip `28b213c73`. Last full VM run (on `a44fc2208`): vitest 14,337 passed / 2 failed, both fixed in
`135829c9d`; Rust fmt/clippy/test failures fixed in `90edead1e`. Not yet re-run on the tip.

Running when this was written (subagents; if this session is gone, they are gone too):
- (done, see Log) **AI01/AI02 local AI** (`packages/protocol/src/localAi.ts`, `packages/server-daemon/src/localAi/`,
  protocol manifest edits, webapp/Android/iOS Local AI screens and model menu changes). Its edits are
  **uncommitted in the worktree** (`git status`). If it died: review the diff, finish it (tests, i18n,
  privd allowances for any new host op), commit.
- **iOS Local AI screens** (same feature, iOS files listed in `git status`).
- CI runs 40150736028 (ci.yml) and 40150738064 (rust.yml) on `90edead1e`; expected to show only the
  two failures `135829c9d` fixed.

## Plan (tick as done)

1. [x] Land AI01/AI02 (`2045eef9b`; parity fixed `059251d5d`): review the uncommitted diff, `npx tsc -b`, targeted vitest, `npm run i18n`,
       Android unit tests, iOS build; commit by explicit paths; push.
2. [x] (VM run on `2045eef9b` green but crypto-graph; CI 40153988658 green; Rust 40156714426 green) Re-run `full-test-vm.sh` on the new tip and CI (`ci.yml`, `rust.yml`); fix everything but
       crypto-graph.
3. [x] (`5e6a71249`) iOS string harvest (Xcode build with `SWIFT_EMIT_LOC_STRINGS=YES`, then `scripts/i18n-ios.mjs`),
       then `npm run i18n`.
4. [ ] Native mock gyms on the tip: iOS UI tests (GymRelease03Tests and the rest), Android emulator gym.
5. [ ] Update `AGENTS.md` "Current status" and `SECURITY-0.3-PROGRESS.md` for the merged release.
6. [ ] Live release gym `bash scripts/gym-release-run.sh` (needs `scripts/gym-refresh.sh` first, the
       gym branch rebased onto this tip, box artifact built by `box-artifact.yml`); act on its exit code
       (set `newBoxStack` / `appBrowser`, commit the regenerated files).
7. [ ] M7 VM drills (WASI, app groups, dedicated DBs, GPU sim) and arch drills per `HANDOVER.md`.
8. [ ] Close the smaller gaps or record them as known in AGENTS.md: gpud share state lost on restart;
       gpud trusts the daemon's approval until R02; no owner UI for accelerators; WASI journal logs not
       through privd; journalHttp still accepts the IRK; Swift/Kotlin ExportAuthorization scope; a
       classic box can't later migrate to arch-v2; peer backups skip dedicated databases.
9. [ ] Fast-forward `release/0.3` to the tip; push. Then rebase every descendant branch onto it and
       report conflicts: `feat/marketplace` → `feat/custom-names`, `feat/custom-domains`,
       `feat/outbound-proxy` (start from the `ux-*` children), `gym`/`gym-ux`, `feat/retail`,
       `feat/browser-extension`, `feat/phone-usb-burn`, `feat/other-os-installers`,
       `feat/data-sovereignty`, `alpine`, `feat/multilingual` (already contained? check). Use
       `scripts/rebase-features.sh`.
10. [ ] Owner steps (ask Harry): PQ key ceremony (release step 2c) and catalog keys (2b); YubiKey
        endorsement of the box release; secrets `FLAGSHIP_RECOVERY_PROOF_SECRET`, `FLAGSHIP_TOTP_KEK`,
        `ADAPTER_ATTESTATION_SIGNING_KEY`, `ADAPTER_COMPLAINT_SALT`, `ADAPTER_REVIEW_ANTHROPIC_KEY`;
        `GYM_SYNC_REPO`; PSL request; `FLAGSHIP_UPDATE_RECEIPTS` on maintainer/gym boxes + a rollback
        drill; the older AGENTS.md owner items (wildcard DNS step, D1 backup bucket/secrets).
11. [ ] Merge to `main` (fast-forward of `release/0.3`), then `bash scripts/release.sh --phase A`,
        `--phase B`: D1 migrations, `.com` (`cd apps/com && npm run deploy`), `.services` (rolling),
        shim, endorsed box release, VM appliances, Studios, store builds (iOS/Android, with real
        screenshots: old ones are in `~/Desktop/flagship-builds/appstore-screenshots/` and
        `~/Desktop/flagship-play-store-assets/`), canary (step 23).
12. [ ] After launch: hall-of-fame publish (branch `hof-jay`), translation review, hardware receipts.

## Log

- 2026-10-24: owner made this session release manager; decisions above. UX rebased onto 0.3 (139),
  web/Android/iOS first contact finished; architecture replayed (138) and integrated (`ced988cfe`).
- 2026-10-24: `ae9448cec` stack switch; `8007d3f8f` full-test-vm.sh + first-run fixes; `d7051eec9`
  client screens; `b7a0fa733` Rust broker (668 conformance cases); `65ac6af3f` M8; `f852205b3` recovery
  page i18n; `2cbd89d6c` M7; `a44fc2208` all 24 adversarial findings fixed.
- 2026-10-25: `90edead1e` Rust test fixes; `135829c9d` integration cleanup (app-browser reach/gate,
  durable grants, shell v178); `28b213c73` Chromium only when the release turns the browser on.
- 2026-10-25: generated store art into `store/out/` (uncommitted, stand-ins; owner didn't need it).
  Journal started.
- 2026-10-25: CI on `90edead1e` (runs 40150736028/40150738064) found, beyond what `135829c9d` fixed:
  the Go TLS frontend built with Go 1.25 fails every handshake (needs 1.26's MessageSigner path;
  go.mod now `go 1.26.0`, so box-artifact.yml builds it right); keyd's peercred test needs root (own
  sudo step in rust.yml); two web gym specs (auto-unlock pins first; recovery link has `&lang=`).
  Fixed in `dd96a774e`. Re-dispatched CI 40153988658 and Rust 40153990297 on it.
- 2026-10-25: AI01/AI02 committed `2045eef9b` (tool broker, redaction coverage, local inference +
  fine-tune, clients; shell **v179**; gym `local-ai-cpu` 13/13 on a throwaway VM; box group `local-ai`
  not run). Known from its report: Android `GymBuildTest.ideConnectionCopyAndRegenerate` clipboard
  timeout (pre-existing); `tools/unseal-crosscheck` vitest needs rustc on PATH; companion sessions may
  read `/api/screens/local-ai` (left as is: owner-side read). Parity green `059251d5d`.
  Started: full VM run on `2045eef9b` (log `scratchpad/full-test-3.log`), iOS build with
  SWIFT_EMIT_LOC_STRINGS into `scratchpad/ios-dd` for the harvest (4 BrowserGrantCenter strings
  pending). Disk had 5.8 GB free.
- 2026-10-25: full VM on `2045eef9b`: vitest 14,439/0 failed, all Rust/Go/tsc OK; crypto-graph fails
  by design (16/16 strict targets reachable via classical keys until the PQ ceremony). CI green.
  Rust CI needed: gVisor registered on the runner (pinned tarball + SHA-512 from appSandbox/gvisor.ts),
  `--no-fail-fast`, and the peercred child run from a copy in /tmp (`hostile.rs`); green on run
  40156714426. iOS harvest + 3 browser-grant translations `5e6a71249`. iOS mock gym running
  (`scratchpad/gym-ios.log`); Android mock gym next.
- 2026-10-25: iOS mock gym on `78fa00740`: 270/276 passed. Failing: GymSweepServerTests
  test_frontPageSavesAnAdminSignedOrder, GymSweepSettingsTests test_appearanceAndAppIconChoices,
  GymSweepShareTests test_ownerCreatesALinkAndCancelsIt + test_sheetRouteCreatesALink,
  GymRelease03Tests test_updatePromptOnceThenSettingsRow + test_updateKeptInRecoveryAndShareSwitch.
  A helper agent is fixing them (uncommitted until it reports). Android mock gym after it.
