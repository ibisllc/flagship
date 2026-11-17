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

- 2026-11-15: Owner proposed the page call modes ("anyone on the internet" or "callback accounts only"; enabling calls
  = consent to ring) on condition that the mailbox can't be tied to a phone. The release manager explained that push
  tokens would tie it at `.com`, and proposed a **sealed-token push relay** (split trust). Written as a proposal in
  `docs/voici-calls.md`; waiting on the owner's yes.
  **libwebrtc** agent finished code, not pushed: M157 pin, frame-crypto overlay, CI workflow
  `.github/workflows/libwebrtc.yml` (iOS xcframework + Android AAR, artifacts only), `flagship-turn-ffi` (a C/JNI
  boundary for `flagship-turn-lite`, the only place `unsafe` is allowed), real `CallMediaEngine` on iOS/Android,
  `tools/libwebrtc/use-artifacts.sh` (checksum pin `tools/libwebrtc/artifacts.sha256`, empty until a reviewed run),
  media CI lanes. The release manager pushed `0.4/libwebrtc` to start the first CI run (43756120375); expect fix
  rounds. Not merged yet (merge after CI is green).

- 2026-11-15: Owner **approved the call design** (page modes, ring-back via the mailbox, sealed-token push relay) and
  added the **call-back pop-up** before a call on anyone-may-call pages. Push relay cost: about $0 inside the existing
  Fly relay (recommended); recorded in `docs/voici-calls.md`. calls-callback agent told to build it all (behind a
  flag; all push paths through the relay; no deployed config touched).
  libwebrtc CI run 1 (43756120375): TURN libs green; WebRTC jobs failed (`--output-dir`/`--build-dir` must be under
  `src/`). Agent resumed to iterate until green, then record the pin.

- 2026-11-15: Owner: the push relay runs on the Fly relay **as an onion path over the relay mesh** (more independent
  relays = deeper obfuscation). Designed in `docs/voici-calls.md` "Push relay over the relay network": Flagship-run
  exits hold the APNs/FCM keys; outside relays are entry/middle hops; per-hop delay and padding; one relay today = the
  entry is also the exit. Sent to calls-callback (split into its own branch if too big). Owner **approved hosting
  libwebrtc on GitHub**: after a green CI run, a pre-release `libwebrtc-<milestone>-<run>` with checksums, apps pinned
  by URL + SHA-256 (sent to the libwebrtc agent).

- 2026-11-15: **Cloud report 04** (at 612abfd7a): tsc, vitest **17941 passed / 0 failed**, i18n, parity, cargo fmt/test
  (839/0), cargo deny clean, Android app + wear builds, 3016 Android tests (1 known flaky
  `ModelMenuComposeTest.stagedAttachmentsWithNotice`). REAL: Rust CI clippy gate failed in flagship-keyd; the
  cloud's fix was cherry-picked (`e46b6eb88`), workspace clippy clean here. Cloud task 5 sent: fix the Compose flake,
  run the webapp Playwright gym specs, and an independent adversarial review of the new 0.4 protocol code (call keys,
  org directory/connectors, keyd org CGK, log heads, retail claim helper).

- 2026-11-15: **webapp-custody merged** (shell **v218**, no migration): passkey-PRF wrap of the admin root and an ML-DSA
  seed, opened per signature (`lib/keyCustody.js`); ML-DSA-65 in WebAssembly from mldsa-native v2.0.0, pinned by
  SHA-256 (`tools/mldsa-wasm/build.sh --check`); hybrid on Release this box and restore; signed shell manifest
  (`lib/shellTrust.js`, `scripts/webapp-shell.ts`), `SHELL_SIGNATURE_REQUIRED=false` until the **owner signs a
  release shell** (steps in `docs/webapp-key-custody.md` "Signing a release shell"); `custody: "browser"` on org
  records and the `adminCustody` / `quorumHardware` bylaws in TS and on `.com`. The release manager added allowlist
  entries for the browser-only tags. 1445 targeted tests, tsc, i18n, parity 0 red. Agent resumed: Swift/Kotlin
  custody ports, the webapp as a full org seat, hybrid on the other web orders, gym with a virtual PRF passkey.

- 2026-11-15: Owner: **no security cosplay**. Flagship runs `.com`, the relays and the push exits, so onion routing and
  a sealed-token relay hide nothing from us. Both dropped (doc "Correction"). The honest promise: the page owner never
  learns the caller; "Call and allow call-back" says Flagship will know the conversation can ring that phone; no
  who-called-whom log; the ring-back channel is deleted on stop. calls-callback agent told.

- 2026-11-15: Owner: **delete = forget, no logs, reveal who I am** (`docs/voici-calls.md` last section). Deleting a
  conversation on either side sends a signed delete; `.com` drops the mailbox, queued messages and ring-back channel
  with no archive or tombstone; the other side sees "This conversation was ended" (its own copy stays on its device,
  and the sheet says so). No logs of mailboxes, messages, rings or deletes. The caller's conversation settings get
  "Show <name> who I am": a `flagship/voici-reveal/v1` signed by the caller's page key, sent sealed inside the
  conversation; the owner's app verifies it against `.com`'s page key and shows a pill; turning it off removes the
  pill (the sheet warns it may already have been seen). Given to the calls-callback agent.

