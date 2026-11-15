# Flagship 0.4 release: release-manager journal

**If you are a new session taking over: read this whole file, then continue the Plan from the first unchecked
item.** Update this file as you go: tick items, add a dated line to the Log, keep the Resume point current, and
commit it (explicit path, `git add RELEASE-0.4-JOURNAL.md`) on `release/0.4`, pushing each time. When the release
lands on `main`, fold what is still true into `AGENTS.md` "Current status" and move this file to `docs/archive/`.

Owner: Harry (they/them in writing). Budget is limited: don't regenerate what exists, don't re-run long suites
without a reason, ask before buying or publishing anything, and keep sub-agents to what the plan needs.

## What the release is (owner, 2026-11-13)

0.4 builds out every feature that has been stuck: **direct IPv6 access** (`fshp.app` names), **subscriptions**
(Pro payments and vouchers), **calls**, a **preinstalled ISO**, and **quantum-safe everywhere**, plus everything
the 0.4 list (`docs/release-0.4-list.md`) and the advisors' open findings hold. Order: first the post-0.3 close-out,
then the advisor sweep, then the features. UX testing feedback from the owner runs in parallel as its own lane.

## Where things are

- Worktree: `/Users/harrywinner/flagship-0.4`, branch **`release/0.4`** (from `main` `d03b89500`, pushed). All 0.4
  work happens here or in sub-worktrees branched from it; nothing is deployed from it (only `main` deploys, AGENTS.md).
  The main checkout `/Users/harrywinner/flagship` stays on `main` for hotfixes and the post-0.3 owner steps.
- Sub-agents work in their own worktree off `release/0.4` (`git worktree add -b 0.4/<slug> ~/flagship-0.4-<slug>
  release/0.4`, own `npm ci`), and the release manager merges them back (linear: rebase, then fast-forward).
- The 0.3 journal (`RELEASE-0.3-JOURNAL.md`, on `main`) holds the history and the advisors' findings this plan cites.

## Owner decisions (binding)

1. 0.4 launches the stuck features. Their code comes onto `release/0.4` (from `feat/marketplace` and its children
   where it exists) and reaches `main` only with the 0.4 release, so the "unlaunched features live on their branch"
   rule still holds until release day. Features 0.4 does NOT launch stay on their own branches.
2. Every rule in AGENTS.md "Conventions" applies (i18n for every user string, an AI never learns the owner, per-app
   identity, three ranks, minimum OS, only `main` deploys, accounts are never bulk-wiped).
3. Direct access follows `docs/direct-access-and-domains.md` (LOCKED IN 2026-11-08): owner-signed records only, no
   IPv4 relay fallback, no re-pointing a name when the box is down.

## Open questions for the owner (answer before the matching item starts)

- Q1 **Calls:** ANSWERED by the plan found on branch `claude/sleepy-archimedes-pme2jy` (now on `release/0.4`):
  `docs/voici-calls.md` (a visitor calls the page owner's phone, audio only, WebRTC over TURNS to the phone's bare
  name) and the spike `docs/voici-calls-spike.md`. Its open decisions D1-D4 still need the owner.
- Q2 ANSWERED (owner 2026-11-13): it means RETAIL BOX SETUP: NFC tag in the box, or first-come BLE beam to nearby apps on plug-in (booklet: install the app first, return the box if someone raced you), and how to avoid MITM. Design agent writing `docs/retail-box-setup.md`. Old text: **Preinstalled ISO:** an ISO/appliance with Flagship already installed that only needs pairing (no install
  step)? For USB on metal, VMs, or retail boxes (`feat/retail`)? No design doc exists yet.
- Q3 ANSWERED (owner 2026-11-13): EVERYTHING launches in 0.4 (marketplace, Pro/Pro Max, custom domains, custom names, outbound proxy); weigh privacy vs convenience of mixing Apple/Google/Stripe with vouchers/crypto. Design agent writing `docs/payments-privacy-and-rails.md`. Old text: **Subscriptions:** = the Pro / Pro Max plans with anonymous vouchers from `feat/marketplace`
  (`docs/anonymous-vouchers.md`, pricing in AGENTS.md)? Does the marketplace itself, custom domains, custom names and
  the outbound proxy launch in 0.4 too?
- Q4 UX feedback arriving in messages (lane U).

## Plan

### P. Close out 0.3 (from `docs/runbooks/0.3-deploy-sheet.md` "After the store decisions")
- [x] P0 Store verdicts: Apple approved iOS 1.2 (8), released 2026-11-08; Google Play approved Android 11 / Wear
      1,000,011 (owner, 2026-11-08).
- [ ] P1 OWNER: `release.sh --only 45`, the update-required notice for 0.2 apps (YubiKey; event = Play approval time;
      advisory id FSA-2026-001 proposed). Run from the Mac main checkout.
- [x] P2 OWNER (+ me watching): (DONE 2026-11-13 with the owner's verbal OK: reap dry run 40/40 kept, 0 orphaned, 1 UpCloud demo kept; gym sweep 0 servers/0 DNS; zone-health OK; the demo's 12 legacy records stay until P6) `release.sh --only 36`, the skipped reap + zone-health + gym sweep (the script now
      loads `GYM_ADMIN_SECRET` itself, `c3f3cbb71`; needs `FLAGSHIP_ADMIN_SECRET` too).
- [~] P3 (code merged on release/0.4 `8fd9b5552`; box seam on branch `0.4/gym-test-ca-gym-seam` for `gym`; NOT deployed: needs the Fly app `flagship-acme-gym` (~$2/mo), then the gym rollout in docs/gym-test-acme.md "As built") F6b: the gym on a private test CA (`docs/gym-test-acme.md`, Pebble by default plus one real-LE lane per
      release candidate). Code on `release/0.4`; the gym Worker and gym branch follow `gym-refresh.sh`.
      2026-11-13: code built on `0.4/gym-test-ca` (items 1-5, 8, release guard) and the box seam (item 7) on
      `0.4/gym-test-ca-gym-seam` (off `gym`); not merged, nothing deployed. Doc "As built" has the deviations.
- [ ] P4 F6: translation review request; hardware receipts from `0.3-hardware-acceptance.md` into
      `docs/runbooks/receipts/`; OWNER runs `npm run rate-limits` (never checked yet) and records the date in AGENTS.md.
- [ ] P5 Fold the 0.3 journal's still-true state into `AGENTS.md` "Current status" and archive
      `RELEASE-0.3-JOURNAL.md` (on `main`, since it is status, not a feature).
- [ ] P1b OWNER: re-sign the runtime manifest before ~2026-12-20 (signed 2026-11-05 for 45 days): `release.sh --only 10`.
- [ ] P6 The demo server `playstore-test-0725`: update it to 0.3 (it was parked on 0.2 compat through the review
      window), then recreate it on a 20 GB disk (0.4 list "Costs"; set `UPCLOUD_STORAGE_GB` 20 first). OWNER confirms
      the moment; check the review sign-in afterwards.

#### P-clean. Everything parked "until 0.3 is in the stores" (owner, 2026-11-13: "let us clean everything")
- [ ] P7 Retire the 0.2 compatibility code once 0.2 clients have had their notice (P1; a notice lasts at most 30
      days, so propose the cut on its expiry, OWNER confirms the date): the 0.2 demo waiver (`c9443c1f8`,
      `demo02Compat.test.ts`, `servingGate` waiver path), `tools/compat-0.2/`, the `upgrade-02` lane, 0.2-only
      branches in `.com` (`clientUpdate.ts` sentences stay while 0.2 apps are still seen), `final-deploy.md` "The 0.2
      apps, Studios and servers until 0.3 ships". Keep the update-required sentences and `STUDIO_PIPE_MIN`.
