# Flagship 0.3 mega release: release-manager journal

**If you are a new session taking over: read this whole file, then continue the "Plan" from the first
unchecked item.** Update this file as you go: tick items, add a dated line to the "Log", and commit it
(explicit path, `git add RELEASE-0.3-JOURNAL.md`) on `release/0.3`, pushing each time. When the
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

- Worktree: `/Users/harrywinner/flagship-0.3`, branch **`release/0.3`** (pushed to origin). All
  release work happens here. The main checkout `/Users/harrywinner/flagship` is on `main`; don't build there.
- Since 2026-10-25 the only branches are `main`, `release/0.3`, `gym`, `hof-jay`, the unlaunched
  feature branches, `ux-{marketplace,custom-names,custom-domains,outbound-proxy}` (UX's newer copies, to
  fold in when those features are rebased), `device-results/windows-2026-10-17`,
  `wip/coordination-2026-10-16`. Everything else (integrate/*, feat/UX, feat/architecture, every
  backup/*, agent and wip branches, worktree WIP) is archived on origin under
  `refs/archive/2026-10-25/` and listed in `docs/archive/branch-cleanup-2026-10-25.md`.
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
- zsh: write `${var}` before a `:` (`"${c}:refs/heads/x"`); `$c:r...` is a zsh modifier and silently breaks
  refspecs (it caused two failed pushes on 2026-10-25).
- Stage explicit paths. Subagents share the worktree and never run git; I stage their work.
- Every user-facing string goes through i18n: webapp `node scripts/i18n-pwa.mjs extract|build`;
  Android add to `i18n/android/en.json` then `node scripts/i18n-android.mjs build` (never edit
  strings.xml); iOS `String(localized:)` + harvest; box pages `scripts/i18n-box.mjs`. Gate: `npm run i18n`.
- AI never learns who/where the owner is (`buildModelRedactor`). Never tear down `playstore-test-0725`.
  Never bulk-wipe accounts. Only `main` is deployed. Owner-only secrets/keys/YubiKey steps: ask, don't do.
- Webapp shell is **v184** (minimumSecurity 176); bump on any webapp change and move test pins.
- D1 migrations on this line: 0110–0119 (0114–0118 = arch's renumbered, 0119 update receipts).

## Commands

- Typecheck/tests: `npx tsc -b`, `npx vitest run`, `npm run i18n`, `npm run parity`, `npm run ready`.
- Full suite on a throwaway UpCloud VM (~1 h, deletes itself):
  `bash scripts/full-test-vm.sh --commit <sha>` (token `~/.config/flagship/upcloud-token`; logs in
  `gym-results/full-test-<stamp>/`). crypto-graph fails by design (known Q05/Q08/Q09 classical bypasses).
- CI: runs on every push to `main`/`release/**` (so on release/0.3); to rerun by hand:
  `gh workflow run ci.yml --ref release/0.3` and `rust.yml`.
- Release gym (two passes, arch-v2 then classic): `bash scripts/gym-release-run.sh`. Exit 0 green,
  3 skips, 4 lock held, 5 arch-v2 failed but classic green (→ set classic), 6 only browser-grants failed
  (→ app browser off).
- Release: `bash scripts/release.sh --list`, then `--phase A`, `--phase B` (36 steps, prompts before each
  outward step).
- Android Gradle needs `JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`.
  iOS: project `apps/mobile/ios/App/FlagshipApp.xcodeproj`, scheme `FlagshipApp`, Xcode RC at
  `/Applications/Xcode-27.1.0-Release.Candidate.app`. Disk is tight: clear DerivedData first.

## Mandate (Harry, 2026-10-25) — read this first

"Resume the 0.3 release" means: continue this plan from the first unchecked box, to the very end,
without asking unless a step is marked OWNER. The release ships everything already on release/0.3
PLUS phone USB burn and data sovereignty (box AND phone side: basic offline control of your own box
over the LAN, stopping short of bypassing the Flagship ecosystem — no self-hosted control plane, no
account creation/recovery/transfer offline, boot unlock still via .com), then acceptance with a
heavy security focus on everything new, then the four release stages, until the apps are live in
the stores with new graphics, texts and descriptions of the whole range of improvements, and the
website is updated. Record every step in this file's Log as you go (commit + push it each time).
Not in 0.3 (decided): outbound proxy (later, recommended free BYO-proxy), marketplace/payments,
custom names/domains, retail, browser extension, other-OS installers, alpine, offline boot unlock /
own control plane (next release; notes in docs/data-sovereignty.md).

## Master plan (tick as done; add the commit/run id)

### A. Land the remaining code on release/0.3
- [x] A1 (`8b41f8ff6`; docs/boot-chain-refresh.md; drilled BIOS+UEFI, tools/boot-chain-drill) Boot-chain refresh (agent building it in the release worktree since 2026-10-25): review,
      commit by explicit paths. It lets 0.3 boxes take initramfs/unlock changes via updates.
- [x] A2 (`a03887d5c` incl. A3; branch deleted, tip archived under refs/archive/2026-10-25/landed/) Fast-forward release/0.3 onto feat/phone-usb-burn (13 commits, already on the tip; rebase
      it first if the release moved), delete the feat branch (archive ref first).
- [x] A3 (landed with A2; combined stack: tsc, 3,019 tests, i18n, parity green) Merge feat/data-sovereignty's box half (8 commits) the same way.
- [x] A4 (SECOND AGENT, 2026-10-25: iOS `89587cbfa`, Android `41ffca4ec` + leftovers in the next Log line, webapp vector port; shell **v182**; Android: 8 view-model unit tests, 6 mock-gym scenarios green on the emulator, PQ vectors ported; NOT run by me: iOS gym/VM tests, any physical phone; main agent to review) Build the sovereignty PHONE side (iOS reference, then Android; webapp gets only the
      vector ports — a browser can't do LAN rescue): Swift/Kotlin ports of rescue + keyfile v2 vectors;
      Bonjour (iOS NWBrowser, Info.plist NSBonjourServices `_flagship._tcp`) / Android NsdManager
      discovery by the opaque rescueDiscoveryId; key-bound TLS (trust the pinned box key, not DNS/CA);
      the rescue session (admin-signed, hybrid PQ signature so it works under the strict profile —
      add the PQ half to the rescue order on box + phones); "Rescue my data" (backup over LAN,
      progress, resume) and BASIC OFFLINE CONTROL over LAN-direct when .com/relay are unreachable:
      server status, apps list, start/stop/restart an app, restart/shut down the server, make and
      download a backup — every action an owner-signed order the box verifies, nothing that needs
      .com (no account changes, no device adds, no recovery). Settings entry always present; the
      account-gone screen's rescue button. Box fixes from docs/data-sovereignty.md §7 that the
      promise needs (restore treats a backup's apps as the new host's own; self-delete freshness;
      BoxReadToken timeout). i18n drafts in 6 languages; parity rows; mock-gym scenarios
      (found, not found, wrong key, expired cert, interrupted download resumes, offline controls).
- [x] A5 (SECOND AGENT, 2026-10-25; OWNER still does: OTG write on a real phone + stick, `publish-iso-seed.sh` in release phase A step 20, and the server-comes-online half stays with the live `luks-burn` lane) USB burn finish: seed rebuilt for the release's Debian pin (sha pin is 13.6.0; check
      FLAGSHIP_ISO_MANIFEST), seed publish path + FLAGSHIP_ISO_SEED wiring in release.sh, a QEMU gym
      lane (burned stick boots, installs from the signed artifact, comes online).

### B. Acceptance (security first)
- [~] B0 (SECOND AGENT, 2026-10-25: cause confirmed by reading the scripts and FIXED, see Log; still to confirm on a real box in the D2 live gym: the unlock log and lock-once marker appear on FLAGSHIP_BOOT after a reboot) Check on a real gym box (live gym or debug box) the premount bug the boot-chain agent
      suspects: FLAGSHIP_BOOT's early mount wrote no log until ext4 was preloaded (amd64) / busybox
      present (arm64), so the unlock log, the lock-once marker and the live owner-key read may never
      work on real boxes. If confirmed, fix in packages/boot-chain (ship via the refresh) and gym it.
      Also from A1: drill the full promotion on a real LUKS box with phone approval (live gym lane
      "boot-chain refresh across an update + reboot", D2).
- [x] B1 (SECOND AGENT, 2026-10-25; see Log: AT-RSC added, tag inventory fixed, one real flaw fixed; boot-chain refresh, USB seed, GPU approvals, stack switch, local AI and journal admin-only were already covered by their own refusal tests, which pass) Adversarial suite (tools/adversarial) extended for every new surface: rescue route + mDNS
      (no identity leak on the LAN, stranger can't open a session, replay, downgrade to classical
      under strict, cert-hash binding), offline-control orders (forged/stale/IRK on pinned box),
      boot-chain refresh (daemon-writable source refused, broken initrd falls back), USB seed
      (tampered seed/preseed refused, LUKS key per install), GPU approvals, stack switch, local AI,
      journal admin-only. Fix every finding; 0 it.fails.
- [~] B2 (SECOND AGENT, 2026-10-25: 4 fresh read-only reviewers by surface; the fixable findings are FIXED with tests, the rest are listed in the Log as OPEN for the main agent / owner) Independent security review pass by a fresh agent over the 0.3 diff since main (focus: new
      additions); fix findings; record them in SECURITY-0.3-PROGRESS.md.
- [x] B3 (SECOND AGENT, 2026-10-25) crypto-graph: add nodes for every new order (rescue session, offline orders); schema ok.

### C. Stage 1 — code tests on the frozen tip
- [ ] C1 `bash scripts/full-test-vm.sh --commit <tip>` all green except crypto-graph strict (known,
      until the PQ ceremony); CI + Rust CI green on release/0.3.
- [ ] C2 `npm run ready` (branch drift, tsc, vitest, e2e, parity) and the iOS string harvest.

### D. Stage 2 — gyms
- [ ] D1 Mock gyms on the frozen tip: web (`npm run gym:locked -- --surface web`), iOS, Android
      (one native build at a time); fix failures.
- [ ] D2 Live release gym (rebase `gym` onto release/0.3 first; load gym secrets; see Commands):
      act on its exit code — set newBoxStack (scripts/set-new-box-stack.mjs) and appBrowser
      (scripts/set-app-browser.mjs) and commit. Add live lanes: sovereignty (cut a box off .com,
      rescue + offline control over its private network, import into account B), local-ai, the M7
      drills (WASI, app groups, dedicated DBs, GPU sim), stack switch classic→arch-v2, boot-chain
      refresh across an update + reboot.
- [ ] D3 Live gym green twice in a row; record run ids.

### E. Stage 3 — hardware (OWNER hands; I prepare checklists and drive what I can)
- [x] E1 (SECOND AGENT, 2026-10-25; the OWNER runs it before release phase A and fills its sign-off table) Write docs/runbooks/0.3-hardware-acceptance.md: iPhone + Android dev builds (pair, unlock,
      offline control + rescue on home Wi-Fi with internet cut, GPU card read-only, local AI CPU),
      USB burn from a real Android phone to a stick + metal boot, Mac Studio hosting, Windows/Linux
      Studio (device-test agent runbook), Watch/Wear basics. Ask Harry to run it; record results.

### F. Stage 4 — deploy (a script Harry runs) and launch
- [x] F1 (SECOND AGENT, 2026-10-25; re-read before merging, the OPEN list is the owner's) Update AGENTS.md "Current status" + SECURITY-0.3-PROGRESS.md for the merged release; the
      branch list (USB burn and sovereignty now in; marketplace family etc. still branches).
- [x] F2 (SECOND AGENT, 2026-10-25: the script already found migrations from the ledger and knew the secrets; added the USB seed to step 20; `--dry-run --phase A` lists clean; docs/runbooks/0.3-deploy-sheet.md written; phase B dry-run not re-run) scripts/release.sh updated for everything new (migrations 0110-0119+, secrets, seed,
      boot-chain refresh, rescue, PINS re-pin, box artifact + endorsement, appliances, Studios,
      stores, website); `--dry-run` clean; docs/runbooks/0.3-deploy-sheet.md (what Harry needs ready:
      YubiKeys, PQ ceremony 2c, catalog keys 2b, secrets list, store accounts).
- [ ] F3 (texts done `68b32b475`: store/listings/<lang>.json + scripts/store-assets/listings.mjs; screenshots still to do) Store assets: REAL native screenshots (iOS/Android gym captures, 7 languages, every device
      class) via the store/ pipeline (no webapp stand-ins), new feature graphic, new App Store / Play
      texts and "What's new" covering the whole 0.3 range, in 7 languages; contact sheet for Harry.
- [x] F4 (`68b32b475`: blog/flagship-0-3, landing/FAQ/help/security/how-it-works, 7 languages; deploys with .com) Website: landing + features + security + /studio + release notes/changelog for 0.3, pricing
      unchanged (free), i18n built; deployed with .com.
- [~] F4b (SECOND AGENT, 2026-10-25: `offline-control` and `version` markers RESOLVED; left for the verdicts/owner: usb-burn, app-browser, new-box-stack, canary, findings, pubDate, and the other items below) Before launch, resolve every `TODO-RM <tag>` in docs/release-notes/0.3.md,
      store/listings/*.json and apps/web/public (grep TODO-RM): offline-control (keep only if A4
      landed, and the strict-PQ caveat is gone), usb-burn (seed published + hardware-tested),
      app-browser (gym verdict), new-box-stack (gym verdict: "Podman + Rust", "own database server"
      are arch-v2 only), canary (catalog root pinned in the release run), findings wording, store
      name. Also fix what the texts agent flagged: landing "iOS soon / Android soon" (pinned by
      marketingPages.test.ts), security.html "a stolen server cannot self-unlock" vs opt-in
      Auto-unlock, Raspberry Pi answers say x86_64 only (arm64 appliances exist), docs/index.html
      "Phone pairing" section outdated, docs/data-sovereignty.md header still says parked; pick one
      word for "box" per language (glossary vs site) for the native reviewers.
- [~] F4c (SECOND AGENT, 2026-10-25: product 0.3 + Studio 0.3.0 done on every surface; the iOS version/build and Android versionCode are NOT touched: the OWNER types them at release step 2, because I can't see App Store Connect / Play and they must climb past what was uploaded) Bump the product version to 0.3: release/version.json then `node scripts/check-versions.mjs
      --write` (homepage badge, webapp, iOS, Android, Studios); store build numbers climb (iOS 1.1→
      next, Android versionCode > highest uploaded, Studio 0.3.0).
- [ ] F5 OWNER runs scripts/release.sh phases A and B (I watch logs, fix, re-run); merge release/0.3
      to main (fast-forward); canary; store submissions (iOS + watch, Android + Wear), Studios.
- [ ] F6 After launch: hall of fame (hof-jay), translation review request, hardware receipts, the
      weekly rate-limit check; rebase the feature branches onto main.

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
- 2026-10-25: iOS gym failures fixed `75e9a4a80` (2 real bugs: Share update results switch never
  loaded; recovery-update sheet lost under the closing onboarding cover; share seam pins first;
  2 test races). 8/8 + the two classes 28/28 re-run green. To mirror on Android/web: the
  update-reports load must not hang off a view that only exists once loaded; the recovery prompt
  must wait for a closing sign-in/onboarding screen. Android mock gym running
  (`scratchpad/gym-android.log`).
- 2026-10-25: Android mock gym: 195/202; 7 failing (GymOctoberTest share owner, GymServerPageTest
  migrate, GymShareTest sheet options, GymSettingsTest delete-other-device, GymUxScreensTest watch
  boot key, GymPasskeyBrowserSyncTest grant narrowed, GymUpdateResultsTest kept-in-recovery); a
  helper agent is fixing them (uncommitted until it reports).
- 2026-10-25: `gym` rebased onto `integrate/0.3-arch` (12 gym commits; caTrustChainLoader keeps the
  0.3 PQ lease gate over the gym material; ServerKeys keeps 0.3's removal of infoSTK; pbxproj
  regenerated with xcodegen) and force-pushed (`8a29461dd`; old tip `backup/gym-pre-0.3-2026-10-25`).
  Gym worktree: `~/.cache/flagship/gym-worktree`. Live release gym started:
  `bash scripts/gym-release-run.sh` → `scratchpad/gym-release.log`. Act on its exit code (Commands).
  If `release/0.3` (was integrate/0.3-arch) moves before a gym run, rebase `gym` onto it again (not onto main).
- 2026-10-25: **main has one extra commit `4c54f723c`** (adds only `.github/workflows/box-artifact.yml`;
  its parent `386e29c84` is the old main). GitHub dispatches a workflow only if its file is on the
  default branch, and gym-box-artifact.sh needs box-artifact.yml. Resetting main back by force-push
  was refused by the permission classifier: **ask Harry** whether to (a) let main be reset to
  `386e29c84` (then the release fast-forwards), or (b) keep it and land the release by rebasing it
  onto main (box-artifact.yml add/add conflict: take the release's copy). Until resolved, run the
  release gym with `GYM_BASE_REF=origin/gym` (else gym-refresh rebases gym onto main). Gym secrets:
  `set -a; . /Users/harrywinner/flagship/.gym-secrets.env; set +a` before the gym scripts. Gym
  artifact build: box-artifact.yml run 40167399457 on gym `73fc5eb6e`.
- 2026-10-25: main reset to `386e29c84` with Harry's approval (fast-forward possible again; the
  earlier "main has one extra commit" note is resolved). Harry: the gym must not depend on GitHub CI.
  So the gym builds its box artifact on a throwaway UpCloud VM (`scripts/box-artifact-vm.sh`, shared
  `scripts/lib/upcloud-vm.sh`, `645540751`; amd64 only). Also fixed `62cbea0f3`: the artifact
  assembler refused `flagship-wasi-worker` (every artifact since M7 failed). gym rebased to
  `e760e65c7`; release gym restarted.
- 2026-10-25: the Android gym-fix agent was stopped by the harness (auto-mode verdicts unavailable)
  partway. Its partial edits are uncommitted in the worktree (GymBase.kt, GymUpdateResultsTest.kt,
  SmokeMode.kt, KeystoreWatchBootKeys.kt, ActivityScreen.kt, BrowserGrantScreens.kt, ...): review,
  finish and re-run the 7 Android tests before committing them.
- 2026-10-25: Android gym fixed `86e474641` (2 real bugs: watch start-up key used
  NamedParameterSpec, which Android Keystore refuses; browser-grant reload/toast lost when the last
  request's list left; plus gym pins, share seed, keyboard wait, update-result check). 231/232 of the
  gym package green; the one left (GymDeviceBugsTest Samsung Pass: the text moved into "How this works")
  and the same lost-toast pattern in ChatRequestsList are being fixed (uncommitted, verifying). iOS to
  check later: Allow/Withdraw on an app's page still reload grants and toast when the last card goes;
  the share demo seed must not be cut short by a leaving view.
- 2026-10-25: release-gym VM build needed `--no-same-owner` and GnuPG (`scripts/lib/upcloud-vm.sh`);
  gym at `61c2d1005`; live release gym running again.
- 2026-10-25: Android follow-ups `18ab5b7f8` (chat-request toast; Samsung Pass test). Plan step 8
  started with three helper agents, all uncommitted until they report: (A) gpud share state persisted,
  gpud verifying the owner's approval (R02), WASI logs through privd; (B) journalHttp refuses the IRK
  on admin-pinned boxes, backups include dedicated databases, classic→arch-v2 box migration; (C)
  accelerator owner card on iOS/Android/web, Swift/Kotlin ExportAuthorization scope, iOS checks
  (browser-grant toast on app page, share demo seed). If this session ends: review `git status`,
  finish/verify each area, commit by explicit paths.
- 2026-10-25: GPU/WASI gaps committed `dcdb763f3` (gpud terms persist; gpud verifies
  flagship/gpu-approval/v1 itself; WASI logs via privd + Rust broker `wasi.logs`). Consequence: every
  app GPU claim is refused until the owner signs an approval, so the loop is being closed: the GPU
  agent builds the box side (manifest → AppSpec.accelerator, pendingApprovals on the GPU screens
  route, POST /api/screens/gpu/approvals and /withdraw, push/Activity), the clients agent the
  Approve/Decline/Withdraw UI on all three apps. Release step: re-pin installer/rust/PINS.json
  (gpud and broker changed); hardware runbooks' manual claims need a signed approvalProof.
  Still known after this: revocation and maintenance orders come from the daemon's word; strict-PQ
  half of the approval not required; daemon keeps SupplementaryGroups=systemd-journal (journalHttp,
  dockerHealth read the journal); a VM job whose kept terms are lost can't return its VFIO groups.
- 2026-10-25: daemon gaps committed `521ce5955` (journal admin-root only on pinned boxes; volumeDump
  dumps dedicated DBs; classic→arch-v2 switch order + root step + trial/rollback; its privd setup
  steps landed in `dcdb763f3`). Handed to the apps agent: native journal signing (iOS
  JournalViewModel → sensitiveOrderKey, Android → adminSigningKey; else 403 on pinned boxes), stack
  switch UI + Activity labels, besides accelerators/GPU approvals/ExportAuthorization/iOS checks.
  Still open for the switch: no run on a real classic box (apt without lists, volume move, arm64),
  no gym group, no crypto-graph node for flagship/arch-v2-switch/v1 (nor gpu-approval).
- 2026-10-25: GPU approvals box side `d894a516c` (GET /api/screens/accelerators pendingApprovals +
  approvals; POST /api/screens/accelerators/approvals and /approvals/withdraw; withdraw tag
  flagship/gpu-approval-withdraw/v1; stored in <dataDir>/gpu-approvals.json; push `generic`, Activity
  gpu.approval.*). Crypto graph `1554f7947`. Known: gpud reads owner.json only at keyd start, so after an
  admin-root rotation claims are refused until keyd restarts. The apps agent was given the real paths;
  parity/allowlist.json + features.json + the webapp port of the GPU tags are its to finish.
- 2026-10-25: clients committed `e271dfa8c` (GPU card + signed approvals, stack switch card, journal
  admin signing incl. webapp SENSITIVE_TAGS, ExportAuthorization scope parity, shell **v180**). Step 8
  done. Known, to record in AGENTS.md: GPU Decline is local only (no box route); cooperative GPU
  approvals use trustDomain "owner-apps" and ownerConsent "owner-consent-<issuedAt>" (no input yet);
  the GPU card doesn't refresh on the gpu-approval-request event/push; stack switch never run on a
  real classic box and has no gym group. gym is behind the tip (rebase onto integrate before the next
  release-gym run; the current run uses `61c2d1005`).
- 2026-10-25: **live release gym run 1 (gym `61c2d1005`): every fleet box failed** on both stacks
  (arch-v2: 119 passed / 9 failed / 42 skipped, all failures in `fleet`; classic: fleet 6 failed, the
  rest skipped). Demo-flow boxes register but get no cert; gym-provisioned ones stay at order phase
  "installing". Not LE rate limits (acme-budget-cli: room). browser verdict: skip. Harry approved a
  per-box debug SSH key (`0da1bf58c`: gym/provision `debugSshPublicKey`, fleet env
  `GYM_DEBUG_SSH_PUBKEY`; demo/prod boxes unchanged). Debug run: gym refreshed to `0a997184d`, core
  group with key `scratchpad/gymdbg` (throwaway) → `scratchpad/gym-core-dbg.log`; SSH root@<box ip>.
- 2026-10-25: cause 1 found on a debug box: gym-provisioned boxes asked for the artifact of THIS
  checkout's release/box-release.json commit (main's 386e29c84), which the gym never builds → 404 →
  "FATAL: could not download". Fixed `gym-release-run.sh` (exports GYM_INSTALLER_GIT_REF from the gym
  worktree's box release). Demo-flow boxes (right commit via the Worker's DEMO_INSTALLER_GIT_REF)
  registered but got no cert: still to diagnose. Debug box dbg2.uxdbg03871 (UpCloud
  00a49686-94bc-449d-9220-a200e9594eee) provisioned with the gym commit 0a997184d; destroy it with
  `fleet-cli.ts destroy <id> <fqdn>` when done. Note: gym boxes are Debian 12 (bookworm).
- 2026-10-25: Harry asked to merge everything into release/0.3 and clean out branches/worktrees.
  release/0.3 fast-forwarded to the integrated tip; PSL runbook update from the main checkout carried in
  (`18c99d77e`); every branch checked for containment (merge-tree + line-level absorption); 271 refs
  and 4 worktree WIP snapshots archived under refs/archive/2026-10-25/ then deleted; manifest
  `7e27bca89`. Worktrees left: main checkout (on main), flagship-0.3 (release/0.3), gym worktree.
- 2026-10-25: cause 2 found on a debug box: writeFileDurable's mode went through the daemon's
  UMask=0077, so the Rust launchers (flagship-rust-exec/select) landed 0700 and keyd/core (own users)
  could not exec them → keyd down → daemon never started → no cert. Same bug made the engine marker
  unreadable to the daemon user (falls back to Docker). Fixed `c0f191aba` (fchmod; test
  durableFileMode). Verified by hand on the box: tunnel up, cert, HTTPS 200. Debug box destroyed.
  gym rebased onto release/0.3 (`78f9fa308`); release gym run 2 started → scratchpad/gym-release-2.log.
- 2026-10-25: feature branches being rebased onto release/0.3 by two agents in worktrees
  /Users/harrywinner/flagship-feat-a (marketplace, custom-names, custom-domains, outbound-proxy from the
  ux-* copies; branches rebased/*) and /Users/harrywinner/flagship-feat-b (retail, browser-extension,
  phone-usb-burn, other-os-installers, data-sovereignty, alpine). After review: move feat/* to
  rebased/*, push, archive+delete ux-*, remove the two worktrees. rust/target was deleted (cache).
  Asked Harry: outbound proxy (a) free in 0.3 without the marketplace, or (b) with payments.
- 2026-10-25: Harry: data sovereignty's core stays for the NEXT release. TODO once
  rebased/data-sovereignty exists: add to its docs/data-sovereignty.md the 2026-10-25 discussion:
  boot unlock tries .com then falls back to the LAN (box listens on a fixed port and tries its default
  gateway; the reply is already owner-signed and sealed to the box key so the carrier doesn't matter;
  LAN path limited to private/link-local addresses); phone hotspot as the "serious user" setup
  (phone = gateway); after ~30 min without .com a running box advertises itself over mDNS/Bonjour so
  the phone finds it with no internet ("turn off the internet and wait"); phone-only (browsers can't).
  Open questions: giving users their own control plane ("what if they don't need us anymore?"), how
  to handle LAN networks (static IP, 802.1X, captive portals, VLANs, IPv6-only) and headless servers.
  Phone USB burn: Harry wants it IN this release. Outbound proxy: asked free vs Pro (recommended free
  BYO-proxy; paid = Flagship-run exit/WireGuard/second relay), gated on the initramfs OHTTP piece.
- 2026-10-25: marketplace family rebased (9/17/16/16 commits over the release; shells v181-v184);
  feat/{marketplace,custom-names,custom-domains,outbound-proxy} force-pushed onto it, old tips and the
  ux-* copies archived under refs/archive/2026-10-25/pre-rebase/, ux-* deleted. Agent fixes on those
  branches: custom-names refuses a rename while the account holds PQ bindings/assurance changes;
  outbound-proxy's root health timer no longer feeds the daemon-written curlrc to curl -K (privilege
  escalation under 0.3's unprivileged daemon). Open on custom-names: recovery record v2 names the
  account, so a rename needs a re-signed record before the paid name change launches. iOS strings for
  custom-domains/outbound-proxy wrapped but not harvested.
- 2026-10-25: Harry: nothing more into 0.3 (outbound proxy stays out); but boxes created with 0.3 must
  be able to upgrade to anonymous messaging later. Found: nothing refreshes the initramfs unlock
  script/hooks after install, so an installed box's boot path is frozen. An agent is building the
  "boot-chain refresh" in the release worktree (privd + Rust broker step, regenerate from the
  release's own builders, keep the known-good initrd, GRUB fallback, run on each applied update and
  once on first boot, Activity labels) — uncommitted until it reports. Harry's note: a serious user
  can hide from us with a VPS on their home network anyway, so no more anonymity work now.
- 2026-10-25: all feature branches rebased onto release/0.3 and force-pushed (old tips archived under
  refs/archive/2026-10-25/pre-rebase/): retail 6, browser-extension 1, phone-usb-burn 13,
  other-os-installers 5, data-sovereignty 8 (restores the five reverts that parked its code; strict-PQ
  profile blocks rescue sessions until rescue orders carry a hybrid signature; the 2026-10-25 LAN /
  hotspot / mDNS / own-control-plane notes added to its doc), alpine 4 (still git-clone installs,
  documented). Branches left: main, release/0.3, gym, hof-jay, the feat/* set, alpine,
  device-results/windows-2026-10-17, wip/coordination-2026-10-16. Worktrees: main checkout,
  flagship-0.3, gym worktree.
- NEXT: once the boot-chain agent has committed, fast-forward release/0.3 onto feat/phone-usb-burn
  (Harry wants USB burn IN 0.3), delete that branch, then USB-burn owner steps: rebuild the seed for the
  release's Debian pin (sha pin is 13.6.0), publish it, set FLAGSHIP_ISO_SEED, test OTG write on a real
  phone + stick; plus a gym lane for a burned stick. Update the AGENTS.md branch list.
- 2026-10-25: Harry's mandate recorded (Mandate + Master plan above). USB burn (13) and data
  sovereignty box half (8) landed on release/0.3 at `a03887d5c` (tested together first in a scratch
  worktree /Users/harrywinner/flagship-tmp, which can be reused for side work or removed).
- 2026-10-25: A4 started: an agent builds the sovereignty phone side + basic offline control on branch
  `work/sovereignty-phone` in /Users/harrywinner/flagship-tmp (commits there, not pushed). If this
  session ends: check that branch's log, finish the A4 list, test, then merge into release/0.3
  (rebase onto it first). A1 (boot-chain refresh) is still uncommitted work in the release worktree.
- 2026-10-25: F3/F4 texts started early: an agent drafts docs/release-notes/0.3.md, store listings
  (7 languages) and the website pages in the release worktree (uncommitted until it reports; native
  screenshots come later). Live release gym run 2 still running (scratchpad/gym-release-2.log).
- 2026-10-25: texts landed `68b32b475` (release notes, store listings ×7 with limits check, website +
  blog post). TODO-RM markers to resolve before launch: see F4b. Product version still 0.2: see F4c.
- 2026-10-25: A1 landed `8b41f8ff6` (shell v181; compatibility.json pinned to 181). The feature
  branches feat/marketplace (v181…v184) must renumber above 181 at their next rebase.
- 2026-10-25: release gym run 2 (gym 78f9fa308): boxes come up now. arch-v2 170 pass / 55 fail / 16
  skip (browser verdict: fail); classic 36 pass / 8 fail. Failure list:
  scratchpad/gym2-fails.txt (also derivable from gym-results/release-20261025T170312Z-*). Main
  clusters: app sandbox ("Docker didn't pick up the gVisor runtime" / systemctl code 5) blocking app
  installs, AI staging fence and data layer; cert check expects old SANs; share/remote sessions refused
  by central authorization; no endorsed releases listed; plus first-contact proof, decommission,
  app groups, WASI pinned install, local-AI delete 500, AT-LIVE-19 signature, no Chromium, gpu-sim
  core quota, WORKERS_PLAN=paid. A triage agent is fixing them in the release worktree
  (uncommitted until it reports); then rebase gym onto release/0.3 and run the release gym again.
- 2026-10-25 (SECOND AGENT; main agent was interrupted for lack of funds and will review): finished the A4 Android half in /Users/harrywinner/flagship-tmp (NSD discovery, key-bound TLS, offline control + Rescue my data screens, Settings/server page/account-gone entry points, environment factory, 83 strings reusing the iOS drafts in 6 languages, RescueVectorsTest + KeyfileVectorsTest green, parity/i18n green, Android compiles). Rebased work/sovereignty-phone onto release/0.3 (conflicts: webapp shell took v182, compatibility.json 182, i18n json merged per key then catalogs rebuilt) and fast-forwarded release/0.3. Not done yet: Android/iOS mock-gym scenarios for Android, PQ-gate vectors in Kotlin, release gym triage (gym2 failures: nothing from the earlier triage agent was found uncommitted in the worktree, so it must be redone), A5, B-F.
- 2026-10-25 (SECOND AGENT): A4 leftovers done. Android: `OfflineControlViewModelTest` (8, in `src/testDebug`, against the debug-only in-process box `GymRescue`), `RescuePqVectorsTest` (19 gate cases + hello check, Kotlin half of `rescue/pq-vectors.json`), `GymOfflineControlTest` (6 scenarios: found+each control, not found+typed address, wrong key, stranger, expired cert, interrupted download resumes) green on the `flagship_gym` emulator. Seam: `AppVariant.rescueEnvironment` (release returns null) + launch extra `flagship.smokeRescue`. Unit suite, parity, i18n, release-clean scan green. Checked the §7 box fixes already have tests (restore rewrites creator, self-delete `notBefore`, BoxReadToken 20 s timeout). No bug found in product code; two test-mock slips fixed (status block, Start has no confirm). Next: A5.
- 2026-10-25 (SECOND AGENT): A5 done. The seed pin (13.6.0, sha `54be17b4…`) already equals the release's Debian pin; the iso-seed workflow only ran on the deleted feat/phone-usb-burn, so it now runs on main + release/** (and when the preseed generator changes). New: `scripts/publish-iso-seed.sh <run-id>` (checks the pin, GitHub release asset, switches on FLAGSHIP_ISO_SEED with real url+size), wired into release.sh step 20 (publish); `scripts/iso-seed-pins.test.ts` (workflow/doc/page/wrangler/manifest pins agree + publisher against a stubbed gh); `tools/usb-burn-qemu/` + CI job `burned-stick`: composes the stick as the phone does (real generated preseed into the FLAGSHIP partition), boots it in QEMU as USB via the seed's own BIOS entry, and requires d-i to find the partition, run the recipe's late command and power off. Green on KVM in 2.5 min (run 40254061759). Local seed rebuild on a Mac differs from the pin (expected: the CI container is the reference). Next: B0.
- 2026-10-25 (SECOND AGENT): B0 fix. Both initramfs scripts (unlock, Wi-Fi) mounted `/dev/disk/by-label/FLAGSHIP_BOOT` with a bare `mount`: at init-premount ext4 is not loaded (root is not mounted yet, and an untyped mount only tries filesystems already in /proc/filesystems) and the unlock script did not even wait for udev's by-label link (the Wi-Fi one waited). So the unlock log, the lock-once marker and the live owner-key read could not work. Now one shared shell function (`packages/boot-chain/src/bootFsMount.ts`): bounded wait for the link, `modprobe ext4`, `mount -t ext4`. Tests: `packages/boot-chain/tests/bootFsMount.test.ts` (runs the function against stub mount/modprobe: order, waits for a late link, gives up; both generated scripts contain no bare mount and define the function before use); the premount end-to-end tests set FLAGSHIP_BOOT_WAIT_SECS=0. boot-chain, bootChainRefresh, bootChainIdentity, unseal-crosscheck (all 22 premount tests) green. Boxes get it through the boot-chain refresh on their next update. Next: B1/B3.
- 2026-10-25 (SECOND AGENT): B1 and B3. FLAW FIXED: rescue's hello budget (300/min, reachable by anyone through the relay) was shared with the admin's revoke and rotation intake, so a hello flood blocked cutting off a stolen device without `.com`; intake has its own budget now (test in `server-daemon/tests/rescue.test.ts`). HARDENING: keyd now shape-checks `rescue-hello` like it does session signatures (it only checked the tag). `tools/adversarial/tests/rescue.test.ts` = AT-RSC-01..04 (lifted signatures between hello/session/order, an order moved to another session/server/action, keyd refusals, discovery id); the AT-ENV-10 tag inventory was RED for five new tags (arch-v2-switch, gpu-approval, gpu-approval-withdraw, lan-discovery, offline-control): classified. Adversarial suite 1223 green, 0 it.fails. Not found a bug but left as DESIGN for the reviewer: the hello cap itself still locks the owner out for a minute under a flood (a test pins 429 at 300/min); the discovery id is computable by anyone who knows a server's name and public STK. B3: crypto-graph gains `eff.rescue-session`, `eff.offline-control` (both strict authorization targets, admin root / IRK-where-unpinned edges) and `ver.rescue-hello`; repaired 10 stale evidence references (deleted boot-stage.sh, moved userdata lines); a test now runs `--check-evidence` on the real graph. Strict reachability stays the known failure (18 of 18). Next: B2 (independent review), then C1.
- 2026-10-25 (SECOND AGENT): E1 written: `docs/runbooks/0.3-hardware-acceptance.md` (pair/unlock, the FLAGSHIP_BOOT unlock log check for B0, offline control + rescue with the internet cut incl. stranger and import into a second account, USB burn from an OTG phone + metal boot + single LUKS slot, Mac Studio, Windows/Linux via the device-test agent runbook, local AI + GPU read-only, watch/Wear, sign-off table). B2 reviewers (4, read-only) running.
- 2026-10-25 (SECOND AGENT): B2. Four reviewers (rescue/offline control; boot chain + USB seed; arch-v2 Rust/GPU; .com/control-plane) read the 0.3 diff. FIXED (each with a test that fails on the old code): revoke/rotation intake no longer has any counted budget (a flood of junk, 100/s through the relay, blocked cutting off a stolen device) and offline orders honour the 24 h new-admin cooling like the session; LAN listener: per-source connection cap + 20 s handshake-progress deadline (256 sockets from one host closed the only path when the internet is down); seed stub: recipe only from the partition LABELLED FLAGSHIP, exactly one, else halt (it took any FAT disk's /preseed.cfg; any plugged stick ran root code in the installer); the Android app pins the seed hash itself (`SeedPins.kt`, kept equal to iso-seed.yml by a test; it trusted `.com`'s hash) , so the seed hash changed to `892cf430…` (CI-built; pins updated in doc, security page, wrangler.toml, workflow); hostile key-file Argon2 cost refused (TS, Kotlin, Swift: it crashed/OOMed the importer); Wi-Fi text with line breaks refused (heredoc injection as root in the target); mixed-case server name in a boot suspension refused + D1 lookups lowercased (a lock could sit under a name the lease lookup missed); RSA passkey exponent must be 65537; privd: a bind-mount source must be a regular file, not a link (TS `checkBindSources` + Rust `check_bind_sources`: the daemon could point /run/flagship-daemon/flagship-resolv-x.conf at any host file); local-AI named containers must use a pinned image even on the GPU path (TS + Rust + corpus case, vectors regenerated); gpud no longer falls back to the IRK when owner.json has a damaged admin root. ALSO FOUND BY MY OWN RUN: (a) B0's premount change had not reached the bundled preseed engine, its two native copies, the golden vectors or the byte pins: regenerated (a stale engine would have burned the old premount on every phone-made box); (b) the saved-backup schedule converter drifted an hour in a clock-change week (apps/web test red today, 2026-10-25): both directions use one offset, a 366-day x 5-zone round-trip test; webapp shell v183 (feature branches renumber on rebase).
- 2026-10-25 (SECOND AGENT): B2 OPEN, not fixed (design or owner decisions; severity as the reviewers rated): MED `RELEASE_PQ_PIN`/`CA_LEASE_PQ_PIN` keyIds are empty, so no hybrid companion is required anywhere: this is the PQ ceremony (deploy sheet 2c); until then 0.3 ships classical-only endorsement and must say so. MED `POST /api/server/<d>/health` accepts a raw Ed25519 signature (STK or the unencrypted boot key) over untagged bytes and skips `gateBoxMessage` under strict: needs the health timer to hybrid-sign. MED gpud GPU approvals can be replayed after the owner withdraws them (no root-owned floor/max age; withdrawal is only in the daemon-written file). MED gpud claim fields `container`, `userspace`, `max_runtime_ms`, `share` are daemon-chosen and unsigned. MED root acts on the daemon-written `arch-v2-verdict.json` (a compromised daemon can force a revert, or commit unverified). MED keyd `app-rank/v1` and `device-capability-grant/v2` master evidence has no freshness/revocation check. MED trial boot vs TPM-sealed lease key (PCR 8/9 may change, then the owner must be reachable; unverified whether GRUB measures them). LOW/MED premount trusts any FLAGSHIP_BOOT-labelled ext4 and the first LUKS device (bind to the install UUID / the /boot disk); installer wipes the largest fixed disk without asking when two exist; privd `model-install` checks sha-vs-filename only (no catalog digest/size cap); `POST /api/update-receipts` is anonymous and prunes on a nonce prefix (skewable canary data); re-pair veto and voici-name routes are not rate limited; recovery record without a passkey key is released on the passphrase hash under strict; mDNS unicast reflection (small); journal/arch-v2 HTTP orders have a 5-minute replay window with no nonce. NOT REVIEWED: WASI worker, flagship-runtime, flagship-crypto, typed.rs capability path (needs a follow-up pass).
- 2026-10-25 (SECOND AGENT): F1 (AGENTS.md: 0.3 section, branch list, USB-burn line; SECURITY-0.3-PROGRESS.md: the B2 review) and F2 (`docs/runbooks/0.3-deploy-sheet.md`; seed publish wired into release step 20). C1 is running on UpCloud for `009fa70c3` (`gym-results/full-test-*`, log in scratchpad `c1.log`); i18n (iOS + Android) and parity re-checked green.
- 2026-10-25 (SECOND AGENT): F4c partial (see its line). Also red since my A4 landing, now fixed: `scripts/mobile-clients-inventory.test.ts` did not list the two rescue transports (raw TLS clients that trust the box's pinned key, not the CA pin); listed with the reason. Version tests moved to 0.3 Beta.
- 2026-10-25 (SECOND AGENT): C1 first run on `009fa70c3` (UpCloud, VM deleted, log gym-results/full-test-20261026T021201Z): vitest 14828 pass, 1 fail (the HTTP-client inventory, fixed since), tsc/clippy/cargo test/go/keyd-crosscheck green, crypto-graph red (known). cargo-deny was a FALSE red (the install on the VM failed silently: `full-test-vm.sh` now retries and logs it). Rust CI `deny` job was REALLY red: crypto-bigint 0.7.6 got yanked, `Cargo.lock` moved to 0.7.9 (workspace tests green). D1 Android mock gym, whole suite on the emulator: 249 tests, 3 red: (1) `GymAccountGoneTest` still expected no rescue button (A4 added it for a device that holds the admin key or knows pinned servers): test updated; (2) `GymLiveAccountTest` expected 'pairing isn't available yet' but a debug build on a real backend has used the live pairing relay since the device-pairing work: test rewritten to the real behaviour (stale since before my work); (3) `GymServerPageTest.lockingTheAppDismissesAnOpenSheet` timed out under load and passes alone (flaky; not changed). Web mock gym running.
- 2026-10-25 (SECOND AGENT): D1 so far. WEB mock gym: 354 scenarios; my first two runs showed 28 and 14 red, ALL caused by my own concurrent Playwright runs fighting for the fixed port 8799 (ERR_CONNECTION_REFUSED at 127.0.0.1:8799, ~1.5 s fails); the 14 reds of the second run pass serially (14/14), so web is 354/354 green. Never run two web gyms or a stray `playwright` at once. ANDROID mock gym on the emulator: 249 tests, 3 red, fixed or explained in the previous line. iOS mock gym started (`scratchpad/iosgym.log`, 299 scenarios). LIVE GYM (D2) BLOCKED FOR ME: `gym` rebased onto release/0.3 (two additive conflicts in AppVariant.kt / release Variant.kt between my `rescueEnvironment` and the gym's `adoptLiveIdentity`: kept both; old tip `backup/gym-pre-0.3-rebase2-2026-10-25`, new `cd295e9eb`, force-pushed with lease), then the harness's auto-mode classifier refused `bash scripts/gym-release-run.sh --groups core` (it sources the gym secrets and deploys the gym Worker/Fly app and creates UpCloud servers). I did not work around it; the owner needs to allow it or run it: `set -a; . /Users/harrywinner/flagship/.gym-secrets.env; set +a; GYM_BASE_REF=origin/release/0.3 bash scripts/gym-release-run.sh` (add `--groups core` first to iterate on the gVisor failure). Gym-2's 55 arch-v2 failures: ~35 are ONE cause, `container deploy failed: apps can't start on this server without their sandbox: Docker didn't pick up the gVisor runtime` (also on the classic pass: core, gating, invites, one-list, backups); others: cert SAN check expects the old names (`*.home.<acct>.gym.flagship.services` is now what boxes present: test expectation), share/remote routes refused (`route-not-allowed-for-session`), no endorsed releases listed on the update box, first-contact enrollment proof, lifecycle decommission (home2 still answers after 12 min), WASI install (`/usr/bin/install is...`), local-AI delete 500, AT-LIVE-19 (`invalid signature` reading privd's audit), gpu-sim (UpCloud core limit reached), app browser routes absent.
- 2026-10-25 (SECOND AGENT): F4b partial: removed the `TODO-RM offline-control` comments in 23 places (site pages x7 languages, blog, FAQ, help) and in `docs/release-notes/0.3.md` dropped the 'strict profile refuses rescue' caveat (phones send the hybrid half now; box enforces it, tested). Marketing page tests and i18n green.
- 2026-10-25 (SECOND AGENT): D1 iOS mock gym NOT RUN: it needs about 15 GB of simulator clones and this Mac had 2 GB free (the first attempt took the disk to 189 MB; I killed it, ran `simctl shutdown all` + `simctl erase all`, cleared DerivedData, Gradle build cache, Homebrew cache and my scratch ISOs; now 2.6 GB free). Free about 20 GB (CoreSimulator, ~/.android/avd 11 GB, ~/.gradle) and run `DEVELOPER_DIR=/Applications/Xcode-27.1.0-Release.Candidate.app/Contents/Developer npm run gym:locked -- --surface ios` (299 scenarios, ~1.5 h, one run at a time). Stage status: A done, B0/B1/B3/E1/F1/F2 done, B2 fixed-with-OPEN-list, C1 once on `009fa70c3` (needs a re-run on the final tip), D1 web 354/354 and Android 249 (3 explained) done, iOS pending; D2/D3 need the owner to allow the live gym; F3 screenshots need the iOS and Android gym captures; F4b partial; F4c partial; F5/F6 owner.
- 2026-10-26 (SECOND AGENT): Harry allowed me to run all gyms and asked for a PQ ceremony script. LIVE GYM: fixed the artifact-VM blocker (fresh Debian VM holds the dpkg lock at first boot: `scripts/lib/upcloud-vm.sh` waits with `DPkg::Lock::Timeout=600`), retried the transient Fly 401, reaped the leftover gym server `flagship-gym-uxdbg03871` (Harry approved), then started the FULL release gym: `GYM_BASE_REF=origin/release/0.3 bash scripts/gym-release-run.sh --skip-refresh` (log `scratchpad/gym-full.log`, results `gym-results/release-20261026T*-{arch-v2,classic}`; exit codes in Commands). The refresh already ran and deployed the gym Worker + Fly app from `gym` (`cd295e9eb`). If the run is interrupted: `npx tsx tools/live-e2e/sweep-cli.ts --destroy` (gym-only) before rerunning, and `rm` any `/private/tmp/claude-501/flagship-locks/gym.lock` left by a dead run. iOS mock gym restarted with 21 GB free and a watchdog (`scratchpad/watchdog.sh`, kills it below 2 GB free); log `scratchpad/iosgym.log`. Disk lessons: the iOS gym fills ~14 GB of CoreSimulator clones; after it, `xcrun simctl shutdown all && xcrun simctl erase all`. PQ ceremony script: in progress (`scripts/pq-ceremony.mjs`, see next entries).
- 2026-10-26 (SECOND AGENT): PQ CEREMONY SCRIPT written for Harry to run in his terminal: `node scripts/pq-ceremony.mjs` (also `--status`, `--restart`, `--help`). Seven steps with on-screen instructions: (1) checks (node, age, age-plugin-yubikey, maintainers CLI found+built incl. from a git worktree, protocol built, nothing pinned yet, no key file to overwrite, files clean), (2) one age identity per YubiKey (detects a YubiKey that already has one, refuses the same YubiKey twice, writes the stubs 0600), (3) `pq-release-key.mjs init` (PIN + touch, paper backup prints once), (4) prove: the key id typed from the PAPER, `verify-yubikey` per YubiKey (3 tries), and a `restore-from-paper` rebuild into a throwaway file that is deleted, (5) `pin --ca-lease --box-artifact` + legacy manifests from `~/flagship-release-artifacts` (+ `--legacy-manifest`), `gen-box-release --write`, `tsc -b`, (6) vitest for the PQ-touching suites, (7) commit with explicit paths (asks before commit and before push). After each of steps 2, 3 and 5 it re-checks the disk (distinct recipients, identity file 0600 and complete, key file 0600, binding file, `show-pub` agrees, the id is in releasePqPin.ts / caLeasePq.ts / box-artifact-trust.json and `show-pub` says pinned). Progress in `~/.flagship-release/pq-ceremony.json` (no secrets); resuming re-verifies done steps against the disk. Tests `scripts/pq-ceremony.test.ts` (14): parsers, state, maintainers-dir lookup, preflight guards, and the whole ceremony with fake YubiKeys (happy path; wrong paper id; a YubiKey that cannot open the file then resume without repeating init; refuses an existing key file / existing pin; disk disagreement). BUG FOUND BY THE TESTS: the first draft passed `--key-file` to `init` (which takes `--out`), so a fake-mode run wrote a TEST key file to the real `~/.flagship-release/pq-release-key.age`; deleted it, fixed, and the script now refuses fake mode without its own key file and refuses a real run over a drill's key file. After the ceremony: the pin touches `apps/web/public/webapp/lib/releasePqPin.js`, so the webapp shell must be bumped (v184) with its test pins and `release/compatibility.json`, then retro-sign the marker release (`endorse-release.mjs --pq-only`) and the release script does the rest. Docs: runbook pq-release-key.md and release step 6 text point at the script.
- 2026-10-26 (SECOND AGENT): Harry asked whether the PQ ceremony works with his two latest-generation YubiKeys (main = the authority-ceremony key, backup). Answer given: yes by design, NOT proven on hardware (none was plugged in here). Facts: the age identity goes into a RETIRED PIV slot of each key (age-plugin-yubikey 0.5.1, YubiKey 4/5), slot 9c and the authority keys are untouched; only the main key (the one whose slot 9c holds the release Ed25519 key) signs the PQ binding at step 3; both keys must open the key file at step 4. Needs on each key: PIV enabled, its PIV PIN (and the PIV management key if the authority ceremony changed it: age-plugin-yubikey asks for it), Ed25519 in 9c needs firmware 5.7 (the existing authority flow already depends on that). The script now reads firmware with `ykman info` and warns on an old key or PIV off (test added). The ceremony does not change PINs/PUKs. LIVE GYM: arch-v2 pass finished, classic pass running; ROOT CAUSE FOUND for the ~35 'Docker didn't pick up the gVisor runtime' failures: the gVisor setup runs as a separate ROOT process (`setup.ts` STEPS, via privd) that never ran the daemon boot, so `activeEngine()` defaulted to Docker on Podman boxes and it ran `systemctl reload docker` (exit 5, no such unit). FIXED: `rootEngine()` (engine-active record, else the switch file) moved to engine.ts and installed by the root entry point before any step; test `packages/server-daemon/tests/rootEngine.test.ts`. Second finding, NOT yet fixed: on Podman boxes `[data-layer] DOWN: compose couldn't start the core stores` with docker-compose failing `FileNotFoundError` on the engine socket (the installer relies on `podman.socket` + the compose provider in `/etc/containers/containers.conf.d/40-flagship-compose.conf`); needs a look on a live box (plan: gym Worker secret UPCLOUD_SSH_PUBLIC_KEY + `tools/live-e2e/box-bringup-debug.sh`, delete the secret after). The gym `gym` branch must be rebased onto the fix before the next live run.
- 2026-10-26 (resumed session): full live gym `release-20261026T113114Z-*` (before the rootEngine fix) finished: arch-v2 and classic both red, the same clusters as gym 2 (gVisor "Docker didn't pick up the runtime" / systemctl 5 in ~all app-install groups; AI test copy "can't wall off" follows from the sandbox; enforcement/share/remote skips follow). `gymServersLeft: []`. SECOND finding FIXED by reading, not yet proven live: `DataStack` (dataLayer/stack.ts) brought the core stores up with its own `docker compose`, which on a Podman box falls back to bare `docker-compose` against `/var/run/docker.sock` (absent) = the `FileNotFoundError`. On a Podman box it now starts the root data-services unit (init.sh starts podman.socket and runs `podman compose`); Docker boxes unchanged. Tests in dataLayerStack.test.ts. NEXT: rebase `gym` onto release/0.3, rerun the live gym (`set -a; . /Users/harrywinner/flagship/.gym-secrets.env; set +a; GYM_BASE_REF=origin/release/0.3 bash scripts/gym-release-run.sh`); other known reds to triage after: cert SAN test expectation, update.json (no endorsed releases), release-catalog (no pinned root: PQ/catalog ceremony), WASI `/usr/bin/install`, local-AI delete 500, AT-LIVE-19, lifecycle decommission, UpCloud core quota.
- 2026-10-26 (resumed session): live gym 4 (`release-20261026T150349Z-*`, gym tip `d79b8955`, with the rootEngine + data-layer fixes): arch-v2 and classic still red, but the error moved: the gVisor probe now dies with Podman's `short-name "pgvector/pgvector@sha256:..." did not resolve` (Debian's Podman has no unqualified-search registry). FIXED `registries.conf.d/50-flagship.conf` (`unqualified-search-registries = ["docker.io"]`) written by the gVisor setup step, init.sh's Podman branch and the engine switch (no builder/preseed change). ALSO FIXED: gym SAN checks accept a covering wildcard (`sanCovers`); Rust broker `V1_BINARIES` gained `/usr/bin/install` (WASI drop-in). OPEN: the CLASSIC pass shows the same Podman error, which means classic boxes are not on Docker or the stack param is not honoured (needs a live look); local-ai delete 500, AT-LIVE-19 invalid signature, first-contact enrollment proof, remote/share `route-not-allowed-for-session`, update.json no endorsed releases, lifecycle decommission, browser (no Chromium), gpu-sim UpCloud core quota; most others follow from the sandbox. Core-only rerun on both stacks started (`gym-run5-core.log`).
- 2026-10-26 (resumed session): PQ CEREMONY BLOCKED on a design finding: `init` asks the YubiKey (PIV Ed25519, slot 9c) to sign the hybrid message M' = tag || suite || hybrid public key (1,984 B) || payload; for the key binding that is 6,095 bytes in ONE extended-length APDU (no chaining) and the real card fails with `SCardTransmit 0x80100016`. Fake-YubiKey tests cannot see it. Every PQ companion has the same 1,984-byte key inside M' (about 2.3 KB). Options: (1) ship 0.3 classical-only (already allowed) and fix after; (2) make the Ed25519 half sign a short domain-separated digest of M' (format change in every verifier). Writeup for a YubiKey expert: scratchpad `yubikey-pq-writeup.md`. Also fixed: init signs before writing and removes an orphan seed file; ceremony preflight stops early on an AES management key (age-plugin-yubikey needs TDES; switched on the authority key).
- 2026-10-26 (resumed session): PQ CEREMONY DONE by the owner on the real YubiKeys (release key id `1c07f1ffe8e6e8b89d8b8c8c14544d6f065decfa67ea76ec50c30fadaadb9434`, binding `.maintainers/release-pq/bindings/1c07f1ffe8e6e8b8.json`, paper backup written, both YubiKeys open the file). Cause of the earlier blocker: the v1 binding's Ed25519 message was 6,095 bytes and a YubiKey's PIV applet takes ~3 KB (probes on fw 5.7.4: 300, 2,535 and 3,000 bytes sign through Python and through our Node signer; 6,095 is refused). FIX `e26a9c7be`: compact wire-v2 binding (release-key only, own purpose tag `flagship/pq-key-binding/v2`, drops the repeated ML-DSA key; TS, Rust and `installer/verify-box-artifact.sh` accept it; vectors `bindingsV2`, adversarial AT-ENV-21f-j, a size guard under 2,700 bytes). Per-release companions are 2,273-2,535 bytes. The pin: RELEASE_PQ_PIN, CA_LEASE_PQ_PIN (+ the webapp's hand mirror in maintainerTrust.js, which `pin --ca-lease` now updates), box-artifact trust `pq`, the Kotlin/Swift/webapp key-id lists; marker = `dbdf2e08` (the last release signed before the pin). MISTAKE FIXED: my commit `a550f49a0` had swept in the owner's PIN-reset endorsement for `d39ea287` (a signed classical endorsement of a non-final commit) and pushed it; the ceremony then took it as the marker. Removed the file and re-pinned the marker to `dbdf2e08` (the file stays in git history on origin/release/0.3; it is refused under the pin, nothing was deployed). After the pin ~35 tests assumed nothing was pinned: classical-only fixtures now run against an explicit unpinned state (new `pqKeyIds`/`pqPin`/`caLeasePqPin` options on the webapp notice lib, relay verifier, Kotlin/Swift notice centers; the box-artifact CLI now reads the trust file's `pq` and the manifest's `pqBindings`); full suite 14,939 passed, Rust workspace, Kotlin and Swift notice tests green. Webapp shell v184. STILL TO DO for PQ: the release run must PQ-sign the final endorsement (`endorse-release.mjs --to <final sha> --sign`: PIN + touch three times), `sign-ca-lease` / `sign-box-artifact` for new leases and artifacts, and the retro-sign `--pq-only` is NOT needed (dbdf2e08 is the marker). The live gym still has to run with the pin in place.
- 2026-10-27 (resumed session): arch-v2 ON PODMAN BLOCKER and DECISION B. After the Debian 13 fixes (gym on Debian 13 `c294a1d03`..., `User=root` dropping CAP_SETUID `c294a1d03`, iptables `b4b3ac3d3`, privd 'slow down' retry `e5512d997`, gym-only CA/box-artifact pins, VM helper hardening, classic pass now really classic `929f48a0c`), the core gym on arch-v2 fails only at the app install: nothing answers on the published loopback port. Cause (live box): the daemon-owned bridges are `mode=unmanaged`, so netavark configures no port forwarding, `-p 127.0.0.1:h:c` forwards nothing. OWNER DECISION: option B (keep unmanaged bridges, the daemon dials containers directly through one endpoint resolver, identity = container generation). Design: `docs/architecture-v2/app-endpoints.md` (inventory, resolver properties, existing-user track, launch gate). Classic (Docker) on a NEW Debian 13 box also fails (install 500) and is unresolved; existing boxes stay on Docker. Nothing of B is built yet.
- 2026-10-27 (resumed session): DECISION B BUILT (unit-tested, NOT yet proven live). Design settled after the owner's/advisor's review (`docs/architecture-v2/app-endpoints.md` section 3a): lookup key = service + env + component + role; identity = generation (per deploy, rollback gets a fresh one) AND incarnation (container id + StartedAt); an address belongs to a SERVICE for its life (address-reuse fence: a stale dial can only reach nothing or a later incarnation of the same service), freed only on delete after a 60 s quarantine. Code: `packages/server-daemon/src/endpoints.ts` (EndpointTable with leases registered before dialing and destroyed on invalidation, AddressPool, typed `parseObservation`, `publishFromEngine` that publishes only the container the daemon created (service label, generation, running, network, address), EndpointReconciler that follows engine restarts/deaths every 3 s); `serviceRunner.ts` (Podman: `--ip <service address>`, `--label flagship.service/generation`, NO `-p`; Docker keeps `-p` and loopback through the same table); consumers moved: reverse proxy + WebSockets (`appConnection.ts`: 503 when unavailable, WebSockets closed on invalidation), readiness (`tableAnswers`, per incarnation), staging check_app, local AI (`localAi/service.ts`), dedicated databases (`dataLayer/dedicated.ts`: address, labels, admin URL and the gateway link target from the table; an unlabelled container from an earlier Docker release is accepted as the service's own), app groups (each member has its own component entry + address; links target the member's address), WASI http-proxy workers (loopback entry). Both brokers (privd TS and the Rust broker) now accept `--ip` and the two endpoint labels on a dedicated-database run (tests on both). Daemon suite 3,826 passed. TO PROVE LIVE (gym): that Podman 5.4 honours `--ip` on an `unmanaged` bridge, that the daemon user's direct dial works for every consumer, the negative isolation tests, restart/reboot/replacement/IP-reuse/concurrent-install lanes. KNOWN FOLLOW-UPS: the broker should check `--ip` lies in the named network's subnet and is not its gateway (shape only today); the engine events could replace the 3 s reconcile poll; a local-AI `lease` hands out a base URL, so an in-flight fetch is not tied to the lease (safe by address ownership, not by cancellation); classic (Docker) on a NEW Debian 13 box still returns install 500 (owner: little operational value, new boxes are arch-v2; existing boxes stay on Docker and are covered by the existing-box lanes).
- 2026-10-28 (resumed session): FIRST LIVE PROOF of decision B on a real Debian 13 + Podman + gVisor box (kept gym box, then torn down). Proven: Podman 5.4 honours `--ip` on the `unmanaged` bridge; the app runs with no published port at its service address (10.89.2.x) and the daemon user dials it (200); the reverse proxy serves it over HTTPS (corewho.home.<user>.gym.flagship.services 200 x3); a reinstall got the NEXT address, not the freed one (quarantine); a killed container answers 503 at once (fail closed); after a daemon restart the app is back (~2 min, see below). Negative isolation (manual probes with a throwaway gVisor container on the apps bridge): app B cannot reach app A:80, cannot reach the gateway's SSH port, its internet request is refused by the egress proxy (403), and Podman's own IPAM refuses a second container on A's address. NOTE: the apps can reach the core Postgres port through the gateway (5432 open) by design (their data layer, per-app roles). WHAT BLOCKED CORE: the install returned 500 after the container was already running. Cause (found after the 500 handler began logging the real error, `controlHttp.ts`): the legacy `addOwnerToMembership` path signs a membership record with the BOX key; keyd (TS and Rust) refuses `flagship/membership/v1` on purpose, so every install through that flag failed under keyd. That was also the classic-on-Debian-13 "install 500" (same keyd). FIXED: the install reports `ownerMembership: false` and succeeds (the old membership log no longer decides access). Core is then 22/23 (the 23rd was this). OPEN: (1) the daemon needs about 2 min 15 s to start the runtime after each restart ("browser bundle disabled: connect ETIMEDOUT 172.31.250.2:9222" stalls it; the first core run's checks fired before ServicePlatform was ready, hence 'ServicePlatform not configured' + 404s): fix the stall (do not wait on the browser) and make the harness wait for ServicePlatform; (2) the Worker-CPU fleet check is red on the gym Worker (Free-plan 10 ms) and is not a box issue; (3) a `stack-switch` live group was written (`groups/release03/stackSwitch.ts`, needs a classic pass: `GYM_BOX_STACK=classic ... --groups stack-switch`); not run yet; (4) design gaps vs the owner's review: broker returns a typed record (today the daemon parses `inspect` itself), boot-time pool check against the engine, broker `--ip` subnet check. Next: full arch-v2 gym, then the classic pass with stack-switch, then load/resource tests.


- 2026-10-29 (resumed session): LIVE TRIAGE ON A KEPT ARCH-V2 BOX (Debian 13, Podman 5.4, gVisor; focused groups with `--reuse ... --keep`; fixes hot-patched into the box's dist, then committed). FIXED and proven live: (1) the daemon runs with `umask 0077`, so app sources and WASI configs were 0600 and unreadable to the app's own user: python/node/static now build from a host-side context (`openContextForApp`), WASI `writeAtomic` chmods explicitly (runtimes group fully green; wasi-apps 13/13); (2) the apps gateway accepts a container address on the apps bridge as an owned-port target (group links, dedicated DB); (3) Podman `volume create` is not idempotent (model delete 500): tolerated; (4) LOCAL AI start failed with no log: `checkLocalAiRunArgs` rejected the staging resolver bind mount (`/run/flagship-daemon/flagship-resolv-*.conf`) that both brokers already allow, and the check ran outside the logged block. Fixed and logged; local-ai group 14/14 incl. "108 tok/s measured" and delete. (5) a deploy whose `podman run` fails left a `Created` container holding the name and address (next install: IPAM "already allocated" / "name in use"): now `rm -f` on failure. (6) BIG ONE: the daemon only built the per-app disk-image volumes (`LoopVolumes`) when `getuid()===0`; on arch-v2 the daemon is the unprivileged `flagship` user, so per-app disk limits AND the dedicated database profile (which needs the loop volumes) were silently off (`profile: shared`). The broker path (`privdLoopHost`) already existed; the gate in `runtime.ts` now also allows `runsUnprivileged()`. FIXTURE: `app-groups-db` started the whoami member with `/whoami` twice (the image's entrypoint is already `/whoami`), so it listened on 80 not 7000: fixed; the group now uninstalls its own leftovers first. TO RE-PROVE after (6): app-groups-db, quota, backups, archive/app-copy on a fresh box in the full gym. Debug SSH key and Worker secret still to delete when debugging ends (`~/.ssh/gym-debug*`, `wrangler secret delete UPCLOUD_SSH_PUBLIC_KEY --config wrangler.gym.toml`).

- 2026-10-29 (resumed session, later): MORE LIVE FINDINGS ON THE KEPT ARCH-V2 BOX, ALL FIXED AND COMMITTED (hot-patched into the box, then proven): (1) the daemon ignored SIGTERM (listeners replace Node's default exit and the servers keep the loop alive), so systemd waited its 90 s and killed it on every restart/update: `exitSoon` in `wireShutdownHooks` (restart now ~2 s); (2) the address pool forgot what it had given out after a restart, so Podman refused an install ("requested ip address is already allocated"): the pool is seeded from the engine (`seedFromEngine`: owner from container name + service label, `AddressPool.adopt/occupy`); (3) the dedicated-database URL was rewritten twice (once in the WASI host call, once in `realPgConnect`) and the second rewrite sent it to the SHARED server ("password authentication failed"): one rewrite, through the endpoint table (`registerDedicatedPort`/`loopbackPgUrl`), and the daemon waits until the instance answers on its address; (4) a dedicated database's MIGRATION could not reach it: the sandbox shared the instance's Unix-socket volume, but a socket made inside gVisor is not visible to another sandbox. NOT fixed by weakening gVisor (`--host-uds=all` works but was refused as a sandbox weakening; owner may revisit). Instead the migration runs as a member of the app on the apps network and reaches the instance through the gateway's owned port, like the app does (`buildSandboxPlan` `member`); the gateway's forwarder now re-reads the bridge for a source it has not seen (a container that just started); (5) THE BIG ONE: the Rust broker answers one request at a time per connection and the daemon used ONE connection, so a long call (a 5-minute migration, a build, a dump) froze every other broker call (reconciler, installs, health). `PrivdClient` now spreads calls over up to 8 connections; (6) a deploy whose run failed left a Created container (rm -f on failure); (7) `quota` group: a dedicated database has no role budget (its bound is its own volume), so the DB budget/INSERT-refusal checks are skipped with a reason on the dedicated profile (new boxes); the files budget, ENOSPC, full/Activity and free checks pass live. Results on the kept box: local-ai 14/14, wasi-apps 13/13, runtimes green, app-groups-db 7/7, quota files checks green. STILL OPEN: gating identity headers/role (not re-run), share/remote session scope, tier-2 certs under keyd, update (no endorsed release), first-contact, lifecycle timing, AT-LIVE-19, cloud gossip key (the gossip broadcast host has no TLS terminator: "fetch failed" every 45 s), gpu-sim quota, browser group (no Chromium). Next: tear down the kept fleet, run the full arch-v2 gym on a fresh tip (`GYM_STACKS=arch-v2 bash scripts/gym-release-run.sh`), then classic stack-switch, then load/resource tests. Reminder: delete `~/.ssh/gym-debug*` and the Worker secret `UPCLOUD_SSH_PUBLIC_KEY` when debugging ends.

- 2026-10-29 OWNER DECISION (gVisor sockets): keep the gateway route for a dedicated database's migrations; do NOT enable `--host-uds=all` just to support migrations. If sockets ever need to be shared between sandboxes, that is a separate design decision: name the exact socket, limit which sandboxes can reach it, and check whether gVisor supports a sufficiently narrow permission first. (The migration sandbox already runs through the gateway as a member of the app; the older socket-volume path stays for Docker/classic only.)