- 2026-11-16: Owner: the reveal shows `Display Name (username)` or `username`, with an **info icon by every printed
  chosen name**: "This is a name the person chose. Flagship doesn't check names, so anyone can use any name." Idea
  for later (possibly paid): `.com`-signed plain-text **verification notes** ("We checked that this account controls
  nike.com"), no links and never fetched by the viewer: the caller carries the note inside the reveal. Not in 0.4
  unless the owner says so (doc: "What the reveal shows").

- 2026-11-16: **org-directory round two merged** (no migration, no shell bump). Connector re-approval (flagged when
  every approver stops being an org admin, works 7 days, then suspended until an admin approves again); members'
  directory slices (`flagship/org-directory-slice/v1`, `GET/POST /api/orgs/<id>/directory/slices`, admin-approved,
  checked by the member's phone); partial connector setups; content-free SCIM audit lines; `openldap` CI job (not run
  yet); iOS and Android: "Shared with", "Approve again", role-change execution, pause/resume/retire, token rotation,
  mapping editor, LDAP form. The rebase dropped the 4 custody allowlist entries; restored (`Parity: keep the browser
  custody tags`). tsc, i18n, parity 0 red; agent's 1234 TS + Swift 7 + iOS 15 + Android 25 tests. Local
  `peerBackupNetwork.sim` times out under build load on release/0.4 too (cloud run green): not this branch. Open: the
  webapp directory pieces wait for webapp-custody (hooks in `docs/org-directory.md` "Webapp hooks").

- 2026-11-16: **calls-callback checkpoint** (pushed, not merged: the iOS/Android forks' native work is uncommitted in
  its worktree). Built: call-key cleanup on revoke, the browser handoff (`voici-call-handoff/v1`), the Playwright lane
  (3 cases), the webapp Calls view (shell **v219**), page call modes `anyone`/`callback`, anonymous requests with a
  `.com`-MACed proof of work (needs secret `VOICI_CALL_POW_SECRET`), the ring-back channel and the owner's ring
  (`voici-ring-back/v1`, `voici-ring/v1`, D1 **0149**), the voi.ci pop-up with the honest sentence, delete = forget
  (`voici-conv-delete/v1`, zero rows test), the reveal record. Envelope forgery 1121/1121. Found: privacy §2.11 says
  the owner's phone sees the caller's IP; no relay passes it. Release-manager decisions on its questions (doc
  "Release-manager decisions"): delete keeps nothing; reveal switch in an app caller-side conversation screen;
  anonymous hours + blocking in 0.4; `.com` flags `ringBack` on inbox items. Agent resumed for the `.com`/webapp
  half; the forks for native.

- 2026-11-16: Owner approved the privacy wording fix for 0.4: §2.11 now says "Our relay doesn't pass your IP
  address on: the page owner's phone sees only the relay." (Last updated 2026-11-16; not deployed, ships with 0.4.)
  Found while testing it: 20 webapp tests fail on release/0.4 itself (`webappCoManagerInvites`,
  `webappShareServerFlows`: "Couldn't read your invites from this server"); given to the webapp-custody agent.
  All agents hit the usage limit and were resumed.

- 2026-11-16: The 20 failing share tests were stale `dist/` in `~/flagship-0.4` (packages built before the custody
  merge); after `npm i` (adds `ldapts`) and `npx tsc -b` they pass (44/44). Rule: rebuild `dist` in a worktree after
  a merge that changes packages before trusting its webapp tests.
- 2026-11-16: **webapp-custody round two merged** (shell **v220**, no migration). Swift/Kotlin `custody` and custody
  bylaws with browser-seat vectors (5/5 each); the webapp as a full org seat (`lib/orgSeat.js`: join with the 6-digit
  code, admin key under the passkey, approvals, admit, rotate); the org-directory console in the webapp
  (`lib/orgDirectoryConsole.js`; 30 parity allowlist entries removed; mapping editor is text lines); hybrid server
  order, direct access, direct names and update orders from the web, and the strict opt-in (re-entry stays on the
  phone); gym `gym-custody.spec.ts` with Chrome's virtual PRF passkey (3/3). `SHELL_SIGNATURE_REQUIRED` still false.
  Checks here: tsc, i18n, parity 0 red, vitest web + protocol + .com 7028/0. Not run: a real browser against a real
  `.com`/box; the iOS app build (only `OrgViewModel.swift` changed). calls-callback renumbers to v221 at its merge.

- 2026-11-16: **libwebrtc merged** (option A, our own build). CI `.github/workflows/libwebrtc.yml` green on run
  43884507084 (7 jobs: webrtc + TURN for iOS and Android, package, media tests). Pin `tools/libwebrtc/artifacts.sha256`
  (WebRTC.xcframework.zip 198 MB, libwebrtc.aar 38 MB, FlagshipTurn.xcframework.zip 19 MB, flagship-turn-android.zip).
  Built locally against those exact files: Android APK carries the WebRTC and TURN .so for 3 ABIs, call unit tests
  pass; iOS `CallMediaBundledTests` 2/2 (real engine linked, TURN answers STUN, refuses HTTP). Fixes: build dirs inside
  `src/`, Chromium Java 25 patched to 17 (`apply-overlay.py`), `SHA256SUMS` now lists all four files.
  **Blocked on the owner:** the agent's `gh release create libwebrtc-157-43884507084` (pre-release on
  ibisllc/flagship, target `6a687243f`) was refused by the permission system; the owner approved GitHub hosting, but
  the command needs the owner to run or approve it. Files ready in the scratchpad `rel/` folder (244 MB). Until then
  the apps build with `StubCallMediaEngine` unless `tools/libwebrtc/use-artifacts.sh` unpacks a CI run. After the
  release: `tools/libwebrtc/pin-release.sh libwebrtc-157-43884507084`, build both apps once, commit `release.env` and
  `Package.swift`. Open: builds not byte-reproducible (pin names one run), no browser-to-phone call yet, the caller's
  video not shown in the call screens, DTLS 1.3 PQ group unchecked (not required).

- 2026-11-16: Owner created the pre-release `libwebrtc-157-43884507084`. **libwebrtc pin merged** (`5223a9ab0`): both
  apps download the libraries from it, checked by SHA-256 (`tools/libwebrtc/release.env`, `Package.swift`). Built
  here against the download: Android APK with the WebRTC + TURN libraries, call tests pass; iOS app embeds
  WebRTC.framework, `CallMediaBundledTests` 2/2. App CI jobs now download ~255 MB on a cold cache.
- 2026-11-16: **calls-callback merged** (shell **v221**, D1 **0149**). TS/.com/webapp plus iOS (3 commits, app builds,
  shared Swift 25 + iOS 28 tests) and Android (8 commits, compile + call/voici/push unit tests). Calls from the apps'
  logs (handoff to a voi.ci tab until the engine takes the caller side), ringing callers back, call modes and the
  call-back pop-up, anonymous calls with proof of work and blocking, delete = forget, reveal + name pill with the
  unchecked-name info sheet, call hours. Rebase: shell renumbered to v221 after custody's v220; a first rebase loop
  committed conflict markers into `buildInfo.js` / `service-worker.js`, fixed in the v221 commit; key inventory gains
  `lib/voiciCallOut.js` (a 9-minute P-256 visitor session key). Checks: tsc, i18n, parity 0 red, web 3647, protocol +
  calls 2614, forgery 1121. Not run: gym UI tests (iOS, Android), any device, a real browser-to-phone call.
- 2026-11-16: Owner: **call hours are enforced on the phone only (option c)**: nothing about hours is published (the
  page index's `callHours` would show the owner's time zone); outside hours the phone doesn't ring and logs a missed
  call. Being built.