- [x] P8 (`1d6eceb57`) Delete `apps/com/src/legacyLateLogs.ts`, its cron call in `scheduled.ts` and its test (due "on or after
      2026-10-31", AGENTS.md GA close-out 5).
- [x] P9 (DONE 2026-11-13, owner OK: 5 branches archived under refs/archive/2026-11-13/ and deleted; stale harrywinner2 ref dropped; tags kept) Branches and tags: delete `hof-jay` (cherry-picked onto main 2026-11-06); look at and archive
      `claude/sleepy-archimedes-pme2jy`, `wip/coordination-2026-10-16`, `device-results/windows-2026-10-17` (and
      `-2026-11-05` once S1 has read it) under `refs/archive/2026-11-13/` with a list in `docs/archive/`; review the
      15 tags and the `harrywinner2` remote. Nothing deleted that is not on main by content or archived.
- [x] P10 (DONE 2026-11-13, owner OK: moved to ~/flagship-local-backup-2026-11-07/main-checkout-leftovers-2026-11-13/; *.pem ignored `.gitignore`) The main checkout's leftovers: `gym-results-from-0.3/`, `dns-ent-experiment*.jsonl` (archive the useful
      results, then remove), `apps/mobile/android/keystore/upload_certificate.pem` (keep out of git: add it to the
      keystore's ignore). OWNER confirms before anything is deleted.
- [ ] P11 Production leftovers, one at a time (never a bulk wipe): throwaway prod accounts from testing (e.g.
      `prime-marten`, the web ones, the Windows round's throwaway account and its browser devices), Hetzner's five
      orphaned servers (if the account unlocked), R2 and DNS leftovers the P2 review lists. Never `playstore-test-0725`.
- [ ] P12 `AGENTS.md` "Current status": rewrite to what is true after 0.3 (drop the "in progress" 0.3 section,
      `feat/UX`, `fix/boot-fix`, `feat/architecture` and every "needs a deploy" entry that shipped in 0.3; keep the
      owner rules, traps and open items). With P5.
- [ ] P13 Docs: archive the 0.3-only runbooks (`0.3-deploy-sheet.md`, `0.3-hardware-acceptance.md` once its
      receipts are in, `0.3-windows-studio-acceptance.md`); fix specs whose header still says "DESIGN, build
      post-launch" for things that shipped (`server-update-mechanism.md`, `server-migration.md`, others found).
- [ ] P14 The "after launch" items 0.3 parked go into F: second relay by DNS round-robin (0.3 I6), production
      qualification of the Rust components (G10), removal of old implementations once proven (G8), the gym's IPv4
      address dropped (AGENTS.md "Make Fly redundant" 1), `VOICI_CANONICAL` decision.

### S. Gather every advisor's open findings (playbook phase 2 in `docs/release-0.4-list.md`)
- [x] S1 (`7e76b6542`: 10 security + 8 other open, 9 owner decisions, 13 lines already fixed) Sweep each source, check each finding against today's code, write what is still open into the 0.4 list with
      its source: Windows device-test agent (`device-results/windows-2026-11-05`, anything after `8669e1970`), B2
      reviewers (journal "B2 OPEN, not fixed", 2026-10-25), the independent security review (journal "SECURITY REVIEW
      (since 10-25, read-only)", 2026-11-02, M1-M6 + Lows), the voi.ci + Messages review (2026-11-03, items 1-6), the
      DEFERRED list (2026-11-02), the follow-ups named in journal entries (IRK self-heal, "burn anyway", G9 repro), the
      store agents' notes, `SECURITY-0.3-PROGRESS.md`, `docs/architecture-v2/REGISTER.md`.
- [ ] S2 Group by priority (security first, then W14 and W19, then the rest) and show the owner before building.

### F. 0.4 features and fixes (order after S2; security items from S1 go first)
- [~] F1 (step 3 + 6 + box side merged 2026-11-14: .com registry, direct-name/v1, D1 0133, publisher, direct certs, box sync/gate/routing; keyd boxes need per-name TLS slots; screens (step 5) MERGED 2026-11-14 on iOS/Android/webapp with mock-gym scenarios; keyd boxes served via per-name slots. Steps 1-2 merged 2026-11-13: `flagship/direct-access/v1` order, `direct-address/v1` box update, `lan-hint/v2`, box public listener, iOS/Android probe; vectors TS/Swift/Kotlin; also fixed: the LAN listener counted forwarded public IPv4 as LAN, exposing rescue routes. NEXT: step 3 `.com` registry + fshp.app records + issuance; step 5 screens. Owner Qs: non-admin devices using the public path; forwarded IPv4 changes) Direct access (`docs/direct-access-and-domains.md` §6): app-side direct path to public addresses, the
      direct-access order + vectors (TS/Swift/Kotlin), `.com` direct-name registry + prober + `fshp.app` records +
      issuance, clients' opt-in and name screens, take `fshp.app` off the website mirror, tests.
- [~] F2 (fold MERGED 2026-11-14: marketplace, Pro payments + vouchers, custom names, custom domains, outbound proxy on release/0.4; shell v208; migrations 0090/0091/0093/0094/0099; parity green; no iOS Xcode build since; new dep undici: run npm ci) Subscriptions + payments: design `docs/payments-privacy-and-rails.md` (`8faecc2ec`): $1 blind-signed vouchers are the only
      currency; Apple IAP / Google Play / Stripe / Monero / Lightning (BTCPay) all sell vouchers; subscriptions as a
      voucher drip to the lead server; the box pays its own bill via OHTTP; plan via `plan-attestation/v1`. Owner
      answers its §9 Q1-Q11. DECIDED 2026-11-13: crypto = Monero only (no Lightning); no refunds; no cash by mail.
      Rest (store drip, iOS in-app vs web, Stripe vs reseller, caps, marketplace cut, prices) to discuss. Then: fold the branches, voucher core + box stash, Stripe, stores, Monero, paid apps. Was: (Q3): fold `feat/marketplace` (62 predicted conflicts; webapp shell above main's) and the
      children Q3 names onto `release/0.4`; Pro payments + anonymous vouchers end to end on all three apps.
- [~] F3 (owner D1-D4 answered 2026-11-14; BUILDING on `0.4/calls`) Calls: build `docs/voici-calls.md` after the owner settles D1-D4 (plus its three voi.ci page fixes in the 0.4 list).
- [~] F4 (PHASE 1 merged 2026-11-14: `flagship/box-claim/v1` + vectors, box claim state machine/button/BLE interface/network diagnosis on fakes, .com key pre-registration + blind mailbox, D1 0134, e2e tests. NOT built: BlueZ GATT, real wipe/recovery partition, Release order, daemon wiring, reset-window push, Swift/Kotlin/Rust ports, phone UI. Owner Qs below.) Retail box setup (Q2): DESIGN v2 merged 2026-11-14 (Bluetooth-first, app opens first, only-one-advert rule, 10-min window, ONE timed power press, Ethernet advised, internet key check, 5-press reset, no hardware ids at .com, printed code = optional Verified tier; partner checklist H1-H7). Superseded v1 text: design `docs/retail-box-setup.md` (`c69d039aa`): printed 100-bit claim code (QR + 20 chars)
      keys a local-only X-Wing handshake (`flagship/box-claim/v1`), recipe as consent, box-signed receipt pins the
      server key, 5-press reset window; no NFC/first-come in v1; drop `box_serials`. Owner answers its Q1-Q10, then build
      (phase 1 software, testable on a VM; doubles as a preinstalled image for DIY metal).
- [~] F5 (2026-11-14 also merged: Swift/Kotlin companions on rotate/add-device/create, re-pair + demo grants, CI vector check, IRK-signed box orders hybrid under strict; graph 16/18 strict targets reachable, 74 fallen, 59 paths. OPEN: webapp passes grantPqSignature (shell bump), rest of IRK sealing/boot. Stage 1 part merged 2026-11-14: hybrid admin root, rotation + device-grant PQ companions, TS/Rust vectors, box + .com, D1 0138; crypto-graph 74 -> 65 bypasses, 18/18 strict targets still reachable; next: Swift/Kotlin signing of companions, then split key.irk) Quantum-safe everywhere, three stages (0.4 list): close the crypto-graph bypasses (hybrid admin root first;
      strict check green); hybrid channel on by default with classical fallback and a fallback count; strict default
      for new accounts after the external review. Also the hybrid release catalog and the boot client's ML-DSA key.
- [ ] F6 Take the zone-wide DNS token off `.com` (challenge TXT through the broker; release step 20 skips when unset).
- [x] F7 (merged 2026-11-14: Web Push to UnifiedPush endpoints from .com with an SSRF guard, Android distributor-first transport, Settings row; D1 0136; needs WEBPUSH_VAPID_* secrets, an Android store build, a real ntfy test) UnifiedPush for de-Googled Android.
- [x] F8 (merged 2026-11-14: correction window, weekly cooldown, account claim budget, 30-day custom-domain lapse grace; D1 0137; owner Qs in named-links §8.5) Human `voi.ci` service names (`docs/voici-service-names-todo.md`).
- [~] F9 (2026-11-14 merged: W19, silent second boot approval, first-boot restarts (order resumes across restarts incl. direct names), Unlocking lingering, W14 partly (taps never ignored, 90 s stop, review-period sentence; OWNER: may a device under review unlock boots?). Earlier merged 2026-11-13: Android stale recovery banner, "another account" backup refusal, W3 hint, W10, W26, raw recipe error, remaster temp folders, sealing stall at 12 min. LEFT: W14, W19, silent second boot approval, first-boot restarts, lingering Unlocking, window close, keep-awake log, MessageBox Pane) Windows acceptance findings (0.4 list section): W14, the silent second boot approval, first-boot daemon
      restarts restarting the certificate order, W19 empty Home, Android stale recovery banner and "another account"
      backup refusal, the Studio for Windows items, W3 Continue hint.
- [x] F10 (merged 2026-11-13) In-app rules sheet names the nudity / violence rule (all apps, all languages).
- [ ] F11 CI: Android emulator smoke on API 34; iOS CI green.
- [x] F12 (merged 2026-11-13; all three Studios show the refusal and stop; Windows WPF needs a Windows CI build) The Studio pairing refusal must be visible: a 0.2 Studio refused by `STUDIO_PIPE_MIN` loops on new QR codes
      (found 2026-11-13 on the owner's Mac); the current Studios must show the relay's `error` reason and stop.
- [ ] F13 Repo housekeeping: rebase the remaining feature branches and `gym` (0.4 list), smallest first.
- [ ] F15 Rate limits (first check, 2026-11-13, 30 days): `builder-pipe-upgrade` refused 2,685 from 339 sources (likely 0.2
      Studios looping on the STUDIO_PIPE_MIN refusal, see F12); `account-resolve` refused 6,019 across 1,224 usernames
      with 23 accounts in D1 (enumeration, or a client looping on unknown names?): find the callers' pattern, fix.
- [~] F16 (merged 2026-11-14: MV3 Firefox 140+, QR pairing from iOS/Android, cert pinning, knock bar, 6 languages, 52 tests; OWNER: AMO account + listed/unlisted; needs a live run; strict servers checked classical only) Firefox extension (owner 2026-11-14): cert pinning + cross-site knock, QR-paired key-light session; AMO listing later.
- [ ] F17 OWNER: ask Let's Encrypt for a rate-limit increase on `fshp.app` (hosting-provider form) before direct names launch.
- [ ] F14 The parked "after launch" work (from P14): second relay by DNS round-robin, Rust production
      qualification (G10), removal of old implementations once proven (G8), gym IPv6-only, `VOICI_CANONICAL`.

### U. UX feedback lane (parallel; owner's notes, Q4)
- [x] U4 (merged 2026-11-14: sidebar >=700px, list/detail >=1100px, phone unchanged; store tablet captures need re-rendering) (reviewer via owner, 2026-11-14) The webapp is phone-style only: make it responsive, iPad-like on desktop
      (sidebar instead of the tab bar, list/detail panes). Agent on `0.4/webapp-responsive`.
- [ ] U1 Write each note as an item here with the screen and platform; iOS first, then port (memory rule).
- [~] U3 (iOS + Android + webapp merged 2026-11-14 with today's features; Android gym tests not run on a device; `docs/social-tab.md`; guests/comments/audience/calls need the protocol answers; Android + webapp ports next) Social tab layout: the editor becomes the tab (old landing page removed, its features moved);
      the page previews itself (minus voi.ci's footer); title row "Your page" + Public switch + options menu (theme,
      share/copy link, accept messages); profile fields read as the live page with a pencil each; the unpublished bar
      only when something changed, spinning while it publishes; Profile / Messages tabs; Messages: who can reach you
      (all / some people), conversations vs requests; guests-only posts; comments and calls fit in without clutter.
      Prototype for critique: https://claude.ai/artifact/ABqoHvYhdTEWaDb7cGMkLt (owner will have other models critique
      it before it is built; then iOS first, Android and webapp after).
      2026-11-14: iOS built on branch `0.4/social-ios` (not merged): Social tab, editor as the tab, Page options, the
      publish bar; GymMessagesTests 18/18. Spec and the protocol sketch for guests, comments, reach and calls:
      `docs/social-tab.md`. Android and the webapp next.
- [x] U2 (iOS, Android and webapp merged 2026-11-14; webapp shell bump at release) The Messages tab is too cumbersome: rename it **Social**, give it a simpler icon (the message
      bubble in a green circle reads oddly), and simplify the page (details in the owner's next messages). All apps,
      all languages.

### R. Release
- [ ] R1 Gym on the test CA, full run green (one green run per group is enough; LE failures are logged, not rerun).
- [ ] R2 Version bump to 0.4 (`release/version.json`, `node scripts/check-versions.mjs --write`; store numbers climb).
- [ ] R3 Store art, release notes, blog, translations.
- [ ] R4 Deploy sheet for 0.4 (migrations, `.com`, `.services`, endorsed box release, store builds, Studios,
      appliances) and the owner's `release.sh` run; merge `release/0.4` to `main` (fast-forward).

## Log

- 2026-11-13 Owner: "let's start 0.4": all work on a dedicated branch; first the post-0.3 plan, then the 0.4 plan,
  with the UX feedback lane in parallel through sub-agents. Created `release/0.4` from `main` `d03b89500` in
  `~/flagship-0.4` (pushed) and this journal. Found today: the owner's Mac Studio is a 0.2 build (Oct 12), refused
  by `STUDIO_PIPE_MIN = 2`, and it loops on new QR codes instead of showing the refusal (F12); owner told to update.
- 2026-11-13 Owner: "make sure to include the post-0.3 work we kept for after 0.3 is in stores; let us clean
  everything". Swept code + docs for parked items: added P-clean (P7-P14) and F14.
- 2026-11-13 P8 done (`1d6eceb57`). Found the calls plan on the unmerged branch `claude/sleepy-archimedes-pme2jy`
  (spike, `docs/voici-calls.md`, 0.4 list items): replayed onto `release/0.4` (6 commits; its abuse-page commit was
  already on main). The branch can be deleted (P9). Agents running: S1 advisor sweep, P3 gym test CA.
- 2026-11-13 S1 merged (`7e76b6542`): section "Advisor findings still open" in the 0.4 list. Top open: app image builds
  under root dockerd, never-reviewed flagship-wasi/runtime/crypto/typed.rs, strict servers refuse their own Ed25519
  health reports, gpud residuals, no external review of the new crypto. Found: runtime manifest expires ~2026-12-20
  (P1b); owner decision on translating `.com` refusal sentences. Next: S2, show the owner the grouped list.

- 2026-11-13 Merged P3 code (gym test CA, 7 commits). Owner answers: P1/P2 with verbal permission (P2 done, all
  clean; P1 needs the YubiKey, waits for the owner), Q2 = retail box setup, Q3 = everything launches, D1-D4 next,
  cleanup OK (P9, P10 done), first UX note (U2: Messages -> Social). P4 rate-limit check run (F15). Design agents
  started: retail box setup, payments rails.
- 2026-11-13 Retail design merged (`c69d039aa`); owner questions Q1-Q10 in the doc §end.
- 2026-11-13 Payments design merged (`8faecc2ec`); owner questions in its §9. Both design agents done.
- 2026-11-13 Payment decisions: Monero only, no refunds, no cash. Social tab prototype published (U3) for critique.
- 2026-11-13 Owner: likes the Social prototype; fold the feature branches into 0.4; keep sub-agents building while
  decisions are discussed. Started 5 agents, each on its own branch off release/0.4: `0.4/fold-features`
  (marketplace, custom-names, custom-domains, outbound-proxy), `0.4/security-fixes` (health hybrid signing, gpud,
  keyd revocation freshness, revoked cert), `0.4/social-ios` (U2+U3 with today's features + docs/social-tab.md),
  `0.4/small-fixes` (F9 client items, F10, F12), `0.4/direct-access` (F1 steps 1-2). Webapp shell bumps happen at
  merge only.
- 2026-11-13 Owner answers: store price $10 (not $9.99); retail must be intuitive with NO monitor (the typical user
  runs the box headless: the design is already headless-first, the monitor is only a last-resort fallback);
  per-service certificates: a special domain with a subdomain per service (fold into F1/fshp.app planning);
  asked what rank orders and the browser extension are (explained; the extension is a design-only branch,
  recommended to stay parked with other-os-installers; retail code folds after its design is settled).
- 2026-11-13 Merged `0.4/small-fixes` (10 commits, F12, F10, F9 part): tsc clean, builder + rules tests 358/358.
  Not built here: the Windows WPF app (needs Windows CI); no device runs. Webapp translations changed: bump the
  shell at the next webapp release.
- 2026-11-13 Merged `0.4/direct-access` (F1 steps 1-2): tsc clean, direct-access tests + vectors check pass.
  Owner leaning: per-service certificates on `fshp.app` (asked to confirm).
- 2026-11-14 Owner decisions: (1) per-service/direct names on `fshp.app`; the owner will get Let's Encrypt's
  rate-limit increase for it (many certificates). (2) Relayed names on `flagship.services` need not match the
  direct domain's per-service granularity (attributed differently). (3) BUILD the Firefox extension in 0.4
  (Firefox-only, the browser where Flagship runs well; possible Mozilla funding): agent on `0.4/firefox-extension`.
  (4) Retail: owner proposes first-boot Bluetooth pairing as the source of truth (no printed card); analysis given.
- 2026-11-14 Merged `0.4/security-fixes` (6 commits): hybrid health reports via keyd `sign-health`; gpud approval
  expiry (90 d), PQ half under strict, daemon maintenance off by default; `.com` CA-signed revocation list in
  `/device-grants` + keyd `evidence.list` (master only with a list < 7 d old); boxes drop CA-revoked certificates
  (`POST /api/certificates/revoked`). tsc clean; keyd/com/protocol tests 2293 pass. Deploy order: `.com` BEFORE the
  box release. Owner questions: GPU approval lifetime 90 d; gpud withdrawals direct?; owner PQ key for gpud on
  admin-root boxes (strict refuses every GPU approval today); GPU maintenance order design; revocation-list
  freshness 7 d vs data sovereignty, rank orders via .com?; keyd slot deactivation for a revoked key.
- 2026-11-14 Merged `0.4/social-ios` (iOS Social tab; i18n conflict with small-fixes resolved by a 3-way key merge +
  `i18n-ios.mjs build`; `npm run i18n` ok; full iOS build not re-run after the merge) and the retail design v2.
  Owner questions: social-tab.md Q1-Q8 (guests, comments, passes); retail v2 Q1-Q8.
- 2026-11-14 Session restart: the previous session's agents had stopped mid-work. Relaunched 7, each in its own worktree
  and continuing from its uncommitted changes: `0.4/webapp-responsive` (U4), `0.4/social-ports` (U2/U3 Android + webapp),
  `0.4/boot-remote` (F9 rest), `0.4/fold-features` (F2 fold: iOS catalog harvest, rebase), `0.4/firefox-extension`
  (F16), `0.4/pq-stage1` (F5 stage 1, hybrid admin root), `0.4/direct-access-com` (F1 step 3). Retail v2 Q1-Q8 asked
  of the owner again.
- 2026-11-14 Merged U4 responsive webapp and F16 Firefox extension (tsc clean). Fold rebased but conflicts with U4 in
  webapp/index.html: sent back to its agent. Fold notes: shell v208, migrations 0090/0091/0093/0094/0099 (no clash),
  parity has two reds from release/0.4 itself (Social tab removed anchored files; device-revocation-list vectors unread).
  Owner's round-3 retail notes recorded in docs/retail-box-setup.md §15 (ratcheting code, locked reset, network).
- 2026-11-14 Merged the fold (47 commits; fits the responsive layout; parity reds fixed: Social-tab anchors,
  device-revocation-list keyd-only, extension pairing phone-only). Retail: no printed cards; Bluetooth + press is the
  normal no-monitor method (phone registers the box key at .com before sending Wi-Fi); monitor + 3 presses shows the
  sharing QR; one public gestures page. Owner out of office for a few hours: keep building.
- 2026-11-14 Started 3 more agents: `0.4/retail` (F4 phase 1 software, assumes lock-from-wipe; D1 0134-0135),
  `0.4/unifiedpush` (F7; D1 0136 if needed), `0.4/voici-names` (F8; D1 0137). Direct access holds 0133. Still running:
  social-ports, boot-remote, pq-stage1, direct-access-com. Worktree `~/flagship-0.4-fold` and branch
  `0.4/fold-features` (local + origin) are merged and can be removed (my deletion was blocked by the permission gate).
- 2026-11-14 Merged F5 stage-1 part (hybrid admin root, D1 **0138**). Started its client port (Swift + Kotlin).
- 2026-11-14 F1 step 3 (.com registry, `flagship/direct-name/v1`, D1 0133, publisher, `direct` cert class, daily
  recheck, prober) + step 6 (fshp.app off the mirror) built on `0.4/direct-access-com`; sent back to rebase over the
  fold + 0138, then the box side of step 3. Owner Qs (direct): CAA "off" = permissive record or none at apex; raise the
  40/week cap after LE's increase; vanity names wait for paid names?; revoke certs of suspended names?; delete the old
  mirror `*`/`www` records at go-live; a real bare-fshp.app page. Deploy needs secrets CLOUDFLARE_DIRECT_DNS_API_TOKEN +
  CLOUDFLARE_DIRECT_ZONE_ID.
- 2026-11-14 Merged the Social tab ports (Android + webapp, fitted to the responsive layout; 18 old webapp keys pruned).
  Fixed a missing brace in GymOctoberTest.kt from the fold (Android gym tests compile again). Parity red left:
  `pq-authority` vectors have no Swift/Kotlin/web reader yet (the PQ agent is porting them).
- 2026-11-14 Merged F8 voi.ci names (0137), F7 UnifiedPush (0136), F1 step 3 + box side (0133). Migrations on
  release/0.4 now: ...0132, 0133, 0136, 0137, 0138 (0134-0135 reserved for retail). Boot fixes (W19, second boot
  approval, first-boot restarts, Unlocking lingering, W14 partly) sent back for a semantic rebase over direct certs.
  Owner Qs: voi.ci name caps 5/25/100 vs 5/50/250, liveness 60 d, keep D7, 30-day domain cooldown; W14: may a device
  under review unlock boots?
- 2026-11-14 Merged PQ client port and the boot fixes. Breakages found on release/0.4 (from the fold): iOS test
  target `OutboundProxyTests.swift` does not compile; `UpdateLockGateTests.testNoClientSkipsTheGate` flags
  `LiveScreensClient.swift:239`; webapp `webappShareServerFlows` share-notice tests fail. Fix agent started on
  `0.4/fixups` (also the webapp grantPqSignature passthrough, shell v209). Running: retail phase 1, direct-access
  screens.
- 2026-11-14 Merged retail phase 1 (rebased over direct access/UnifiedPush/voi.ci names; tsc + 5840 tests green).
  Agent decisions: lock only from the wipe (one-line switch in resetPolicy.ts); logind drop-in on metal images only
  (VMs keep the ACPI graceful stop); setup code drawn on 3 presses, re-asking draws a new one, expires 24 h after
  shown, code claim needs no press; 5 presses on an unclaimed box reopen its window; box registers alone 2 min after
  the receipt if the phone vanishes. Owner Qs: confirm these; Wi-Fi stack on the metal image (NetworkManager/iwd/
  wpa_supplicant); doc Q3 (release = wipe?) and Q6 (LAN claim path).
- 2026-11-14 Merged `0.4/fixups`: share-notice tests (test was wrong after the UnifiedPush guard), iOS marketplace
  calls through `gatedData`, OutboundProxyTests compile and pass, webapp passes grantPqSignature (shell **v209**),
  webapp reads pq-authority vectors. `npm run parity` fully green. Running: direct-access screens.
- 2026-11-14 Started `0.4/retail-apps` (box-claim Swift/Kotlin/Rust ports + iOS claim screens, Android if time) and
  `0.4/keyd-direct-slots` (per-name TLS slots in keyd + tlsd/ingress so arch-v2 boxes serve direct names).
- 2026-11-14 Merged `0.4/keyd-direct-slots`: keyd (TS+Rust) holds a TLS key + `direct` slot per verified direct name
  (max 16, own account's derived names only), tlsd/ingress serve it by exact SNI; needs an endorsed release carrying
  daemon + keyd + Rust ingress + rebuilt Go tlsd together. Found: keyd `boxPurposes.test.ts` fails on release/0.4:
  retail's `flagship/box-claim-receipt/v1` is signed by the daemon, not through keyd (give it to the retail-apps agent).
  Direct-access screens rebased (i18n merged key by key); one webapp test failing, being identified.
- 2026-11-14 Merged direct-access screens (F1 step 5). Webapp test flakes under load (pairing, server order, phoneRoute;
  each passes alone). Owner Qs: name orders ask for biometrics each time (voi.ci names use the unlocked session)?;
  direct orders carry no PQ half yet (strict would refuse). Running: retail-apps (ports + iOS claim screens + keyd
  box-claim-receipt purpose).
- 2026-11-14 Owner: (1) [CORRECTED below: fshp.app is never served through the relay; the locked rule stays] the
  fshp.app certificate is issued even before the direct IPv6 path is live; agent `0.4/direct-via-relay`. (2) Design agent: transport adapters, so a box can go
  online over any network its host has (mesh, LAN-only, radio, overlay), with what it means for encryption, sessions
  and HTTPS, and owner-responsibility warnings for exotic channels: `docs/transport-adapters.md`. (3) Retail: Wi-Fi
  stack waits for hardware; release = wipe; wired data-centre claim path wanted (webapp in Firefox on a rugged laptop,
  non-Bluetooth trays hot-plugged): design agent. (4) Backups: owner finds account-only backups counterproductive.
  Today a Back up now backup with a passcode opens in any account, but SCHEDULED backups carry only the account slot,
  so they die with the account. Proposed: a backup recovery key slot on every scheduled backup (box holds only its
  public key); asked the owner.
- 2026-11-14 Merged design `docs/transport-adapters.md`: adapters only move bytes (stream adapters into ingress like
  the relay; message adapters carry signed sealed envelopes); box name = identity, routes in a box-signed endpoint
  record to owner devices only; trust tiers WebPKI > key-bound TLS > pq-session; owner consent
  `flagship/transport-consent/v1` (adapter hash, risk class, scopes, warning-text hash, expiry) enforced by the box.
  0.4 candidate: `host-ip` adapter (WireGuard/Tailscale/ZeroTier/Yggdrasil/meshes as host interfaces), 3-5 weeks;
  Tor 0.5; message adapters 0.5-0.6. Owner Qs in its §9 (8).
- 2026-11-14 Merged design `docs/retail-wired-fleet.md` (wired data-centre trays): the webapp never talks to a tray on
  the LAN; it reaches unclaimed trays only via .com's blind mailbox. Default proof = setup code on VGA/KVM/serial/BMC
  SOL (3 presses; BMC soft-power counts); no-console trays: a .com claim lobby (same public IP) + arm-all + one press.
  Batch claims, rack-position names, hot-replace via wipe-now + restore from peers, decommission = release wipe;
  restricted egress yes, air-gapped no. Limits found: AuthCode 10/h, SERVER_ORDER_MAX 64, webapp classical-only.
  Owner Qs Q-W1..Q-W11 in the doc.
- 2026-11-14 Owner corrections: (1) fshp.app names are NEVER served through the relay for users; central help only for
  first-time certificate setup if it helps and exposes no new data. DNS-01 already issues without inbound reachability,
  so the relay part is scrapped; the agent keeps only "issue before the direct path is live". Locked rule stays.
  (2) Backups: Back up now stays passcode-protected (the emergency migration route; already true: a passcode slot is
  required and opens in any account). Scheduled backups stay account-contained (proposal dropped). Owner wants ANY
  device of the account able to order a restore; today restore is admin-only (restore = adding a server, admin-only
  rule 2026-10-16). Asked the owner which way.
- 2026-11-14 Owner: restores stay admin-only; Add a device gets a line "only admin devices manage backups" (agent
  `0.4/backup-admin-note`). Restore INTO an existing server should merge the backup's apps (versioning of code + data
  when the app exists): design agent `0.4/restore-merge` -> docs/restore-into-server.md. Wired fleet: routing setup
  through .com is backwards; a small local helper on the laptop (LAN direct, needed for air-gapped) is fine: design
  agent revising docs/retail-wired-fleet.md (Studio as the helper?, air-gapped dependency list).
- 2026-11-14 Merged wired fleet design v2: Studio is the LAN helper with one shared Rust crate `flagship-fleet`
  (discovery via DNS-SD, framed TCP 4433 claim links, serial/BMC consoles); it holds no keys, the handshake runs
  webapp<->tray; browser<->helper via the Firefox extension's native messaging (fallback: hardened loopback port);
  .com lobby dropped, code mailbox kept as remote fallback. Air-gapped "site mode" mapped (17 .com functions, each with a
  substitute; reopens D1 in bounded form); recommended: connected wired path in 0.4, site mode later. Owner Qs Q-W1..14
  (site mode when, site-only accounts, Studio+Rust, port 4433, sign Windows Studio, helper-read codes default).
- 2026-11-14 Merged design docs/restore-into-server.md: restore INTO a running server app by app; a random per-app
  `origin` decides "same app"; codeHistory + appliedMigrations compare code/data versions; per app Install / Keep /
  Replace / Replace data only / Copy (no row merge in v1); store "generations" swap in seconds with a 7-day undo point;
  stage + plan orders (admin root); access lists never overwritten. Riskiest piece: store generations (Rust broker
  too). Found: server-backup-and-clone.md says API keys come back on restore, restore.ts never restores one.
  Owner Qs in its §10.
- 2026-11-14 Merged the Add a device note "Only an admin device can manage backups and restore servers." (iOS, Android,
  webapp, six languages). Note: `i18n-pwa.mjs extract` wraps brand labels in webapp/lib/voiciText.js; revert when it does.
- 2026-11-14 Merged `0.4/direct-via-relay` (now: no relay for fshp.app): issuance already waited only for the signed
  name order; `/direct-access` view lists each name's certificate; "Certificate ready. Waiting for the direct path."
  in all apps; closed a real gap: fshp.app/fshp.tech were not in `isOwnZone`, so a custom-domain order could have
  mapped a fshp.app name to a tunnel; the box also refuses fshp.app SNIs on relay streams. Owner Q: allow turning a
  name on (to fetch its certificate) while direct access on its box is still off?
- 2026-11-14 Owner: air-gapped site mode is planned, NOT released in 0.4 (after Windows certification and funding).
  Restore-into-server defaults accepted as proposed; keywords security + smooth UX. Build started on
  `0.4/restore-merge-build`, store generations first.
- 2026-11-14 Merged `0.4/retail-apps`: box-claim/v1 in Swift + Kotlin (vectors), keyd signs `box-claim-receipt/v1`
  (hybrid, fixed shape; boxPurposes green), iOS "Set up a box from a store" (Core Bluetooth, press screen, recipe,
  key registration, Wi-Fi step, internet check + alarms, code/mailbox path, 7 mock-gym scenarios green), webapp
  points to the phone (shell **v210**). LEFT: Android screens, Rust port, BlueZ GATT peripheral, real radio run.
  Owner Qs: one Face ID instead of two (reuse the create flow's unsealed admin key)?; alarm "untrusted" state;
  matching key but no cert yet = done or wait?; hide the retail entry on store builds until hardware?
- 2026-11-14 Owner (retail): ONE Face ID for the claim; HTTPS everywhere + smooth UX, so the claim waits for the
  box's certificate before "done"; the alarm gets a real "untrusted" state; the retail entry SHOWS on store builds:
  an online sales channel starts with 0.4 (so the box-side BlueZ GATT peripheral and Android screens are 0.4 work).
  Agents: `0.4/retail-apps-2` (iOS fixes + Android screens), `0.4/retail-bluez` (box GATT peripheral + daemon wiring).
- 2026-11-14 Merged design docs/enterprise-accounts.md: orgs with seats (normal personal accounts admitted by the
  org, per-org unlinkable seat keys), a signed org authority record with k-of-n thresholds (collected hybrid approvals
  `flagship/org-approval/v1`, not threshold crypto), roles org/server/service admin + member, offboarding rotates every
  secret incl. the disk key, offline recovery kit with a 14-day veto window, audit chain, enterprise plan tier.
  Today's limits found: no device cap, 100 co-managers per box, no per-account share cap, 5,000 app visitors per app,
  64 servers. Recommendation: cap 5 co-managers (10 on Pro Max), app visitors unlimited. Owner Qs Q-E1..Q-E15.
- 2026-11-14 Owner (enterprise): freeze yes; seats unlinkable with a mandatory pseudonym set before the invite;
  caps debated (5 fine for family, 10 small for business, tiers must differ); founder privileges + bylaws ceremony to
  overturn a rogue admin proposed. Recorded in docs/enterprise-accounts.md.
- 2026-11-14 Owner: "I agree on all. Build!!!" Enterprise decisions recorded (caps Free 5 / Pro 10 / Pro Max 25 /
  Enterprise per seat; Q-E3 yes; freeze only; pseudonym seats; founder 7-day removal with veto; bylaws ceremony).
  Agents: `0.4/comanager-caps`, `0.4/enterprise-build` (phases in order).
- 2026-11-14 Merged restore-into-server box side (store generations incl. Rust broker, origin + codeHistory, stage/
  plan/undo/discard orders with vectors and Swift/Kotlin/web ports, journaled runs, 7-day undo, no migration).
  Decided under the owner's keywords: calm "being restored" page during the swap; restore Activity as code + params
  translated by each app; undo images deleted on expiry; doc follows the built path. Agent continues with the screens.
  Found: server-daemon `centralAuthorization` fails on /api/box-claim (given to the retail-bluez agent).
- 2026-11-14 Merged `0.4/retail-bluez`: in-tree D-Bus client + BlueZ GATT peripheral (advert + scan response, MTU
  framing, one phone at a time, per-boot random address), claim service runs only on retail images
  (/etc/flagship/retail-image.json) and serves nothing while locked, reset-window Activity + push, `retail-wipe` root
  step (cryptsetup erase + header overwrite + read-back), `flagship/box-release/v1` order (admin root, vectors),
  wipeVerifier false-positive fix (1 in 8 erased headers looked unerased), centralAuthorization fixed. MUST-FIX before
  any sale (found by the agent): a re-claimed box kept the previous owner's keyd identity; agent fixing now, plus the
  hybrid release order under strict and the phones' Release screen. Partition layout/recovery image wait for hardware.
- 2026-11-14 Calls: D1 accepted conversations, D2 iPads ring, D3 60 min, D4 China ships without ringing if legal.
  Build agent `0.4/calls`. Design agent `0.4/calls-v2`: video calls, enterprise no-account visitor calls, paid calls.
- 2026-11-14 Merged design docs/voici-calls-v2.md: video as an in-call switch (VP8 -> H.264 -> AV1, no simulcast,
  360p default, audio first, quota-counted); anonymous visitor calls for org pages only (off by default, hours + queue,
  proof of work / Private Access Tokens, no phone/email checks); paid calls phase 1 via the org's own Stripe Connect
  (Flagship fee, never holds money), vouchers only after counsel; adult content: facts (stores, card networks, Stripe,
  2257, FOSTA-SESTA, REPORT Act, DSA) and a recommended "not allowed". Owner Qs V-1..2, A-1..3, P-1..4, AD-1.
- 2026-11-14 Merged restore-into-server decisions + iOS screens (calm page, Activity code+params, kept images deleted,
  tree-move crash window closed, box refusals now in the catalog, iOS entries/choice sheet/progress/undo list). LEFT:
  Android + webapp screens, gym UI scenarios, Home entry, pull/peer sources, hybrid signature on these orders from iOS
  (strict boxes refuse). Machine load ~40: full suites unreliable; fewer parallel agents from now on.
- 2026-11-14 Merged enterprise E1-E3 + first iOS screens: org authority protocol + vectors (TS, Swift), .com orgs
  (D1 **0141**, /api/orgs, ceremony mailbox, audit chain), box org-authority pin + org-decided sensitive orders, iOS
  Settings -> Organizations (create, approvals inbox, freeze, Restore my access, invite pseudonym-first). LEFT: Kotlin
  port (written, uncompiled, uncommitted in ~/flagship-0.4-enterprise-build), invite accept screen, org servers
  (AuthCode/registration/genesis), real key rotations on offboarding, Rust port, Android/web UI, audit export, account
  conversion. Owner Qs: strictest-ceremony formula vs unanimity; founder veto k=1; recovery kit required under 3
  admins?; trial seat limit (10 now); org reads need a signed token?
- 2026-11-14 Merged `0.4/retail-apps-2`: one Face ID, certificate wait before "done" (5 min soft notice, 30 min
  checking), persisted per-device "untrusted" server state (no connections, red badge, Delete + reset steps), retail
  entry on store builds; full Android port (BLE scan + GATT, permissions API 29-31+, screens, code scan, 108 strings).
  iOS 9 retail gym tests green; Android unit tests green, Android gym scenarios not run (no emulator). My first rebase
  of this branch committed conflict markers (zsh did not split the file list); reset to the agent's tip and redone
  with scratchpad/rebase-i18n.sh (refuses on any marker). Owner Q: mark a box that never comes online untrusted too?
- 2026-11-14 Merged `0.4/retail-bluez` round 2 (fresh keyd identity on every wipe/reset/release incl. /boot and the
  retail folder; wipe-check false alarm 1 in 2,000 fixed; hybrid release under strict; phones: reset-window
  notification + Release this box) and `0.4/comanager-caps` (cap counts active shares; box sums siblings over the
  gossip-MAC'd access-sync; .com backstop; n of N on all apps). tsc + i18n green. PARITY RED: 18 org-authority tags and
  vectors missing on Android, because the enterprise Kotlin port is written but uncompiled (uncommitted in
  ~/flagship-0.4-enterprise-build). Next: compile + commit it when load allows. Retail image still needs a build-time
  keyd identity step and bluetoothd group/experimental flag. Owner Qs: share-count (not people) OK?; refusal wording
  until payments ship; unopened links count; enterprise plan tier with the enterprise release.
- 2026-11-14 Enterprise Kotlin port: Gradle was killed (Mac critically low on memory) before compiling; NOT committed.
  Files ready in ~/flagship-0.4-enterprise-build (OrgAuthority.kt, OrgAuthorityVectorsTest.kt, PqTrust.kt roles,
  parity allowlist for org-seat-key-wrap on android/web). Run when the calls agent is done and the Mac is idle:
  `cd apps/mobile/android && JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ./gradlew
  --no-daemon :app:testDebugUnitTest --tests '*OrgAuthorityVectorsTest*' -Dorg.gradle.jvmargs=-Xmx3g`, fix, commit.
- 2026-11-15 Owner opened a CLOUD session for heavy work (tests, long builds): ListAgents name "Session ID for
  inter-session communication" (cloud; it cannot message back). It reports by pushing Markdown files under
  `cloud-reports/` on branch `0.4/cloud-reports` (check with `git fetch && git log origin/0.4/cloud-reports`).
  Task 1 sent: full tsc/vitest/i18n/parity/cargo/Android run on release/0.4. It also has the owner's private clone
  harrywinner2/flagship: unannounced features may live there or on non-public ibisllc branches (owner OK to change
  access). Merged `0.4/calls` (half: protocol TS/Swift/Kotlin, .com call rooms + D1 **0146**, VOICI_CALLS off in
  prod, voi.ci Call button, flagship-turn-lite crate; LEFT: phone call layers iOS/Android, relay forwarding, webapp
  missed calls, gym/CI). Expected parity reds: org tags on Android (Kotlin port compiling now), voici-call push
  handlers (phone call layer not built).

- 2026-11-14 late: Owner "keep building". Enterprise Kotlin port committed on `0.4/enterprise-build` (`fc088c058`,
  pushed; local Gradle compile still running under load ~27, so the cloud session also got it as Task 2). No cloud report
  had landed yet; nudged the cloud session (reports to `0.4/cloud-reports`, fallback harrywinner2/flagship). Four
  builder agents started, worktrees `~/flagship-0.4-<slug>` on `0.4/<slug>` from `0ce68ca01`: **calls-phone** (iOS
  PushKit/CallKit + China no-ring, Android ConnectionService, `voici-call` push handlers, media behind an interface),
  **restore-ui** (webapp + Android restore-into-server screens, gym), **enterprise-servers** (invite-accept, org
  servers, offboarding rotations, audit export), **retail-image** (keyd identity at first boot, bluetoothd unit/group,
  parity row for Release this box). Agents may not run full suites or native builds; those go to the cloud session.

- 2026-11-14 late: Owner decisions. (1) **Video calling is in 0.4** (v2 §1); calls-phone agent re-scoped. (2) **No
  content-specific rules** (sex, nudity, etc.): only "no use in furtherance of anything illegal" + lawful takedowns;
  topic rules only if a store or government requires them. Recorded in `docs/voici-calls-v2.md`. Existing text found:
  Terms §8.2 bullet "nudity or sexual content, or graphic real-world violence" (`7accf8146`, 2026-11-07, on main) and
  the matching rules-sheet line (`voiciCopy.js` + native, `749a31e60`); asked the owner whether to remove them.

- 2026-11-14 late: Owner: "remove what goes further than our strict legal minimum". Terms §8.2 now says only: no use
  in furtherance of anything illegal (CSAM named, reported at once) + takedowns as the law requires; the rules sheet
  in webapp/iOS/Android, all 7 languages, says the same (release/0.4 `86739fc31`, docs `9b9e06aa6`, guard
  `scripts/rules-summary.test.ts` inverted). Terms on main `881f7757e` (pushed, NOT deployed: a `.com` deploy from main
  would also ship the undeployed mirror-domains and abuse-wording commits; asked the owner). Play content rating
  answers of 2026-11-07 assumed the old rule: re-answer with the next submission. Left alone: Terms §6 (acceptable
  use: malware, spam, phishing, DoS, IP); its spam bullet goes beyond the law, flagged to the owner.
  Enterprise Kotlin port: local Gradle green (OrgAuthorityVectorsTest 4/4, VoiciCallsVectorsTest 5/5), merged
  (`f871219ca`), org parity reds gone. Remaining parity reds: voici-call push handlers (ios/android) and web
  voici-call-allow / voici-missed-call: both handed to the calls-phone agent.

- 2026-11-14 late: **retail-image merged** (`763d6fbfc`..`a9f915b7a`): keyd makes a fresh identity on a retail box's
  first boot and after a wipe (tests: two boxes from one image differ; wiped box differs), BlueZ host files in
  `packages/boot-chain/src/retailHost.ts` + builder layer `retailImage.ts` (refuses an image carrying any key/owner/
  claim/BT identity), parity row `release-this-box` (webapp missing), doc §16. tsc, 15 targeted tests, i18n green;
  parity unchanged. Release-manager decisions: narrow D-Bus policy (7 BlueZ calls) + `flagship-powerkey` group
  instead of the `bluetooth`/`input` groups; build webapp "Release this box"; build the daemon start on an unclaimed
  image + post-claim first boot keeping keyd's key now, with a cloud-runnable QEMU + btvirt script. Agent resumed.

- 2026-11-15: **Cloud reports landed** (`origin/0.4/cloud-reports`, 01 full suite at 278596830, 02 enterprise Android).
  Green: tsc, Rust 837/0, Android 2970 (1 flaky Compose idle), Postgres 18 integration 11/11, enterprise-build Android
  2974/0. REAL failures (9): migration ledger 0141/0146, accountRename for voici call tables, **BoxClaimKey canonical
  field shift (AT-ENV-09, security)** + 17 unclassified tags, compat-matrix shell pin, gym ACME dir config, iOS mock in
  Release, Rust fmt + RUSTSEC-2026-0459/0486, CI cancel-in-progress. Fixer agent on `0.4/cloud-fixes`.
  **enterprise-servers merged** (`1e7fe2f79`..`88a55d937`): org server codes/registration, X-Wing org key ring with
  rotation on offboarding (box verifies under its pinned chain), signed audit export, `/org-join` route + webapp view,
  shell **v211**. 233 targeted tests, i18n, parity unchanged. Decisions: username claim checks orgs both ways; key
  split and approval weights accepted. Agent resumed: org install path, gossip org CGK, auditor CLI, Swift/Kotlin
  ports, phone-side rotations, iOS join screen (uncompiled code goes to the cloud). Calls agent was cut off by the Mac
  sleeping; resumed.

- 2026-11-15: **calls-phone merged** (`2c41c9641`..`5ffcb2e29`): video as an upgrade of the audio call (signed
  optional `media`, VP8, own video keys/counters, size-bucket padding, vectors TS/web/Swift/Kotlin), webapp missed calls
  + "Allow calls from them" (shell **v212**), iOS PushKit/CallKit + China no-ring (no VoIP token in the CN storefront),
  Android self-managed ConnectionService + full-screen CallStyle. Media is `StubCallMediaEngine` (no libwebrtc yet:
  owner decision). Swift/Kotlin NOT compiled (cloud Task 3 compiles Android; iOS needs Xcode here). tsc, 68 tests,
  i18n green; **parity: 0 red** for the first time in 0.4. Owner questions in `docs/voici-calls.md` open items:
  libwebrtc build, answering while locked (device-held call key?), D4 China legal check, calls settings UI.
  **retail-image tranche 2 merged** (`e0d59bbd0`..`502e27a39`): webapp "Release this box" (shell **v213**; classical
  signature, a strict box refuses and points to the phone), daemon unit on an unclaimed image running claim-only, first
  boot after a claim adopts keyd's key (`FLAGSHIP_BOX_KEY_IN_KEYD=1`), VM smoke `tools/retail-vm/run.sh` (cloud Task 3).
  tsc + 149 targeted tests green. Limits: daemon runs as root on an unclaimed box; a second claim after a wipe can't
  serve until the recovery partition exists (hardware). Cloud Task 3 sent: Android calls compile, retail VM, full suite.
  Restore-ui agent told to take shell v214.

- 2026-11-15: **restore-ui merged** (`89e3441e9`..`f74ba2035`): webapp + Android restore-into-server screens, gym
  `web-total-restore-merge-*`, shell **v214**; parity row present on all three. Android Kotlin NOT compiled (cloud).
  Agent resumed: hybrid `pqSignature` on iOS/Android restore orders (strict boxes refuse classical), webapp points
  to the phone on a strict box. Home "Into a server I have" entry deferred (no app has it).
  **cloud-fixes**: all 9 REAL items fixed on `0.4/cloud-fixes` (ledger 0141/0146, call tables renamed with the
  account, **BoxClaimKey field charset guards in TS/Swift/Kotlin + refuse vectors**, 17 tags classified + AT-ENV-31,
  gym ACME test stdin bug, iOS mock `#if DEBUG`, cargo fmt + rusqlite 0.41 / rustix 1.1.6, CI no cancel on
  main/release, deterministic wipe-verifier test). Release manager added `5cec6d383`: WEB_BUILD had stayed 210 through
  four shell bumps; now 214 with a guard. After rebasing, AT-ENV-10 fails on tags from the enterprise/calls merges:
  fixer resumed to classify them. Not merged yet.
  **retail tranche 3 merged** (`5aace11c1`): claim service runs as `flagship-claim` with heavy systemd hardening and
  no capabilities; root steps via privd `--profile retail-claim` (only `retail-wipe` and `retail-first-boot`, each
  checks preconditions; first boot only for a claimed recipe whose signature verifies). 36 targeted tests green.
  Accepted boundary (told the owner): a compromised claim process can fake a button press, but root only runs signed
  recipes. Wi-Fi join privilege waits for the hardware choice.

- 2026-11-15: **restore hybrid follow-up merged** (`..093ac5add`): box answers `403 needs-hybrid` to a classical admin
  restore order under strict (`authorizeRestoreOrder`), vectors gain a `hybrid` section, iOS/Android send
  `pqSignature` while any server is strict (uncompiled), webapp says to use the phone (shell **v215**). 72 targeted
  tests, i18n, parity 0 red. cloud-fixes must set WEB_BUILD 215 when it rebases.

- 2026-11-15: **cloud-fixes merged** (`..eb2b4c5ae`, 15 commits): the 9 REAL items, plus all new org tags classified
  with bespoke forgery tests AT-ENV-32..36 and a **second separator fix**: `orgLogEntryHash` and `orgKeyCommitment`
  hashed unchecked fields joined by `|` (`.com` could shift a field and keep the chained hash); now strict formats.
  WEB_BUILD/compat at 215 with a guard. 1134 targeted tests, parity 0 red.
  **enterprise tranche 2 merged** (`..569632620`): one namespace for usernames and org names; AT-ENV-40..45 org
  forgery tests; client rotations (`rotateOrgKey`) + offline auditor CLI `tools/org-audit/verify.ts`; org gossip on
  the ring's CGK (keyd boxes take only the first version); org install path (`flagship/org-install-blob/v1`, box
  config with orgId + genesis and a zero IRK nobody holds); Swift/Kotlin ports; iOS join screen + admin "codes match:
  admit". Rebase conflict was only the generated preseed engine/goldens/bootstrap pin (retail + org both changed the
  bootstrap): regenerated with `scripts/box-release-regen.mjs`, 112 installer tests green; 1255 targeted tests,
  i18n, parity 0 red. Swift/Kotlin uncompiled. Open: LUKS re-key, Android join screen, iOS "Rotate keys" button,
  keyd adopting a rotated CGK, pseudonyms for admins (needs the org directory key), org install timeline, box log
  heads in the export. Owner Qs: webapp seat keys (design says view-and-collect only: kept), where admins see
  pseudonyms. Housekeeping: killed two orphaned Kotlin daemons (one ran 28 h, ~8 cores).

- 2026-11-15: **Native builds on this Mac** (load dropped to ~3.5 after the agents finished): iOS `FlagshipApp`
  simulator build failed once (`VoiciCallCenter.swift:123` String vs UTF8View; fixed `246e045d4`), then **BUILD
  SUCCEEDED**. Android `:app:compileDebugKotlin` + unit-test compile **green**; Android tests for Voici/RestoreMerge/
  Org/BoxClaim/ReleaseThisBox **71/71**. Shared Swift tests (same filter) failed to compile: the hybrid restore test
  sat inside a private `Data` extension; moved, **50/50**. Not yet run: the iOS app-package tests (FlagshipUI view
  models), Wear, the full Android suite, gym specs.

- 2026-11-15: iOS package tests (`FlagshipMobile-Package` on the iPhone 17 Pro simulator; `swift test` can't build
  UIKit on the Mac host): RestoreMergeViewModelTests + ReleaseThisBoxViewModelTests **13/13**. No view-model tests
  exist yet for the iOS org join screen or the call screens. Next round: enterprise tranche 3 and calls tranche 2.

- 2026-11-15: Two builder agents started from `ddfc77100`: **enterprise-3** (Android org join screen + `/org-join`
  claim, iOS/Android "Rotate keys", keyd adopting a rotated CGK via a verified ring version (TS + Rust), org install
  timeline, box-signed log heads in the audit export, view-model tests) and **calls-2** (calls settings + missed-call
  rows on iOS/Android, phone TURN responder / endpoint demux / relay bare-name forwarding where no libwebrtc is
  needed, view-model tests, mock gym lanes). Load is low, so agents compile natively, serialised by the lock
  `/private/tmp/claude-501/flagship-locks/native-build.lock`.

- 2026-11-15: **Cloud report 03** (Task 3): Android at 5ffcb2e29 compiles and assembles (app + wear), 2975 tests, only
  ENV/FLAKY failures (Android unit tests need root `node_modules`). Retail VM script NOT run: no `/dev/kvm` in the
  cloud container (btvirt is in Ubuntu's bluez-test-tools; Debian unverified): the VM run needs a KVM host (UpCloud or
  the Mac's Linux VM). New REAL failures, rechecked at the tip: two stale retail tests and the N06 key ratchet missing
  `lib/orgJoin.js` (fixed here); `mobile-clients-inventory`: the call code builds raw HTTP clients outside the pinning
  factory (iOS VoiciCallCenter/VoiciCallSession, Android VoiciCallCenter) → handed to the calls-2 agent.
  calls-2 has 5 commits so far; enterprise-3 has the Android join screen committed.

- 2026-11-15: **Owner answers.**
  - **Terms (legal minimum)** deploy with 0.4, not before.
  - **Spam rules:** asked what they are; quoted Terms §6 to the owner (decision pending).
  - **WebRTC:** asked for options with pros and cons; written to `docs/voici-calls-webrtc-options.md`. Recommended
    a pinned LiveKit prebuilt now and our own libwebrtc build before GA. Quantum safety comes from the X-Wing frame
    layer, so DTLS 1.3 with a PQ group is no longer a requirement.
  - **Answering while locked:** a setting on the Social page, off by default. Designed in `docs/voici-calls.md`
    "Owner decisions, 2026-11-15" (a call-only device key bound by `flagship/voici-call-key/v1`).
  - **Webapp keys:** debate written to `docs/webapp-key-custody.md`. Proposal: allow full seats, labelled software
    custody, passkey-wrapped, an ML-DSA WASM module, a signed (verifiable) shell before GA, and bylaws that can
    require hardware approvals.
  - **Directory:** yes, with connectors; design in `docs/org-directory.md` (sealed directory, a SCIM 2.0 server and
    an LDAP pull on an org box, connectors only propose, a `DirectorySource` interface for developers).
  - Release-manager calls: Do Not Disturb stays per device; only admin devices change call settings.
  **calls-2** reported: calls settings, missed-call rows, call-allow on iOS/Android, `CallTurnGate` demux, mock gym,
  call HTTP through the pinning factories, and a bug fix (every publish now keeps the page index's call settings).
  Shell v216. iOS build plus 14 package tests and the Android unit tests are green. `flagship-turn-lite` is not
  linked (that waits on the WebRTC choice).

- 2026-11-15: **enterprise-3 merged** (`..917650314`, 8 commits): Android join and admit plus an Organizations
  entry; "Rotate keys" on iOS/Android (the phone works out who left from the chain it verified itself); keyd adopts a
  rotated CGK only after its own check (`cgk.orgAdopt`, TS `orgCgk.ts` = Rust `org_cgk.rs` on 24 shared vectors);
  org install timeline; hash-chained box Activity with STK-signed log heads (`flagship/org-box-log-head/v1`) in the
  audit export. 1291 targeted tests, cargo keyd, i18n and parity green; iOS builds plus 8 view-model tests, Android
  tests green (agent ran them). Release-manager calls on its questions:
  - a member seat announces its KEM key at join (yes: otherwise rotations skip it);
  - a D1 index on `org_objects` for the serial lookup (yes; migration 0148, leaving 0147 to the calls key work);
  - a full org-chain verifier in Rust keyd (yes, later; until then such boxes keep the old CGK until the next boot
    ceremony). Recorded in `docs/enterprise-accounts.md` by the next agent.
  Next: the org directory + connectors agent (`docs/org-directory.md`), plus Android create/invite/freeze.

- 2026-11-15: **Locked answering merged** (`..3a39d7fc7`, migration **0147** `voici_call_keys`): a call-only P-256
  device key bound by `flagship/voici-call-key/v1`, a revocation, and `flagship/voici-call-join/v1` (a locked phone
  can't sign device headers). 1152 targeted tests, i18n and parity green; iOS package and Android tests per the agent.
  **Owner (2026-11-15, second round): "I agree with all your choices and defaults."**
  - **Every feature lands with 0.4**, including the webapp safety upgrades and **our own build of Google's
    libwebrtc** (option A; no vendor prebuilt).
  - Calls must work from the voi.ci page in browsers, and the owner must be able to **call back from the Social page**
    (the phone's browser is an acceptable fallback). Design: `docs/voici-calls.md` "Calling back".
  - Defaults now binding: directory members see only what they share; SCIM tokens per connector, rotated by hand,
    with a warning at 365 days; webapp custody proposal 1-6; Do Not Disturb per device; call settings admin-only;
    the join record accepted; `.com` drops a call-key binding when its device grant is revoked.
  - Still asked: the Terms §6 spam bullet (keep, trim to unlawful, or remove).
  **Agents started** from `fc5d721f2`:
  - `libwebrtc`: a CI build of Google libwebrtc (iOS xcframework + Android AAR, checksums, artifacts only; hosting
    is an owner step), real `CallMediaEngine` on both phones, TURN responder linked, a media CI lane;
  - `calls-callback`: browser calling verified with Playwright, call back from the thread and missed-call row, the
    browser handoff fallback, webapp call back, call-key binding dropped on grant revoke (shell v217, migration 0149
    if needed);
  - `webapp-custody`: proposal 1-6 (shell v218, migration 0150 if needed).
  `org-directory` is still running (migration 0148, shell v219 if needed).

- 2026-11-15: Owner: **keep the Terms §6 spam rules**. "Call back" means starting a call from the app's call and chat
  logs (conversation list, thread, call history), not via the voi.ci page; told the calls-callback agent, doc
  updated. Owner asked why the libwebrtc libraries need hosting: explained (they are compiled into the apps, and the
  hosting question is only where our build machines fetch the pinned binary from); options written in
  `docs/voici-calls-webrtc-options.md` "Where the built library lives".

- 2026-11-15: **Disk full (ENOSPC)** stopped every agent mid-work. The owner cleaned up from a normal Terminal (a `!`
  command can't run while Claude Code's own temporary folder is full). libwebrtc and webapp-custody were paused,
  then resumed with disk rules: no local libwebrtc build, a `df` check before big steps, stop under 5 GB. Lesson: Xcode
  derived data, the Swift `.build` folders and downloaded CI artifacts fill this Mac fast.
  **org-directory merged** (`..92a2c9884`): D1 **0148** index; sealed directory entries; connectors and proposals
  that take effect only through admin orders; seat KEM key sent at join; Android create/invite/freeze; pseudonyms
  replace "Seat <id>"; SCIM 2.0 and LDAP pull (`ldapts@9.2.0`) on the org box; the `DirectorySource` guide
  `docs/directory-connectors.md`; the iOS/Android directory console. 1435 targeted tests, i18n and parity green.
  Release-manager decisions: connector setup through the admin's phone OK; an approver leaving flags the connector
  for re-approval (7-day grace, then suspended); members get their directory slice in 0.4. The agent is resumed to
  close every console gap (LDAP form, mapping editor, pause/retire/rotate, role-change execution, per-request SCIM
  audit, OpenLDAP CI, the member view).
  **Calls, pseudonymity (owner):** "impossible to be pseudonymous AND keep direct-to-phone": correct for the callee
  direction. Proposed: the pseudonymous side always dials out and the public side hosts; default A (no ring, "tried
  to call you · Call back"); B (ring by the visitor's opt-in, policy-only unlinkability at `.com`); drop the card (C).
  Waiting on the owner. calls-callback resumed on the parts that don't depend on it (calling known pages from the
  app, call history, call-key cleanup on revoke, a Playwright browser call, webapp handoff, a check whether the relay
  leaks visitor IPs).

## Resume point

State (2026-11-15): `release/0.4` holds everything merged so far:
- calls: rings on iOS/Android, video, missed calls, settings;
- restore into a server (iOS, Android, webapp; hybrid for strict boxes);
- enterprise: org servers, key ring and rotations, audit export, install path, iOS join;
- retail: identity at first boot, BlueZ with least privilege, unprivileged claim service, webapp Release;
- the cloud-report fixes.

Parity has 0 red. Shell is v215 (v216 arrives with calls-2). Nothing is deployed; only `main` deploys, and the terms
change ships with 0.4.

Next steps for whoever resumes:
1. **Merge any agent branch that reported** (worktrees `~/flagship-0.4-<slug>`, branches `0.4/<slug>`):
   - Running: `org-directory` (gap closure), `libwebrtc`, `calls-callback`, `webapp-custody` (reserved: shells v217/v218/v219,
     migrations 0148 directory, 0149 callback, 0150 custody). `calls-2` (incl. locked answering) is merged.
   - `enterprise-3` merged; `org-directory` agent next (directory + SCIM/LDAP connectors, KEM at join, index 0148,
     Android create/invite/freeze).
   - Merge rule: run `scratchpad/rebase-i18n.sh` (or rebase by hand). Never commit conflict markers. On a shell
     clash, take the next number and move WEB_BUILD plus `release/compatibility.json` with it (the compat-matrix
     test guards this). Generated installer files (preseed engine, goldens, bootstrap pin): regenerate with
     `node scripts/box-release-regen.mjs`. Then run tsc, the touched tests, `npm run i18n` and `npm run parity`;
     fast-forward and push.
2. **Cloud session** (`Session ID for inter-session communication`, cloud): it reports on `origin/0.4/cloud-reports`
   (`cloud-reports/NN-*.md`). It has no KVM, so the retail VM test (`tools/retail-vm/run.sh`) needs another Linux
   KVM host. It has no Xcode; iOS builds run on this Mac (commands in the 2026-11-15 log entries; native builds are
   serialised by `/private/tmp/claude-501/flagship-locks/native-build.lock`).
3. **Build next** (designs on disk):
   - org directory + SCIM/LDAP connectors (`docs/org-directory.md` §8 build order);
   - answering while locked (`docs/voici-calls.md`, owner decisions 2026-11-15);
   - `voici-call-allow/v1` missing from `tools/adversarial/tests/support/tagInventory.ts`;
   - (decided and running: libwebrtc option A, the media engine, flagship-turn-lite, webapp custody 1-6, call back.)
4. **Waiting on the owner:** calls to pseudonymous visitors (A no-ring default + B opt-in ring?); where the built libwebrtc binary lives (options in the WebRTC doc); signing the webapp shell
   at release; a KVM host for the retail VM test; plus the older questions in the 2026-11-14 entries (co-manager caps,
   enterprise formulas, calls v2, retail untrusted, direct names, voi.ci name caps, payments, wired fleet).
5. **Not run yet:** the full vitest and Android suites on the newest tip (send to the cloud), the iOS mock gym, the
   Playwright gym specs, and anything on a real box or phone.