- 2026-11-16: Owner: **Fly costs** ($18 bill; 23 accounts, 11 servers). Approved: take the two gym relays off between
  gym runs (scanners kept waking them through auto-start since 2026-11-09) and run the gym IPv6-only (release
  `flagship-services-gym`'s dedicated IPv4, $2/mo). Saves ~$8.40/mo; production stays one 512 MB machine + one IPv4.
- 2026-11-16: Fly cut done on `main` (`eb43ae84c`): `scripts/gym-relays.sh on|off|status`; both gym relay
  machines stopped with autostart off (verified they stay down under probes); gym-refresh / gym-weekly /
  gym-release-run turn them on and off. **IPv6-only blocked:** UpCloud gym boxes are created IPv4-only
  (`apps/com/src/upcloud.ts`, `tools/live-e2e/lib/upcloudVm.ts`, `isoBox.ts`) and `.com`'s zone-health / DNS sweep /
  route-gc need `SERVICES_PASSTHROUGH_IPV4`, so 137.66.62.214 stays ($2/mo). Saving now ~$6-7/mo. A hand-run
  `shared-run.ts` needs `gym-relays.sh on` first.
- 2026-11-16: **Calls round 3 merged** (shell v221, D1 **0150** `voici_call_settings`). Call hours (owner option c):
  out of the page index (a v2 index carrying `callHours` is `malformed`), an owner-device setting sealed under a
  UMK-derived key (`flagship/voici-call-settings/v1`, `GET/PUT /api/accounts/<u>/voici-call-settings`, ciphertext
  only on `.com`, newer `updatedAt` wins), enforced by the ringing phone from its own copy (no ring, missed call; the
  caller sees "No answer"). iOS and Android place in-app calls and answer ring-backs through the real WebRTC engine
  (browser handoff only as a fallback); iOS asks "Let voi.ci/<name> call you back?" before a call. Checks: tsc, i18n,
  parity 0 red, vitest 6262; Android call/voici/push tests; shared Swift 22 + iOS 28; iOS app builds against the
  release's WebRTC. Not run: gym UI tests, any device, a real browser-to-phone or phone-to-phone call.

- 2026-11-16: **conv-forget merged** (shell **v222**, no migration, no `.com` change). Delete = forget on all the
  owner's devices: Messages state v2 adds `forgotten: {conv: {at, pseudonymPub}}` (still written as v1 without
  markers); the newer marker wins over older entries at merge, markers expire after 30 days; each device drops
  everything it holds for that conversation the first time it sees a new marker (messages, reveal, ring-back,
  missed calls, call records; caller side too). TS, webapp, flagship-web (voi.ci site rebuilt), Swift, Kotlin, shared
  vectors, parity row `voici-conv-forget`. Checks: tsc, i18n, parity 0 red, vitest web + protocol 6074; Swift 12, iOS
  21, iOS app builds; Android 91. Open: a device offline > 30 days after a delete can bring entries back once; older
  iOS "deletes" stay archived only; old builds can't read v2 (pre-release: accepted).
- 2026-11-16: **Retail VM test runs in GitHub Actions** (branch `0.4/retail-ci`, not merged):
  `.github/workflows/retail-vm.yml` on `ubuntu-24.04` with KVM, ~4 min, green. It found one real bug, fixed: the
  claim unit's `ReadWritePaths=/var/lib/flagship-retail` failed every start with 226/NAMESPACE on a fresh image (now
  `StateDirectory=`). Test-only fixes: the guest reads the journal with `--merge` (the layer empties machine-id) and
  triggers the power key udev rule (no reboot). No KVM host needed any more.

- 2026-11-16: Owner: **deleting a conversation is gated by biometrics** (agent on `0.4/delete-gate`: Face ID /
  BiometricPrompt, passkey user verification on the webapp). Retail VM test moves to **GitHub Actions** (standard
  Linux runners have KVM; agent on `0.4/retail-ci`), so no KVM host is needed from the owner. Webapp shell signing:
  not yet, the signature covers the exact final files on `main` after 0.4 merges there.

- 2026-11-16: Owner **networking vision**: natively IPv6 end to end, IPv4 supported, and any transport that offers a
  connection (Freenet named). Written up in `docs/networking-vision.md` (principles, every IPv4 assumption found so
  far, a transport survey, the shape of the work). Proposed: the IPv6-native pass in 0.4; overlay transports
  (Yggdrasil, Tor onion reachability, a Freenet prototype for voi.ci) after, one at a time.

- 2026-11-16: **Gym call test bring-up** (branch `gym-0.4` = release/0.4 + gym commits + `eb43ae84c`; worktree
  `~/flagship-gym-0.4`). Gym D1: 18 pending migrations applied (through 0150). Gym Worker `flagship-com-gym` deployed
  from `gym-0.4` (version `9d3e3e01`), APNs secrets for bundle `com.flagshipserver.app.gym` (production APNs: the
  key `FHZWTBFQCM` is refused by the sandbox), `VOICI_CALL_POW_SECRET` set. Gym relay deployed from `gym-0.4` (v85,
  Rust, mesh); **gym relays left ON for the owner's test** (`scripts/gym-relays.sh off` after). iPhone "Flagship
  Gym" app (separate bundle id, own keychain, never over the production app): `scripts/gym-ios-device.sh` (ad hoc
  export for production push tokens). **Blocked:** Apple requires the owner to accept the new Program License
  Agreement before it registers the new app id.

- 2026-11-16: **delete-gate merged** (shell **v223**). Deleting a conversation asks Face ID / Touch ID or the
  passcode on iOS (`DestructiveAuth.askToDeleteConversation`), the BiometricPrompt on Android (as Sign out), and a
  passkey assertion with UV on the webapp (passphrase if the browser has no custody passkey). A cancelled prompt
  deletes and sends nothing (tests on all three). A phone with no screen lock deletes without a prompt (same rule as
  Sign out). Checks: tsc, i18n, parity 0 red, web 3655; Android 7/7, iOS 6/6, iOS app builds.

- 2026-11-16: Owner accepted Apple's new Program License Agreement. **Flagship Gym installed on the owner's iPhone 14
  Pro** (bundle `com.flagshipserver.app.gym`, production push, `gym-0.4` at `c5ac57a5b`). Two build fixes on the way:
  `BoxRelease.sequence` is now `Int64` in Swift (a dated sequence overflowed the watch's 32-bit Int; fixed in the
  generator on release/0.4, `629869b84` on gym-0.4); the gym-only `GymLiveAdoption` dropped the removed
  `DeveloperSettings`. Owner's live call test next; gym relays ON until it ends.

- 2026-11-16: Owner's call test on the gym: the browser rang, the phone never did; calls ended as missed. Cause:
  APNs answers `TopicDisallowed` for the phone's real PushKit token on `com.flagshipserver.app.gym(.voip)` with key
  `FHZWTBFQCM` (production-only and apparently topic-restricted). **Owner action:** add the gym bundle to that key or
  make a new team-wide Sandbox & Production APNs key; then set the gym Worker's `APNS_*` secrets and test-push before
  calling again. A government device showed "Couldn't reach Flagship" on the caller page (likely its network).
- 2026-11-16: **secure-screen merged** (shell **v224**). "Secure your account": the big title is gone (iOS; the webapp
  keeps its card title, it has no nav bar), the explainer ends "We cannot recover it for you.", cloud backup and
  backup file are two independent unchecked options (the passphrase shows only while cloud is ticked), and the skip
  warning is anchored to the Skip button (popover on iOS and webapp, dropdown on Android). Translated in 6 languages.
  Checks: tsc, i18n, parity 0 red, web 3655; Android 17, iOS 6 + onboarding UI tests. Open: the web gym onboarding
  spec never gets past "Setting up…" on release/0.4 (pre-existing).
- 2026-11-16: Owner: **a page made public defaults to calls from signed-in (non-anonymous) people on, and messages
  on.** Queued.

- 2026-11-16: The old APNs key `FHZWTBFQCM` kept answering `TopicDisallowed` for the gym app even after the owner
  added the topic. The owner made a new team-wide Sandbox & Production key **`Z274PT8G76`**; a test VoIP push to the
  phone returned 200. The gym Worker now uses it (`APNS_KEY_ID`, `APNS_PRIVATE_KEY_PEM`). Production still uses
  `FHZWTBFQCM` (it only serves `com.flagshipserver.app`); consider moving production to the new key at release.
- 2026-11-16: voi.ci page: a device with no microphone (e.g. a Mac mini) now says "No microphone found on this
  device. Connect one, or call from your phone." instead of asking to allow it (`382951b13`, 6 languages).

- 2026-11-16: **page-defaults merged** (shell **v225**). A page's first publish turns on messages and calls from
  signed-in people (`callsFrom: "signed-in"`, not anonymous); re-publishing keeps the owner's choices; the first-publish
  warning says so. iOS and Android pickers gain "Anyone signed in with Flagship". Found and fixed: iOS sent its VoIP
  token only at unlock with a page present, so a phone that just published its first page wouldn't ring until the
  next unlock; it now sends it as soon as calls come on. Checks: tsc, i18n, parity 0 red, vitest 6163; Android 3072;
  iOS 38, app builds.

- 2026-11-16: Live gym test: the phone rang for ~1 s and dropped an anonymous call. Phone log: the app closed the room
  socket ~5 ms after joining, i.e. it refused the request itself. Cause: the phone checked the anonymous request
  against a stale or missing copy of the page's call mode (iOS locked path never set `callsFrom`, default
  "accepted"; unlocked paths on iOS and Android read a cached index refreshed only while Social is open).
  **anon-fix merged** (`2346e1184`): when the local copy refuses on the mode, the phone reads the page's live mode
  once (checked under the account key, no rollback) and checks again; every early call end logs a reason code
  (iOS `Logger` subsystem `com.flagshipserver.app` category `calls`, Android tag `FlagshipCalls`). Browser-built
  anonymous requests are now a shared vector (`voici-call-modes/browser-built.json`). Carried to `gym-0.4`
  (`cc69cc67b`); the built gym app awaits install (phone unreachable).

- 2026-11-16: **gym-onboard merged** (shell **v226**). Real user bugs found by the webapp gym:
  - **The webapp didn't start at all on release/0.4**: `lib/voiciOwner.js` imported `checkVoiciPageIndex` twice
    (from `b34cf9971`), a SyntaxError, so no module loaded and every browser stayed on "Setting up…". Fixed, and
    `apps/web/tests/webappModulesParse.test.ts` now parses every shell file so vitest catches this class of break.
  - Home ignored the first tap (an empty allowance card shifted the button inside its 450 ms guard). Fixed.
  - Confirm boxes opened from inside a modal dialog sat behind it (Restore's Undo). They now open in the top dialog.
  Test-only: onboarding uses the virtual PRF passkey on localhost (`gymKit.passkeyAuthenticator`); four specs updated
  to the current shell. Whole webapp gym 375/375; vitest 3661; tsc, i18n, parity 0 red.

- 2026-11-16: Live gym test after anon-fix: ringing and answering work; both sides then stay on "Connecting…" (no
  media). Relay log: the phone holds `fleet-perch.gym.flagship.services` (generation 11), then Fly proxy
  `tcp-backhaul: unexpected end of file` every ~8 s: connections to the phone route die. Agent on `0.4/media-fix`
  to find and fix the break and redeploy the gym. Owner request: a one-line connecting progress ("Reaching their
  phone…", "Securing the line (quantum-safe)…", …) on both sides, with a slow-step hint.

- 2026-11-16: **media-fix** (branch `0.4/media-fix`, not merged yet; on the gym and the owner's iPhone): the phone held
  its bare-name tunnel only in the foreground, so a call answered from CallKit had no TURN route and sat on
  "Connecting…". Now the tunnel opens when a call rings and stays open until it ends; the answer waits up to 8 s for
  the route (iOS + Android, `PhoneRouteLifecycle`). Also the connecting steps on both sides (voi.ci caller page,
  iOS, Android), a slow-step hint at 20 s and a give-up at 45 s. Known limits: locked-call-key answers have no route;
  Android cold-start may miss the tunnel. Merge after the owner's retest.
- 2026-11-16: The website said "They're on another call" with no call: the stuck answered call kept
  `voici_live_calls` for ~30 more minutes (the room only releases at its end or `VOICI_CALL_MAX_MS`; a caller who
  leaves after an answer does nothing). Cleared the gym row by hand. **Open:** after an answer, end the room when
  the caller's socket closes and no media connected (the 45 s give-up now covers the common case).
- 2026-11-16: **Retest of media-fix failed at ICE.** The browser stayed on "Connecting…" and the phone on "Opening a
  direct path…", then both gave up. The relay logged the phone holding its route (generation 16) at 22:45:22Z, so the
  tunnel came up. Added media-path logs: iOS `calls` category (TLS on relayed streams, TURN gate route/close reason,
  responder open/status/first datagrams/close, ICE and connection states, the answer's candidate count) and browser
  `[voici-call]` console lines (states, `icecandidateerror`). Commits: gym-0.4 `e640a8ab0` (gym Worker
  `5f09a166`, voi.ci build `6f337016c8242288`, gym app reinstalled) and `0.4/media-fix` `b62fb9f22`.
  libwebrtc M157 source check: loopback is gathered when `ignoreLoopbackNetworkAdapter` is false (lo0 is
  `IFF_LOOPBACK`, not filtered). `TurnPort::CreateConnection` drops only mDNS and non-UDP remote candidates, and an
  allocate success needs XOR-MAPPED, XOR-RELAYED and LIFETIME, which turn-lite sends. No loopback block found, so
  the next retest's logs decide.

## Resume point

State (2026-11-16, `release/0.4` at `4bb402875` + this entry): every agent branch is merged:
- calls: rings, video, missed calls, locked answering, calls from the app's logs (real WebRTC engine on iOS and
  Android, browser handoff as fallback), ring-back with the honest pop-up, anonymous calls with proof of work and
  blocking, delete = forget, reveal pill with the unchecked-name sheet, call hours on the owner's devices only;
- libwebrtc built by us (CI), pinned to GitHub pre-release `libwebrtc-157-43884507084`;
- webapp custody 1-6 and the webapp as a full org seat;
- org directory with SCIM/LDAP connectors (all three apps);
- restore, enterprise, retail, cloud fixes; terms and privacy wording for 0.4.

Shell **v226**; D1 migrations up to **0150**. Parity 0 red. Nothing is deployed; only `main` deploys. No agent is
running.

Next steps for whoever resumes:
1. **Cloud task 6** (sent 2026-11-16): full suites on `4bb402875`, plus task 5 if still open. Read
   `cloud-reports/05-*.md` and `06-*.md` on `origin/0.4/cloud-reports`, merge any `0.4/*-cloudfix` branches.
2. **Merge rule** for any new branch: rebase with `scratchpad/rebase-i18n.sh` or by hand; never commit conflict
   markers (`git grep -n '^<<<<<<<'` before committing); on a shell clash take the next number and move WEB_BUILD,
   `release/compatibility.json` and the `apps/web/tests` pins (use perl, BSD sed has no `\b`); after a merge that
   changes packages, `npm i && npx tsc -b` before trusting webapp tests (stale `dist/` broke 20 of them once).
3. **Not run yet:** gym UI tests on iOS and Android for calls, the iOS mock gym, any real box, phone or watch, a
   real browser-to-phone and phone-to-phone call, the OpenLDAP CI job, a real browser against a real `.com` for
   custody. These are the release's remaining risk.
4. **Open, decided later or not in 0.4:** verification notes (paid, idea only); IPv6-only gym (blocked on UpCloud
   IPv4-only boxes and `.com`'s IPv4 checks; fold into "make Fly redundant"); libwebrtc builds are not byte
   reproducible; the caller's video in the call screens.
5. **Waiting on the owner:** at release, sign the webapp shell (`docs/webapp-key-custody.md`) and then set
   `SHELL_SIGNATURE_REQUIRED=true`; the older questions
   in the 2026-11-14 entries (co-manager caps, enterprise formulas, calls v2, retail untrusted, direct names, voi.ci
   name caps, payments, wired fleet).
6. Fly: gym relays are off between runs (`scripts/gym-relays.sh`); a hand-run gym needs `gym-relays.sh on` first.

### 2026-11-16 — Calls: sticky "on another call" fixed (room ends when the answering device leaves)
- Cause: after an answer, the room ended only on a signed `end`. A phone that gave up connecting (45 s), lost its
  end, or was killed just closed its room socket, so `voici_live_calls` held the account busy for up to an hour.
- Fix (`79f3eebe3` gym-0.4, `f0a0dc64a` 0.4/media-fix): `VoiciCallRoomCore.deviceLeft` ends an answered call with
  `hangup` when the winner's socket closes; the Durable Object ignores a close when an open socket from the same
  side remains (a replaced caller socket no longer cancels a ringing call). Test added; doc §6 updated.
- Gym Worker deployed `82b1754a`. Stale rows cleared by hand twice today before the fix.
- Owner's call test (pre-logging build): call connected; phone heard the room (same room as laptop); laptop got
  static that varied with ambient sound (phone→laptop audio damaged: suspect frames over 63 bytes dropped);
  mid-call camera never answered by the phone. Waiting on the next run's Console + `[voici-call]` logs and dump.

### 2026-11-16 — Calls: phone tunnel dropped a stream's first bytes (TURN-over-TLS hung)
- Evidence: phone log (`log collect`, 19:35 local): 4 relayed streams, 2 "tls ready", none with any plaintext,
  then -9816 when the browser gave up 30 s later; browser 701 "Failed to establish connection". Cert chain fine.
- Cause: both relays (TS `phoneTunnel.ts`, Rust `phone.rs`, the shared tunnel registry) send OPEN then the visitor's
  bytes at once, without waiting for an ack. iOS `PhoneTunnelClient` registered the stream only after the TLS listener
  was ready plus a queue hop, so the data frames behind OPEN (the ClientHello) were silently dropped.
  Android registers synchronously on OPEN (`PhoneTunnel.kt` `openStream` returns the stream), so it isn't affected.
- Fix: `3fee8f256` gym-0.4 / `3ea2d8cdf` 0.4/media-fix. The stream is registered on OPEN and holds data in order
  (at most 256 KiB, then it's closed). A close that arrives while it opens is honoured. While a call is armed, it logs
  bytes each way per stream, frames for unknown streams, the TLS version and the terminator's plaintext count.
- Clean-cache build fixes: `122a0ade3` gym-0.4 / `4d123dd35` media-fix. The ContentView body was split in three after
  a type-checker timeout, and the gym adoption closure captures `self.privacy`. Swift unit tests not run (no `.build`,
  not enough disk); the gym app is installed.

### 2026-11-16 — Queued: Activity shows calls and social (owner: "yes queue it for 0.4")
- Design `docs/activity-social.md`: calls, conversations, requests, page updates, comments/reactions in Activity next to
  the server entries; social/call entries built on the phone only (no `.com` log), E2E-synced like call hours; deleting
  a conversation removes its entries; filter All / Servers / Social. Starts after `0.4/social-tabs` merges.
- `0.4/social-tabs` (agent running): Profile / Inbox / Requests tabs, floating call button + Calls page with a target
  field, badges totalled on the Social tab, circled pencils, collapsing profile header, default first post.

### 2026-11-16 — Merged `0.4/social-tabs` (shell v227)
- Profile / Inbox / Requests tabs on iOS, Android and the webapp; floating call button opens Calls with a "Who to call"
  field (page name, @name, voi.ci link; checked like a call); badges (Inbox unread + reply notices, Requests pending,
  missed calls since a local seen marker; Profile stubbed at 0 until comments/reactions exist) totalled on the Social
  tab; `pencil.circle`; collapsing profile header; first post "Hello. I am using the Flagship app, from
  flagshipserver.com" on a page's first publish only. Design `docs/social-tabs.md`; parity row `social-tabs`.
- Checked: webapp tests 3670 green (agent), i18n and parity green after the rebase. Android unit tests green except
  `MaintainersConformanceTest` (no node_modules then). iOS compiled only; its unit tests, the gym UI specs on all three
  clients and a recompile for the last one-line reply-count change are NOT run (disk at 4.5 GB).
- Next: Activity for calls and social (`docs/activity-social.md`).

### 2026-11-16 — Disk cleanup; Activity agent started
- Owner approved deleting merged worktrees: 39 removed (all merged into release/0.4, no tracked or untracked changes;
  branches stay on origin). Kept: main checkout, release/0.4, gym-0.4, ice-fix, media-fix (unmerged), gymseam
  (unmerged), the gym cache worktree. Disk 4.5 GB → 30 GB free.
- `0.4/activity-social` agent started (spec `docs/activity-social.md`). `0.4/ice-fix` agent running (local harness
  for the TURN/ICE failure). Owner: a locked phone rings fine, so the earlier "rang a second" was not the lock check.

### 2026-11-16 — Calls: ICE through the phone's TURN responder (branch `0.4/ice-fix`)
- After the tunnel fix every relayed stream reaches TLS 1.3 and TURN allocates, but ICE fails on both ends (phone
  checking → failed at 15 s; Chrome checking → disconnected → failed). The TURN stream carried 76 KB in and 50 KB out.
- Harness `tools/voici-calls-ice/` (`30eb7ecdf`): turn-lite over TCP with a real relay socket, Chrome as the caller
  (set up like the voi.ci page) and as the phone stand-in, `--loopback` making the caller see 127.0.0.1 relay and
  peer as on the phone. PASS for audio, audio + video, 8,000 and 320,000 B/s, with the phone's extra `::1` candidate.
  So turn-lite and the browser are fine; the failing part is the phone's side (its libwebrtc on loopback, or
  the content of the checks). Not found by reading libwebrtc.
- Diagnostics on the phone (`e738cb1fe` gym-0.4, `de4ca8a16` 0.4/media-fix): every 2 s "turn mix:" counts of STUN
  requests/successes/errors (with codes), DTLS, RTP, RTCP each way and dropped datagrams; the checks' USERNAME and
  both descriptions' ICE ufrags. Built; install failed because the iPhone is out of storage (300 MB needed, 206 MB free).

### 2026-11-16 — Networking: overlay agreed for 0.5; direct access stays the 0.4 item
- Owner: "write it up, start it in the next release"; in 0.4, people with public addresses hook their services to
  `fshp.app` names that point straight at them. That is direct access (built and merged; needs a live run on a real
  box with a public IPv6). Overlay plan in `docs/networking-vision.md` "The overlay": key-derived ULA addresses,
  trusted-direct / strangers-relayed, PQ transport, one relay mesh, stages app-layer → desktop/box interface →
  optional phone VPN.
- ice-fix agent: local harness (turn-lite + headless Chrome) passes in every mode, so the fault is on the phone's
  WebRTC side; new `turn mix:` / `ice ufrags:` diagnostics built (gym-0.4 `e738cb1fe`, media-fix `de4ca8a16`), not
  installed: iPhone out of storage (needs ~150 MB).

### 2026-11-16 — Merged `0.4/activity-social` (shell v228)
- Activity on iOS, Android, webapp: All / Servers / Social filter; call, conversation, request, page and post entries
  rebuilt on each draw from device data (nothing stored, nothing new on `.com`; conv-forget already removes a deleted
  conversation's entries on every device); taps open the thread, Calls, Profile or the server. Box: scheduled backups
  record `server.backup.scheduled` ("Scheduled backup finished"; needs an endorsed box release).
- Tested: iOS simulator unit tests (SocialActivity, MessagesForget, ActivityViewModel, ServerArchive, VoiciOutgoingCall),
  Android 3082 unit tests, daemon serverArchive 179, webapp 3679; i18n and parity green after the rebase. Gym UI specs
  for Activity not run (section count may shift).
- Owner questions: sync answered/placed calls to other devices (would put a sealed call log on `.com`)? Show call
  length?

### 2026-11-16 — Calls: root cause of "stuck at Opening a direct path" found and fixed
- Cause: `e640a8ab0` (the first diagnostics commit, gym-0.4 and media-fix only) replaced
  `for (port, d) in r.peers { send(d, port: port) }` in iOS `TurnResponder.onClientBytes` with a log call, so the
  caller's datagrams never reached the phone's peer connection. Evidence: phone4 log `turn mix` showed p>c only
  binding requests (never a success) while c>p carried requests and successes; the earlier pre-diagnostics call did
  connect. release/0.4 never had the bug (media-fix not merged); Android's responder is unchanged and sends.
- Fix + proof: gym-0.4 `8bb74c591` (media-fix `f8fb37d04`) restores the send and logs a failed sendto once.
  New `CallMediaLoopbackTests` connects two real iOS libwebrtc engines (simulator slice of the pinned xcframework)
  through CallTurnGate + TurnResponder on loopback: passes in 0.3 s with the send, times out (20 s) without it.
- Music-time ring that stopped after ~1 s (21:03:45, 21:04:04): the room WebSocket upgrade got HTTP 403 (device join
  refused), not an audio problem. Which check refused is not known yet: the phone now logs `room join: call-key |
  device-key` and `room-join-refused-<status>-<kind>` (gym `d17b67796`, media-fix `ae1892c86`), and `.com` logs the
  refusing check for call-key joins (`4aed7e41b` / `15d90ac1b`; gym Worker `59db4a90`). The gym has one bound call
  key for fleet-perch (device 2e191c3260…).

### 2026-11-16 — Merged `0.4/call-length`; call fix found
- Owner: call history stays per device (not synced); show call length. `004a32692`: "Answered · 4:32" in Activity and
  the length on answered rows of the Calls page (iOS, Android; localized digits). SocialActivity tests green on both.
- Call failure root cause: diagnostics commit `e640a8ab0` (gym-0.4/media-fix only) dropped the responder's
  `send` to the peer. Restored with errno logging and a real-libwebrtc loopback test (`CallMediaLoopbackTests`); gym app
  reinstalled. Music-time failures were a 403 on the device room join; refusal logging added (phone + gym Worker
  `59db4a90`). Waiting on the owner's retest.

### 2026-11-16 — Rule: the gym app carries all of release/0.4
- Owner: "incorporate them in the Flagship gym app on my phone so I can see the improvements". Every gym device build
  now starts by rebasing `gym-0.4` onto `origin/release/0.4` (keep gym-only commits; next free shell number on a
  clash), then builds and installs; a gym Worker deploy then also carries the newest webapp and voi.ci.

### 2026-11-16 — Calls: no-audio and unlocked-join fixes; gym-0.4 now tracks release/0.4
- **Unlocked phones never joined a call (403 device-key):** `canonicalAccountDirectoryRequest` refused any path outside
  `/api/accounts/`, so a device-signed `GET /api/voici/calls/<id>/device` (and the app's `POST /api/voici/calls?u=`)
  never verified. Locked phones use the call key and were fine; this was every "rang a second" failure. The rule now
  admits `/api/voici/calls…` too (each route still checks its own path); refusal log names the check
  (`device-signature`, `not-admin-device`, …). Test `voiciCallDeviceJoin.test.ts` fails on the old code, passes now.
  (The webapp's own `canonicalDirectoryRequest` keeps the `/api/accounts/` rule; it signs no call route.)
- **Connected but silent:** the browser's RTP reached the phone (~50/s) but the phone sent ~1/s: nothing set the
  session to playAndRecord/voiceChat before CallKit activated it (only in-app calls did). `CXAnswerCallAction` now
  configures RTCAudioSession first; didActivate repairs a wrong category and logs it; the audio sender is capped at
  24 kbit/s (63-byte sealed slot); frame counts (sealed/refused/opened/failed, max size) logged every 2 s.
  Simulator: the loopback test still proves ICE/DTLS; it can't prove audio (the test host can't start the voice unit,
  AUIOClient_StartIO -66637), so the frame asserts run on a device only. Needs the owner's call to confirm.
- Debug (gym) builds also write the calls log to `Library/Caches/calls.log`; fetch with
  `xcrun devicectl device copy from --device 00008120-001A18203EA0C01E --domain-type appDataContainer
  --domain-identifier com.flagshipserver.app.gym --source Library/Caches/calls.log --destination <dir>` (no sudo).
  The file appears after the first call-log line on the new build.
- **gym-0.4 rebased onto release/0.4 `0e3a0ff70`** (coordinator, for the owner: the gym app shows every 0.4 change):
  backup `backup/gym-0.4-pre-rebase-202611162145`; i18n sources 3-way merged, catalogs and the voi.ci site rebuilt;
  shell v228 unchanged. Gates: i18n green except the known gym-only `GymLiveAdoption.swift:104`; parity green;
  vitest key suites green except 4 gym-only (two `apps/com` cron/static guards, two webapp PQ-pin tests: the gym
  empties the protocol pins). Gym Worker `8ad5aec0`; gym app installed with social tabs, Activity, call length and
  the call fixes. Rule from now on: rebase gym-0.4 onto release/0.4 before every gym build.
- Commits: gym-0.4 `4efdaf784`, `d4545a2cd`, `92f06068f`, `5e9977c5d`; media-fix `7e6902a16`, `35e82dac8`,
  `73ee3ba49`, `a98b101fa`.

### 2026-11-16 — Calls: phone→browser audio garbled; diagnostics on both ends
- Owner call: website→phone clean, phone→website garbled. Phone log (copied with devicectl, no sudo): session
  PlayAndRecord/VoiceChat; 50 frames/s sealed (max 60 B in) and opened (88 B sealed) each way; TURN mix symmetric,
  no drops (rate bucket 8,000 B/s each way, about 5.5 KB/s used). The frame format matches Swift ↔ JS byte for byte, and
  the shared vectors cover both directions, epochs and max length, so the opener is not the suspect on paper.
- Added (gym-0.4 `1332e45f6` + site `2acdc5b2c`; media-fix `a29adba4f`): the browser logs worker frame counts every
  2 s (open ok / wrong size / failed / before keys, seal ok / refused, sizes) and inbound audio stats (packets, loss,
  concealed samples, jitter buffer, level, codec, decoder). The phone logs its session rate, IO buffer and route at
  activation, connect and route change, plus its send stats (mic level, codec, target bitrate).
- gym-0.4 rebased onto release/0.4 first. Gym Worker `f1a090fd`, voi.ci build `aa34cca9692c6c73`. Gym app
  reinstalled.

### 2026-11-17 — Garbled phone→website audio: found and fixed
- Browser diagnostics showed `open ok 0` for the whole call while 50 packets/s arrived and ~54 % of samples were
  concealed: Chrome's audio receiver never got its opening transform (attached only in `ontrack`), so the phone's
  sealed 88-byte frames went straight to the Opus decoder. Phone side was healthy (mic level, 24 kbit/s CBR, 0 loss).
- Fix: every receiver gets its transform when its transceiver is made (`packages/flagship-web/src/call.js`), test
  fails on the old code. gym-0.4 `b83e48abb` (voi.ci build `bb28bcf2069c38fc`, gym Worker `c010bd97`); media-fix
  source + test cherry-picked (site rebuilt at merge). No phone build needed.

### 2026-11-17 — Call freeze fixed; new iOS call screen
- Owner: after muting, the website's camera turning on froze the phone app (no unmute, camera or hang-up). Log: video
  frames opened at ~24/s until 06:33:28Z, then silence, no end. Cause: the iOS engine read the frame keys under its
  main lock from WebRTC's worker/encoder threads while the main thread held that lock in libwebrtc setters (mute,
  camera) that block on those threads. Fix: keys under their own lock, no libwebrtc call under the engine lock;
  hang-up ends locally if CallKit's end hasn't run in 3 s. Android unaffected (`@Volatile` keys).
- New iOS call screen (`VoiciCallStage.swift`): dark stage, large initial + name, status then timer, round Audio-route
  / Mute / Camera / Flip buttons over a red End, full-screen remote video with a draggable corner self-view, tap to
  hide controls, proximity in audio calls; strings in all 7 languages. Android and voi.ci port specified in
  `docs/voici-calls.md` "Call screen" (not built).
- Commits: gym-0.4 `5d600cbf9` (freeze), `ea20c4ca0` (screen); 0.4/media-fix `f0ef60179`, `b6e9ddf69`, `def0fb030`
  (doc). iOS tests: VoiciCallsViewModel, VoiciOutgoingCall, CallMediaLoopback (28) green on the simulator; i18n green
  except the gym-only `GymLiveAdoption.swift:104`.

### 2026-11-17 — Call screen on all three clients; freeze fixed
- Freeze when the caller turned the camera on: one engine lock held across WebRTC calls while WebRTC threads took it
  for frame keys (deadlock). Keys got their own lock; no WebRTC call under the engine lock; hang-up ends locally after
  3 s if CallKit's end doesn't come. (media-fix `f0ef60179`)
- New call screen (iPhone/WhatsApp conventions, own design): iOS `b6e9ddf69`; Android `bc3e0c892` (audio route via
  Telecom or AudioManager, proximity lock, full-screen outgoing call); voi.ci `ab43b0b2e` (full-screen stage, draggable
  self tile, output picker where the browser allows); doc `ec181c1df`. All on `0.4/media-fix` (fast-forwarded from
  `0.4/call-screen-ports`). Android unit tests 35 green, web 120 green; not run on a real Android phone.
- gym-0.4 has all of it; gym Worker `fd0355ef` serves voi.ci `4f7e4fb9d6b50b1f`; iOS gym app with the freeze fix
  and the iOS screen installed. Open: German "Ihre/Deine Kamera" mismatch on iOS; no "other side muted" signal.

### 2026-11-17 — Merged `0.4/media-fix` (calls work end to end); desktop call layout on `0.4/call-desktop`
- media-fix rebased onto release/0.4 (i18n JSON 3-way merged, catalogs and voi.ci rebuilt; one fix after the rebase:
  `fd650f864` restores the Who-to-call card's Android imports). Checked: `tsc -b`, `npm run i18n`, parity, voi.ci
  `--check`, 2634 call/voi.ci/protocol vitest tests, Android debug + calls unit tests, iOS simulator
  `CallMediaLoopbackTests` + `VoiciOutgoingCallTests` (11). release/0.4 fast-forwarded to `fd650f864`; worktree
  removed. Shell stays v228.
- `0.4/call-desktop` `d1ff9165b` (not merged): on ≥768 px or landscape, their video letterboxed full width, controls
  in a floating auto-hiding bar, 16:9 draggable self tile, Full screen and Picture in picture where supported;
  `remoteVideoLive` (room on + track flowing + frame within 1.2 s) returns to the audio layout otherwise, no black
  rectangle. Phones already return to audio on the room's camera-off; no native change. Headless Chrome 1280×800 and
  390×844 through audio → video → video+self → stalled → resumed → audio: classes right, no horizontal scroll.
- gym-0.4 rebuilt as release/0.4 + the 20 gym-only commits + `d1ff9165b` (calls duplicates dropped; backup
  `backup/gym-0.4-pre-rebase-202611170118`); gym Worker `2428b015`, voi.ci `bf2243dbf587b369`. No iOS change, so the
  phone app was not reinstalled.

### 2026-11-17 — Owner: "go go" on the finishing plan; merge as you go
Owner decisions: merge as we go (trust build + gym; owner tests by hand at the very end); UpCloud topped up, use what
is needed without waste; **no "other side muted" signal** (a privacy leak; skipped); owner is away, reachable only
by web chat, and does all manual steps at the end.
Plan (in order; at most 2-3 agents at once, security and UI never on the same files):
- A. Merge `0.4/call-desktop` and the cloud fixes (`webapp-boot`, `gym`, `compose-flake`, `vitest`, `keyd-clippy`).
  Rename consequence (call keys rebind after an account rename) noted for the owner's end review.
- B. Fix review-cloud F1-F9 (5 Medium, 4 Low) with the reviewer's failing tests, then an independent check.
- C. iOS German "Ihre Kamera" → "Deine Kamera"; run the calls/Social/Activity gym UI tests on iOS, Android, webapp.
- D. Direct access live run on an UpCloud IPv6 box (`fshp.app`); CI (Android emulator smoke, iOS CI; F6 DNS token);
  full gym run R1; version bump, release notes, deploy sheet (R2-R4); housekeeping (feature-branch rebases, AGENTS.md).
- E. UI pass: screenshots of every screen (iOS sim, Android emu, webapp, light/dark), design critique, changes on
  `0.4/ui-pass`, before/after page (private Artifact) for the owner to approve per change.
Owner at the end: phone-to-phone call test, YubiKey steps (0.2 update notice, runtime manifest re-sign before
~2026-12-20), sign the webapp shell, manual testing.

### 2026-11-17 — Plan A: call-desktop and the cloud fixes merged (merge agent)
- `0.4/call-desktop` → `1858687f2` (rebased over the two journal commits; voi.ci `--check` clean, 56 voi.ci tests).
- `0.4/webapp-boot-cloudfix`: nothing to merge. release already had the fix (`e11927161`) and its own
  `apps/web/tests/webappModulesParse.test.ts`; release's version kept.
- `0.4/vitest-cloudfix` → `50ae6efd4`, `2e35bf0f7` (pg guard; voi.ci call tables in the rename lists. Review the
  classification: call keys and revocations are not renamed, so a device binds its call key again after a rename).
- `0.4/keyd-clippy-cloudfix`: already on release as `e46b6eb88` (the rebase dropped it); keyd clippy and tests green.
- `0.4/compose-flake-cloudfix` → `7ea537af3`.
- `0.4/gym-cloudfix` → `89b167e9e`, `f273487ba`, `33ced0241`. Skipped as already on release: `d2cb7331e` (boot
  fix), `e8d717bd2` (onboarding passkey: `cdb36782f` did it with `passkeyAuthenticator`), `6391e2e45` (modal in
  the top dialog: `fd8a79cd3`).
- `000940994`: the page-editor gym scenario failed on release itself (first publish turns messages on and adds a
  first post, `3e4dcc328`/`23d44a7be`); the test now follows those defaults. Product note for the owner: the public
  warning still says "Messages and calls ... are on" when the owner turned Accept messages off before the first
  publish, and turning the switch off and on again counts as two unpublished changes.
- `99bd4bd8e`: iOS German "Ihre Kamera" → "Deine Kamera" (`i18n/ios/de.json`, `i18n-ios.mjs build`). Two other
  formal strings remain in iOS German, not on the call screen: "Ihr Server führt das offizielle Node.js-Binary…" and
  "Führen Sie diese Befehle…".
- Checks at `99bd4bd8e`: `tsc -b`, `npm run i18n`, parity green. Webapp gym 375/375 (374 + the fixed scenario,
  7/7 in its spec after the fix). Full vitest 18219 passed, 2 failed: `apps/com/test/cronBudget.test.ts` fails
  every time on this Mac and at the pre-merge base `8af14570f` too (voici-names+voici-gc 2.8× calibration against a
  2.2 budget: not caused by these merges, open); `relayMesh.test.ts` MESH07b is a flake (the failing variant moves
  between runs, 33 s to 965 s, passes at the base, no relay code changed). Android `:app:testDebugUnitTest` 3094,
  1 failure `RetailClaimFlowTest.alarmWhenTheCertificateDoesNotMatch` (15 s wall-clock wait under load; 11/11 alone
  three times).
- Temporary worktree removed. Next: plan B (review-cloud F1-F9).

### 2026-11-17 — Plan D: direct access run live on the gym (16/16 green)
- New live gym group `direct-access` (branch `0.4/direct-access-live`, also on gym-0.4): a gym box with a public IPv6
  (`/api/gym/provision` takes `ipv6: true`; gym boxes were IPv4-only), the admin-root order naming only the box's /64
  (IRK order refused 403), the box finding its address and its signed update reaching `.com`, the owner's name order,
  a **real Let's Encrypt** certificate (issuer YE2; the gym issues from LE production, not Pebble), AAAA + pinned CAA and
  no A at the zone's name servers, HTTPS from outside over IPv6 (this Mac's own IPv6) answered 200 by the box with a
  verified certificate naming only the direct name, the relay serving nothing for the name, `.com`'s probe (200), and
  withdrawal on name off and on direct access off (box stops listening, connection refused). One LE certificate used.
- Gym seam (gym-0.4 only, `fcfea27c2`): the gym's direct apex is `fshp.gym.flagship.services` (protocol, keyd TS +
  Rust, `wrangler.gym.toml`); gym Worker secrets `CLOUDFLARE_DIRECT_DNS_API_TOKEN` (gym DNS token) and
  `CLOUDFLARE_DIRECT_ZONE_ID` (flagship.services) set. Nothing is ever written into `fshp.app` from the gym.
- First gym box artifact for 0.4: `fcfea27c2f5a` (sequence 202611170748); gym Worker `3efafac6`.
- Bugs fixed (`0.4/direct-access-live`, to merge): `d1e89b6d0` a two-character slug gave a `??--` label that Let's
  Encrypt always refuses (R-LDH): refused in TS, webapp, Swift, Kotlin + vectors; `e3c55db43` the box now hands `.com`
  the owner's off order (before, if the app's own post failed, records kept pointing at a box no longer listening; not
  yet in a gym artifact, so unit-tested only).
- Found, owner: a withdrawn or not-yet-published direct name falls to any wildcard on the direct apex (in the gym, the
  relay wildcard). Production's old proxied `*.fshp.app` (and `www`) must be deleted before launch (step 6). Also still
  open: F17 LE rate-limit request; `fshp.app` direct DNS token + zone id secrets on prod `.com`.
- Pre-existing, not from this work: `apps/com/test/cronBudget.test.ts` fails on release/0.4 (demo+voici-names+voici-gc
  2.6× calibration vs 2.2 budget); the gym CPU report lists `POST /api/server/:x/health` over 10 ms (Workers Paid).
- Cost: UpCloud, two 4xCPU-8GB boxes ~38 min + ~67 min, one 8xCPU-32GB artifact build VM (minutes); all deleted
  (only the playstore-test-0725 demo remains). Gym relays off again.

### 2026-11-17 — Direct access live run: 16/16 on the gym; merged `0.4/direct-access-live`
- New live group `direct-access` on a gym box with a public IPv6 (UpCloud `ipv6: true`): admin-root order (IRK refused
  403), the box finds its address in the /64, `.com` learns it, name order, LE certificate on the box (YE2), one AAAA
  + CAA published, outside HTTPS over IPv6 from this Mac (200, SAN = the direct name), the relay has no cert for it,
  `.com` probe, withdrawal (name off: no record; access off: box stops listening), teardown. Gym-only direct apex
  `fshp.gym.flagship.services` (gym-0.4 `fcfea27c2`); gym artifact `fcfea27c2f5a`. Cost under €0.25; all VMs deleted.
- Real fixes merged: names with `--` in positions 3-4 refused (LE never issues them; TS/webapp/Swift/Kotlin + vectors);
  the box hands `.com` the owner's off order (records no longer outlive the listener). Checks: tsc, i18n, parity,
  2488 protocol/control-plane/daemon/com tests, 8288 webapp+daemon tests.
- Owner before launch: delete production's old proxied `*.fshp.app` / `www` records (direct-access doc step 6); set the
  two direct-zone secrets on production `.com`; LE rate-limit request for `fshp.app` (F17).
