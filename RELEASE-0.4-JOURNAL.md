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
- [x] F6 (merged 2026-11-17; owner: deploy the broker, set DNS_BROKER_URL and DNS_BROKER_SECRET, issue one cert, then delete CLOUDFLARE_DNS_API_TOKEN) Take the zone-wide DNS token off `.com` (challenge TXT through the broker; release step 20 skips when unset).
- [x] F7 (merged 2026-11-14: Web Push to UnifiedPush endpoints from .com with an SSRF guard, Android distributor-first transport, Settings row; D1 0136; needs WEBPUSH_VAPID_* secrets, an Android store build, a real ntfy test) UnifiedPush for de-Googled Android.
- [x] F8 (merged 2026-11-14: correction window, weekly cooldown, account claim budget, 30-day custom-domain lapse grace; D1 0137; owner Qs in named-links §8.5) Human `voi.ci` service names (`docs/voici-service-names-todo.md`).
- [~] F9 (2026-11-14 merged: W19, silent second boot approval, first-boot restarts (order resumes across restarts incl. direct names), Unlocking lingering, W14 partly (taps never ignored, 90 s stop, review-period sentence; OWNER: may a device under review unlock boots?). Earlier merged 2026-11-13: Android stale recovery banner, "another account" backup refusal, W3 hint, W10, W26, raw recipe error, remaster temp folders, sealing stall at 12 min. LEFT: W14, W19, silent second boot approval, first-boot restarts, lingering Unlocking, window close, keep-awake log, MessageBox Pane) Windows acceptance findings (0.4 list section): W14, the silent second boot approval, first-boot daemon
      restarts restarting the certificate order, W19 empty Home, Android stale recovery banner and "another account"
      backup refusal, the Studio for Windows items, W3 Continue hint.
- [x] F10 (merged 2026-11-13) In-app rules sheet names the nudity / violence rule (all apps, all languages).
- [x] F11 (merged 2026-11-17: iOS and Android CI green) CI: Android emulator smoke on API 34; iOS CI green.
- [x] F12 (merged 2026-11-13; all three Studios show the refusal and stop; Windows WPF needs a Windows CI build) The Studio pairing refusal must be visible: a 0.2 Studio refused by `STUDIO_PIPE_MIN` loops on new QR codes
      (found 2026-11-13 on the owner's Mac); the current Studios must show the relay's `error` reason and stop.
- [ ] F13 Repo housekeeping: rebase the remaining feature branches and `gym` (0.4 list), smallest first.
- [x] F15 (merged 2026-11-17: Studio and box loops fixed, old Studios refused before the budget) Rate limits (first check, 2026-11-13, 30 days): `builder-pipe-upgrade` refused 2,685 from 339 sources (likely 0.2
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
- [x] R1 Gym on the test CA, full run green (one green run per group is enough; LE failures are logged, not rerun). Done 2026-11-17: every group green on both stacks (the gym issues from Let's Encrypt, not a test CA; see the entry of that day).
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

Shell **v226**; D1 migrations up to **0151** (0151: voi.ci call-key per-account revocations, 05c review F1). Parity 0 red. Nothing is deployed; only `main` deploys. No agent is
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

### 2026-11-17 — 05c adversarial review: findings fixed (branch `0.4/review-fixes`)

The reviewer's failing tests (`037423994`, `649bcdc29`, `9b99f84ce`, `9bd5fef61`) were cherry-picked first
(`5348ba22f`..`f59e1c05c`), confirmed failing, and now pass. Per finding:
- **F1 (Medium), `87622b939`:** a binding proves no possession of the call key, so any account could bind and revoke
  another's key. Only a self-signed (P-256) revocation stays global; an owner-signed one goes to the new
  `voici_call_key_account_revocations` (D1 **0151**, in `KNOWN_MIGRATIONS`) and refuses the key for that account only.
  `isCallKeyRevoked(username, key)`. Tests in `voiciCallKeys.test.ts` (incl. bind-then-revoke by another account).
- **F6 (Low), `87622b939`:** a call-key join is claimed in the nonce store per (call, key) until it can no longer
  verify; decline stays ringing-only (room test). Note: a failed room fetch after the claim burns that join; the
  apps do not reconnect today.
- **F2, F8 (Medium, Low), `496566e6e`:** SCIM stores and the engine's users/links are null-prototype, read by own
  property; `__proto__`/`constructor`/`prototype` are never ids; older files are rebuilt on load.
- **F3 (Medium), `496566e6e`:** `linkSeats` links only on a proposal under the connector's own key, a decision and an
  invite each approved by an org admin under the pinned chain, the decision naming that proposal, the seat in the
  pinned book. `.com` `/seats` now serves the invites' approvals. The old happy-path test carries real approvals.
- **F7 (Low), `496566e6e`, `e39434dcd`:** PATCH works on a copy, swapped in only when every op is valid; PUT/PATCH
  refuse a duplicate `userName` (and group `displayName`), checked only when the name changes.
- **F9 (Low):** already closed by `0987698d5` (closed resource set); test added. Refused (401) SCIM requests now add at
  most one Activity line a minute (`e39434dcd`).
- **F5 (Medium), `663d8f9cd`, `e39434dcd`:** `.com` keeps every logged head and registration and the export carries
  them (`boxLogHeadHistory`, `registrations`); the verifier fails on a logged one that is missing or a served head that
  is not the last logged; `--previous <older export>` makes the CLI check the log extends it and no head went back.
  The export serves each server's last logged head (no false failure from a head stored mid-read).
- **F4 (Medium), `697ad06e4`, `e39434dcd`, `025e110f6` (TS and Rust keyd):** every signer must still be an org admin
  with the same keys in the newest record shown, and an approval under an older record must predate the next one
  (`stale-oar`). keyd keeps its chain head (`oarVersion`, `oarHash`), moved forward by each adoption and by a new op
  `org.head` that the daemon calls with its pinned chain at every sync; a chain below or forking from it is refused
  (`stale-chain`). Once it holds a ring, the one it takes must link back by `prevSha256` through `between` (the
  versions in between; `version-gap`, `prev-hash`). 10 new shared vector cases, both backends.
- **F10, F11 (Info): left as they are.** F10: the root re-check in the retail claim helper reads state the claim
  user owns, so it adds nothing against a compromised claim service; the doc should stop calling it a defence, or
  bind the recipe to `.com`'s claim receipt. F11: Rust refuses binding `"v": 1.0`, which TS accepts (fails closed).

Independent check (fresh agent, diff + report only): F1, F2, F3, F6, F8 and F9 held. It found an F4 bypass (keyd's head
moved only on adoption; a version jump skipped the link), then, on recheck, that adopting one version at a time could
lock the CGK when an intermediate version's approver had left. Both are fixed (`e39434dcd`, `025e110f6`). It also
found regressions in F7 (a stored duplicate blocked `active=false`), F5 (the mid-export race; `--previous` after a
re-registration) and the SCIM 401 flood; all are fixed in `e39434dcd`.
Remaining limits, for the owner:
- keyd has no fresh source of the chain head of its own. A daemon that is compromised, or a `.com` that withholds
  the removal record, before the box syncs that record can still use a truncated chain. A signed, fresh head
  attestation would close this.
- `.com` could invent a re-registration under an STK it controls, because the server code names domain and serial,
  not the STK.
- After a real re-registration the old box's head is served until the new box posts one.

Checks after rebasing on `89084c81d`: `tsc -b`, `npm run i18n`, parity 0 red, vitest over control-plane, storage,
protocol, keyd, server-daemon, apps/com, org-audit and adversarial: 12217 passed, 1 failed. The failure is the known
`cronBudget.test.ts` (pre-existing on this Mac). Rust: clippy `-D warnings` clean and `cargo test --workspace --locked` green (120 suites).
`relay_core` `http_surface` failed once under load earlier and passed on rerun. Nothing is deployed. Migration 0151 joins the
`.com` deploy list.

### 2026-11-17 — Plan C: native and web gyms for Social, Activity and calls; cron budget; page editor (agent `0.4/ui-gyms`)
Gyms (mock tier, on this Mac):
- **iOS** (Xcode 27.1 RC, iPhone 17 Pro sim, per class with a timeout): GymMessagesTests 19 (1 skipped), GymEveryMergeTests
  8, GymAccountGoneTests 10, GymNoticeTests 6, GymSweepOnboardingTests 12, OnboardingSmokeTests 5, the three Activity
  tests of GymSweepHomeTests: all green after two fixes. **The "hang" was the Mac sleeping**: `pmset` shows Maintenance
  Sleep from 05:01 to 05:42 while xcodebuild held only PreventUserIdleSystemSleep; tests sat 900+ s mid-step. Run gyms
  under `caffeinate -dimsu` (PreventSystemSleep) on this Mac.
  - App bug: Sign in with Flagship refused every fresh attestation as not yet valid (checked against a time read
    before the request; `.com` or the mock answers a few ms later). iOS now judges it at its issuedAt within the send
    skew, as Android did (`ea47accb9`→ rebased).
  - Stale test: since iOS 26 a confirmation dialog on iPhone is a popover with no Cancel; GymNoticeTests finds the
    question by its destructive button and cancels with a tap outside.
- **Android** (`flagship_gym` AVD, API 35 arm64): GymActivityTest 6/6, GymMessagesTest 6/7 after test fixes (Social side
  is process-wide, so each test now starts on Profile; Activity server rows merge into one button, times read
  unmerged; the Accept messages scenario follows the first-publish defaults).
  **Open, release-blocking for Android calls:** the pinned `libwebrtc-157-43884507084` AAR lacks 43 generated
  `org/webrtc/*Jni` classes (PeerConnectionFactoryJni …), so `callingAnasPageFromTheAppHandsTheCallToTheBrowser` dies
  with NoClassDefFoundError at `PeerConnectionFactory.initialize`; a real phone would too. Needs a libwebrtc CI rebuild
  (jni_zero output into classes.jar) and a new pin; `tools/libwebrtc/build-android.sh` now refuses an AAR with a
  missing bridge. iOS is unaffected.
- **Webapp**: gym-activity, gym-messages, gym-features, gym-ux: 64/64 (one gym-ux AI-consent flake under load, 3/3 alone).
Cron budget: real growth, not noise. 4349c9129 put the calls' cleanup into voici-gc as 7 separate D1 calls (voici-gc 3
→ 10 calls, 2.38x alone); the suggestion group also carried issuance-sweep and eviction-gc. The calls' deletes are one
batch now and those two jobs moved to the re-pair group (all groups still hourly): worst plan 2.05x (demo+suggestions,
9 D1 + 4 fetches), voici group 1.8x, was 2.66x. The ratio is almost all D1 calls priced at 0.45 ms over a ~2.0-2.2 ms
calibration, so the six-hourly plan (2.04x) and the suggestion tick have little headroom if calibration drops.
Page editor (iOS, Android, webapp, shell **v229**): the first publish's warning names only calls when Accept messages is
off ("Calls from people signed in with Flagship are on…", 7 languages); the Public switch on iOS and Android now carries
Accept messages as shown (it used to publish the page with messages on); Accept messages counts as a change only while
it differs from the page, so off and on again counts none (webapp also replaces its earlier draft).
Checks after rebasing on `a827aa8d4`: `tsc -b`, `npm run i18n`, parity green; vitest apps/web, cronBudget, voici,
storage 4357 passed; webapp gym messages+activity 12/12; iOS PageControlsTests 24; Android PageControlsTest/VoiciAppTest.
Also seen: the voi.ci site checks the phone's answer attestation with the browser's clock (`checkVoiciSignInAnswer`);
a browser behind `.com` by more than the round trip would refuse it the same way. Android's empty Inbox says "Turn on
Accept messages" even while messages are on.

### 2026-11-17 resume (owner: "resume all")
- A network outage (ENOTFOUND) cut off R1, the live gym run. Its arch-v2 pass ended rc=2 at gym-relays teardown. R1 was resumed to: check that the relays are off and nothing leaked, summarise the results, rerun the real failures, and push 0.4/gym-r1-fixes (52f97e293, 03ffa6f99, 834bbc2de; not pushed yet).
- Android libwebrtc JNI agent: still waiting on CI run 44099203173.
- Payments steps 1-3 started on 0.4/payments: voucher core (ported from feat/marketplace), the phone-held wallet with trickle spend, and the plan screens. The defaults are provisional and kept in one config place.
- Resume point: merge R1's fixes, then the libwebrtc pin, then payments; after that come D11 CI, R2-R4 and the E UI pass.

### 2026-11-17 — Android calls fixed: libwebrtc JNI bridges, new pin (agent `0.4/webrtc-android`)
- **Root cause.** In M157 `generate_jni()` puts each `org/webrtc/*Jni` class in its own `<name>_java` library;
  upstream's `dist_jar("libwebrtc")` takes direct deps only, so none were packed, and by default those classes call
  hashed natives on `J.N`, which only an APK's final JNI step writes. The AAR had neither (the .so exported only
  `Java_J_N_M*`). Fix in `apply-overlay.py` / `build-android.sh`: jni_zero per-file natives (new GN arg
  `jni_zero_per_file_natives`, `use_hashed_jni_names=false`), every non-test bridge library plus `dav1d_java` and
  rtc_base's and jni_zero's bridges in the jar, `libaom_av1_encoder_jni` linked (upstream shipped LibaomAv1Encoder's
  Java without its native). New guard `tools/libwebrtc/check-aar.py`: every org/webrtc, org/jni_zero, J/ class the
  jar uses is in it, and every native method has its symbol in each ABI's .so; a refused AAR is kept as an artifact.
- **CI.** Run 44087165096 failed the guard (Dav1dDecoder missing; LibaomAv1Encoder unlinked: per-file binding itself
  worked). Run **44099203173 green** (all 7 jobs; check-aar: 517 classes, 196 native methods bound on 3 ABIs).
- **Pin `libwebrtc-157-44099203173`** (pre-release, created by this agent). Only `libwebrtc.aar` is new; the
  iOS WebRTC zip is the previous release's bytes (Package.swift changes its URL only) and both TURN zips were
  byte-identical. `manifest.json` names the run of each file.
- **Tests** (`flagship_gym` AVD, API 35 arm64, against the new AAR): `WebRtcLibraryTest` (new, instrumented:
  initialize, peer connection, FlagshipFrameCrypto) 1/1, `GymMessagesTest` 7/7 incl.
  `callingAnasPageFromTheAppHandsTheCallToTheBrowser`; unit `*calls*`+`*phoneroute*` 61/61 incl. the new
  `WebRtcBridgesTest` (fails on the old AAR with ClassNotFoundException). The handoff test now pins the stub engine
  (with libwebrtc bundled the app calls by itself). It also found an app bug: the call stage was a disabled clickable
  outside video, merging every label into one disabled node (TalkBack, and the gym could not see the status); clickable
  only in video now.
- **voi.ci**: `signIn.js` judges a just-issued answer (attestation and delegation) at its own issuedAt within the
  10-minute send skew, also when a stored session loads; site rebuilt. **Android Inbox**: empty state says people who
  sign in can write here while the published page accepts messages (`voici_empty_messages_on`, 7 languages); gym
  checks it. iOS has the same empty-state wording issue (`SocialTab.swift` emptyText), not changed here.
- Checks: `tsc -b`, `npm run i18n`, parity green; vitest flagship-web + voici-site 55, apps/com voici 41. Not run:
  a real phone call, the iOS app (its bytes are unchanged).
- Commits: 4e70edb1e 8b4eae61c ac5150525 b6ed3a7c4 4d28a675d 4119039ad 8b17ec9c5 14bcafc84 
- Open (small): iOS has the same wrong empty-Inbox text as Android (`SocialTab.swift` `emptyText`). Fold it into the E UI pass.
- Payments steps 1-3: 0.4/payments at 93ac569f1, pushed, not merged.
  - Built: the voucher core with vectors on every port; D1 0152; `.com` redeem, test issue (gym only) and the wallet sync; the webapp Plan page (shell v230); Android's Plan screen.
  - The iOS Plan screen is still being built by its sub-agent, which holds native-build.lock.
  - Merge after iOS lands and builds. That run also needs the `VOUCHER_SIGNING_KEYS` gym secret and a gym refresh.
  - The owner's questions are in §5.11 and §5.9 of docs/payments-privacy-and-rails.md and in the agent report: wallet key custody, OHTTP in the apps before launch, a box copy of the wallet, tax and law, store setup, overage slowed rather than billed, and when new vouchers sync.
- Merged payments steps 1-3 into release/0.4: 18 commits, rebased clean.
  - Checks: tsc, i18n, parity and the voi.ci check are green; vitest 3475 plus 6316 tests pass.
  - iOS: the voucher tests 15/15, PaymentsCenterTests 4/4 and the Plan UI gym test pass.
  - Shell v230, D1 0152.
  - Still to do: an OHTTP client in the apps; the live gym (needs the `VOUCHER_SIGNING_KEYS` gym secret and a refresh); the owner's questions; then steps 4-7 (Stripe, IAP, Monero, paid apps).

### 2026-11-17 owner: set up all of payments; OHTTP and bring-your-proxy live in 0.4; fix the Play Wear rejection
- 0.4/payments-rails: the Stripe web shop and in-app purchases (StoreKit 2, Play Billing) selling blind vouchers. Owner runbook: docs/runbooks/payments-setup.md. The owner has a Stripe account and a bank account.
- 0.4/outbound-proxy: feat/outbound-proxy ported (Pro-gated), plus OHTTP clients on all three apps for voucher redeem. The relay must not be Cloudflare (`.com` runs on Cloudflare). An interim relay run by Flagship, labelled as such, until a third-party contract.
- 0.4/wear-listing: Play rejected Wear versionCode 1000011 because the listing doesn't mention the tile or the complication. Fixing the listing text in i18n/store; owner runbook for resubmitting.
- Owner rule (2026-11-17): if infrastructure we provide fails (the OHTTP relay or gateway, and the later overlay), the system keeps working; spends wait, then go direct before a plan would lapse. If the owner's own proxy setting fails, alert loudly, and the order that fixes the setting always gets through. Passed to the 0.4/outbound-proxy agent.
- Merged 0.4/wear-listing: the Play listing names the Wear tile and complication in 7 languages. Owner runbook: docs/runbooks/play-wear-listing-fix.md; no new bundle needed. Wear quality follow-ups WO-V10, WO-V9, a tile screenshot and the hard-coded tile strings went to an agent.
- Merged 0.4/wear-quality (853a52c6f, rebased): the tile preview image, the empty state that says open Flagship on your phone, tile and complication text localized on the watch, and a tile store screenshot (slide 07c). Wear 30/30, companion 12/12, app 3113 pass, release-clean ok. Ships in the next Android bundle.
- Merged payments steps 4-5 (0.4/payments-rails, iOS from 0.4/payments-rails-ios folded in).
  - Built: Stripe Checkout, Apple and Google proof checks, refunds, D1 0153 and shell v231; Play Billing on Android and StoreKit 2 on iOS; the `voucher-shop` parity row.
  - Checks: tsc and i18n green; vitest 9771 pass; MESH05 passes on its own (the earlier failure came from machine load). The first-publish warning scenario, unregistered on release/0.4 before this, is now registered.
  - iOS: 19 tests run, 18 pass; the StoreKitTest case skips under SwiftPM (it needs an app-hosted test target). The Plan UI gym passes.
  - Android: GymPlanTest not run (disk).
  - Owner runbook: docs/runbooks/payments-setup.md.

### 2026-11-17 — R1: full live gym, every group green on both stacks
- gym-0.4 rebased onto release/0.4 (backup `backup/gym-0.4-pre-rebase-202611171200`; clean, the merged direct-access and
  call-desktop commits dropped). Gym artifact `f83a8d3023c4` (seq 202611171210), update target `3cdead624427`, rollback
  drill `e6a8b3e0b26e`; gym D1 0151 applied; gym Worker deployed the gym way (last `fae163a4`). Issuer: Let's Encrypt.
- Third mesh relay: gym-c's id was retired on 11-09 and ids are never reused, so it ran as **gym-d** (new seed, VM,
  admitted, directory v6) and was taken down and retired after (directory v7). caddyserver.com refused every Caddy build
  with caddy-l4 (400); built with xcaddy on the VM, and the provision script now does that itself.
- A network outage (ENOTFOUND) ended the first arch-v2 pass during lifecycle/one-list and its teardown, and stopped
  the classic pass before it started; the fleet was torn down by hand after (`shared-run.ts --teardown --reuse`).

| group | arch-v2 | classic | | group | arch-v2 | classic |
|---|---|---|---|---|---|---|
| core | 30/0 | 30/0 | | phone-route | 9/0 | |
| languages | 7/0 | | | phone-endpoint | 8/0 | |
| gating | 21/0 | 21/0 | | serving | 6/0 | 5/1 → **6/0** |
| invites | 16/0 | 16/0 | | quota | 7/0 (3 skip: dedicated DB) | |
| enforcement | 6/0 | | | backups | 9/0 | 8/0 (1 skip: arch-v2 only) |
| server-order | 8/0 | | | named-links | 11/0 | |
| runtimes | 10/0 | | | browser-grants | 7/0 | |
| real-account | 10/0 | | | app-names | 6/0 | |
| free-plan | 15/0 | | | chat-cross-owner | 7/0 | |
| access-lists | 7/0 | | | update | 9/0 | 9/0 |
| ai-staging | 4/0 | | | update-rollback | 7/0 | 7/0 |
| share | 19/1 → **20/0** | | | app-isolation | 5/0 | |
| api-keys | 10/0 | | | adversarial | 21/0 | |
| remote | 8/0 | | | issuance | 12/0 (1 skip: CAA owner step) | |
| ai-chat | 5/0 | | | relay-authority | skip (mesh on) | |
| migrate | 10/0 | | | relay-mesh | 10/0 (1 skip: feed pause) | |
| app-copy | 7/0 | | | rust-core | 13/0 | |
| archive | 8/0 | | | rust-custody | 6/0 | |
| mcp-ide | 9/0 | | | voici | 23/0 | |
| activity | 9/0 (2 skip after share) | | | stack-switch | 0 (classic only) | 10/0 |
| direct-access | 15/1 → 15/1 → **16/0** | | | one-list | 4/2 (outage) → **6/0** | 6/0 |
| first-contact | 5/0 | | | lifecycle | 0/1 (outage) → **7/0** | |
| passkey-recovery | 5/0 | | | release-catalog | 2/0 | |
| server-seen | 3/0 | | | canary | 3/0 | |
| origin-generation | 4/0 | | | ai-consent | 5/0 | |
| upstream-sync | 5/0 | | | wasi-apps | 13/0 | |
| app-groups-db | 7/0 | | | local-ai | 12/0 | |
| gpu-sim | 0/1 (core quota) → **95/0** | | | local-ai-cpu | 0/1 (core quota) → **13/0** | |
| gpu-real | skip (owner hardware) | | | | | |

First arch-v2 pass: 58 groups, 498 passed, 7 failed, 9 skipped; classic: 126 passed, 1 failed, 1 skipped. Every
failure then rerun green (bold). Accepted skips as in 0.3: gpu-real, 3 quota DB checks, issuance I-10 (production CAA
owner step), relay-authority under the mesh, relay-mesh feed pause, classic backups' arch-v2 check.

Fixes (branch `0.4/gym-r1-fixes`, fast-forwarded into release/0.4 at `24f836458`; mirrored on gym-0.4):
- **Product** `f0811f049` `.com` direct access: the same order posted again is taken (200), not 409 replayed. Since
  `e3c55db43` the box hands `.com` the owner's off order, so the app's own post arrived second and iOS showed "A newer
  change is already saved". Test in `directAccess.test.ts`.
- **Product** `e744141a0` direct names: two reconciles overlap (every order reconciles in the background, plus the
  cron); one working from an older row wrote a CAA after the newer one finished, its `setPublished` was skipped, and
  the row said empty while the zone kept the CAA. The losing pass now reconciles again from the current row (twice,
  then leaves it pending). Race test fails on the old code.
- Harness: `72825bef2` share registers a real Web Push subscription (`.com` checks the shape since UnifiedPush);
  `24f836458` serving accepts a policy the box already took from `.com`'s heartbeat; `1ee90bb26` configurable third
  relay id (`GYM_RELAY_C_ID`) and an xcaddy fallback for Caddy.
- Checks: tsc, i18n, parity 0 red, control-plane + `.com` 2969 tests, direct suites + live-e2e unit tests 153.
- Cost: UpCloud credits 585.51 → 332.07 (about €2.53: three 8-core artifact builds, two fleets of up to 8 boxes,
  the gym-d relay VM, four rerun fleets); Fly gym relays on about 5.5 h; Let's Encrypt for every gym box certificate
  and two direct-name certificates. Time about 12:00-17:45 UTC.
- Leftovers: none. UpCloud lists only `playstore-test-0725`; gym servers 0, gym DNS records 0; gym relays stopped
  (autostart off); gym-d's VM and DNS gone and retired; its seed kept as `gym-relay-d.seed.retired-2026-11-17`.

- 0.4/outbound-proxy (OHTTP clients on all apps, the relay list from `.com`, fail-safe handling, the Pro gate, the interim relay in infra/ohttp-relay) is built at 02cc07749, not merged.
  - A finishing agent is making the history linear (D1 0154 and 0155, shell v232), fixing Android GymPlanTest (an expectation left stale by rails), finding why iOS GymProxyTests fail on tapping Home's server row, and rerunning two vitest flakes.
- My miss: the payments-rails merge left parity's signed-tags red (`flagship/voucher-order/v1` is web-only). Fixed with an allowlist entry.
- Resume point (usage limit, 2026-11-17): the outbound-proxy finishing agent was stopped before reporting. Restart it from its brief (linear rebase, D1 0154/0155, shell v232, Android GymPlanTest, iOS GymProxyTests Home-row tap, two vitest flakes), then merge, then the payments and proxy live gym, then D11, R2-R4 and the E UI pass.
- Merged 0.4/outbound-proxy (bf437137c, 25 commits, linear).
  - Built: OHTTP clients on all apps with vectors; the relay list from `.com` (`OHTTP_RELAYS`, never Cloudflare); fail-safe spends; loud alerts when the owner's proxy fails, with the fix-it lane through `.com`; the real Pro gate; the interim relay in infra/ohttp-relay (not deployed). D1 0154 and 0155, shell v232.
  - Gates: tsc and parity green, vitest 14434 pass, Swift 56/56 and 38 (1 skip), Android unit and the release compile pass, GymPlanTest 3/3, GymOutboundProxyTest 7/7, iOS GymProxyTests 7/7.
  - Fixed along the way: the iOS create-flow proxy section hid its children's ids (since fdb6b81dc); the iOS test double was missing `redeem(route:)`.
  - Owner decisions on the relay (2026-11-17, advice given): the interim relay on the owner's free Oracle VPS, labelled run by Flagship; Oblivious Network at $15/mo as the main relay if it is not on Cloudflare, allows CORS, and its logging and jurisdiction are OK; community relays in 0.5. Waiting on the owner.
- Next: the payments and proxy live gym (VOUCHER_SIGNING_KEYS gym secret plus gym-refresh), then D11, R2-R4 and the E UI pass.
- Oblivious relay https://relay.oblivious.network/flagship (trial) checked from the Mac: on Fly, not Cloudflare; CORS allows any origin. Added to the webapp CSP. The 0.4 deploy sets OHTTP_RELAYS (docs/outbound-proxy.md, "The relay in use"). Play listing (Wear tile/complication, plus es-419) submitted 2026-11-17: 'Changes in review'.

### 2026-11-17 — R2 gym: payments and the outbound proxy live (every group green, arch-v2)
- gym-0.4 rebased onto release/0.4 (backup `backup/gym-0.4-pre-rebase-202611171904`; two merged R1 harness commits
  dropped). Gym artifact `f30f6bf77a33` (seq 202611171905), update target `34a951de625e`; gym D1 0152-0155 applied
  and stamped; gym Worker deployed the gym way (`e45191fa`, then `16679da4` with the fix below). Relays not redeployed
  (no relay code changed since R1). Issuer: Let's Encrypt.
- Gym-only secrets (keys in `~/.config/flagship/gym-voucher-key.json` and `gym-ohttp-gateway-key`, mode 600, never
  committed): `VOUCHER_SIGNING_KEYS` (key id `560e05b902587fd8`), `OHTTP_GATEWAY_KEYS` (key id 1). The interim relay
  ran as Fly app `flagship-ohttp-relay-gym` (`infra/ohttp-relay/fly.gym.toml`, autostart off) with `OHTTP_RELAYS` /
  `OHTTP_RELAY_URL` pointing at it; the app was destroyed after the run and those two secrets deleted again.
- Rails: Stripe and Google report off and answer `rail-off`; the Stripe webhook answers 503 "stripe not configured".
  **Apple reports on in the gym**: `wrangler.gym.toml` sets `APPLE_IAP_ENVIRONMENTS = "Sandbox"` and the Apple rail
  needs no secret, so `.com` offers it; a bogus JWS is refused 400 `payment-invalid` cleanly. Owner: leave it (works
  once the App Store products exist) or drop the var until then.
- New live groups (branch `0.4/gym-r2-fixes`, mirrored on gym-0.4), driving the webapp's own `lib/plan.js` as admin
  devices of a real account:

| group | result |
|---|---|
| core | 30/0 |
| vouchers | 9/1 → **10/0** (the D1 fix below, then a harness fix: no account A when run alone) |
| outbound-proxy | 8/0 |
| ohttp-failure | 7/0 (rerun 7/0 after the fix, now asserting every voucher that leaves the wallet is credited) |
| update | 9/0 |

  vouchers: payments config, rails, Free box refuses a proxy (pro-required), 30 test vouchers into a padded sealed
  wallet, two-device sync with a 409 merge, a spend through the OHTTP relay (nothing direct; `.com` counts the ohttp
  arrival), the plan reaching R1's Pro gate, double spend and forged voucher refused, two devices ticking at once
  (credited exactly once), overage (Free refused without spending; blocks bought 5/5/0 within the cap, +300 GB).
  outbound-proxy: SOCKS5 with a password on a throwaway VM, box traffic through it (`CONNECT
  flagship-services-gym.fly.dev:8443`), wrong password refused 422; proxy killed with fallback → `fallback` on the box
  and `/pods`; proxy killed without fallback → box offline, `failing` on `/pods` through the lane; the owner's "turn
  off" left at `.com` reached the box in 129 s (a password or a stranger's signature refused at the lane); Activity
  has fallback/failing/changed. ohttp-failure: relay machine stopped → trickle waits (retry 5 min, next tick doesn't
  try), near lapse goes direct with the marker (`.com` direct-fallback counted), relay back → through it again. The
  near lapse is the plan as it would read 12 h before lapsing (one voucher is 3 days; `.com` credits from the real
  plan).
- **Product bug fixed** (`417c59cc1`): a redeem of several vouchers credited only the first and reported the rest
  `voucher-spent` while consuming them all (inside a D1 batch `meta.changes` isn't the statement's own count). An
  overage block was refused and its five vouchers lost; any catch-up spend of two or more lost all but one. The
  nullifier insert now uses `ON CONFLICT DO NOTHING RETURNING`; storage test runs the D1 store behind a batch that
  reports running totals (fails on the old code). Verified live (3 fresh vouchers → credited 3).
- Seen, not changed: `POST /api/vouchers/test-issue` used 252 ms CPU for 30 blind signatures (gym only; Workers Paid).
- Cost: UpCloud credits 332.07 (R1's end) → 227.92 (≈ €1.04, includes the demo server's own time since R1): two
  8-core artifact builds, three fleets of up to 3 boxes, one 1xCPU SOCKS VM. Fly: gym relays ~1 h, the OHTTP relay
  ~1 h (shared-cpu-1x 256 MB). Let's Encrypt: one certificate per gym box. Time about 19:00-20:10 UTC.
- Leftovers: none. UpCloud lists only `playstore-test-0725`; gym servers 0, gym DNS records 0 (zone at its base 40);
  gym relays stopped (autostart off); `flagship-ohttp-relay-gym` destroyed; gym lock released.
- Not covered live: the box lane while the relay is also down (goes direct, marked: unit-tested only), Stripe, Apple
  and Google purchases (no test keys), the phones' OHTTP clients (only the webapp's code ran).
- Resume point: merge `0.4/gym-r2-fixes` (owner), then D11, R2-R4 and the E UI pass.
- Merged 0.4/gym-r2-fixes: the voucher redeem bug (with several vouchers per redeem, only the first was credited and the rest were consumed; fix 417c59cc1) plus the vouchers, outbound-proxy and ohttp-failure live groups. R2 live: core 30, vouchers 10, outbound-proxy 8, ohttp-failure 7, update 9, all green.

### 2026-11-17 — Owner: "do all that is left … keep going until the app is ready"; browser steps go to a Claude-in-browser session
Three agents started:
- 0.4/ci: F11 (Android emulator smoke API 34, iOS CI green), F6 (DNS token off `.com`), F15 (rate-limit client loops).
- 0.4/release-prep: R2 (version bump), R3 (release notes in 7 languages, store texts), R4 (docs/runbooks/0.4-deploy-sheet.md), F13 (feature-branch rebases, AGENTS.md), and docs/runbooks/0.4-browser-tasks.md, the brief for the owner's browser Claude (App Store Connect, Play, Stripe, Oblivious, Cloudflare; secrets never pasted into chat).
- 0.4/ui-pass: E. Screenshots of every screen before and after, the critique, one commit per change, and a before/after page for the owner to approve per change. Includes the iOS empty Inbox text.

### 2026-11-17 — R2-R4 and F13 prepared on `0.4/release-prep` (pushed, not merged)
- R2: `release/version.json` 0.4 Beta, iOS 1.3 (9), Android 12 (Wear 1000012), Studio 0.4.0; `check-versions --write`,
  parity green. Webapp `buildInfo.js` changed: bump the shell at merge (not done here, to avoid clashing with the UI pass).
- R3: `docs/release-notes/0.4.md` (source, with release-day conditions: calls need `VOICI_CALLS` on after the store
  builds, rails need their secrets, direct names need the zone secrets and the `*.fshp.app` clean-up); blog post
  `blog/flagship-0-4.html` + index, feed (`TODO-RM` pubDate) and landing link, 7 languages; `store/listings/*.json`
  rewritten for 0.4 (the "nothing to buy" line replaced: each store's text names only its own in-app purchase).
  Store art: rendered, 43 images need no capture; 245 native captures missing (iOS/Android/Wear, 7 languages).
- R4: `docs/runbooks/0.4-deploy-sheet.md`; `release.sh` 48 steps (new step 11 signs the webapp shell; the old
  transition-relay step now refuses to replace the live mesh; 0.4 secrets in the secrets check), test green;
  `docs/runbooks/0.4-browser-tasks.md` for the owner's browser session; 0.4 review notes.
- Found: `main` has two commits `release/0.4` lacks as ancestors (`881f7757e` terms, already here as `86739fc31`;
  `eb43ae84c` gym relays off, cherry-picked on the prep branch), so the final fast-forward needs a rebase or an
  `-s ours` merge first (deploy sheet §1, owner). `apps/web/public/pro.html` still describes the hand-operated
  0.2 Pro ("send money, tell us your username"): contradicts 0.4's vouchers; rewrite before launch.
- F13: nothing rebased. Folded into 0.4: marketplace, custom-names, custom-domains, outbound-proxy; superseded:
  feat/browser-extension. Conflicting with release/0.4: other-os-installers 18 files, alpine 31, feat/retail 39;
  `gym` superseded by `gym-0.4`. AGENTS.md status rewritten for 0.4.
- Disk hit 0 bytes free during this work (another agent's 3.4 GB DerivedData in the shared scratchpad `dd-ios`);
  it recovered on its own.
- Merged 0.4/release-prep: version 0.4 Beta (iOS 1.3 (9), Android 12 / Wear 1000012, Studio 0.4.0), shell v233, release notes and blog in 7 languages, store texts, docs/runbooks/0.4-deploy-sheet.md, release.sh at 48 steps (step 20 can no longer replace the mesh relay by accident), docs/runbooks/0.4-browser-tasks.md, AGENTS.md. Open: main has 2 commits release lacks (both duplicated here), so at the end rebase release/0.4 onto main (linear, per the 2026-10-24 decision); pro.html still describes the manual Pro (needs rewriting); 245 native store captures needed.
- Merged 0.4/pro-page: pro.html describes the 0.4 plans, buying by voucher on each rail, the Oblivious main relay, $5 data blocks, and the no-refund reason, in 7 languages (machine drafts). Owner decides: keep the name-change section (no purchase flow in 0.4), whether to drop noindex at launch, and final prices.
- Merged docs/plans-and-backup-offer.md: recommends keeping Free/Pro/Pro Max, adding Business at $6/seat (min 3), cluster backup on Pro+, Flagship Vault (E2E off-site backup, included plus prepaid blocks), and invoiced blind voucher batches for companies. 15 owner decisions. Design only; nothing in 0.4 changes.
- Owner, 2026-11-17: the enterprise concept is built in 0.5 (docs/release-0.5-list.md started).

### 2026-11-17 — F6, F11, F15 done on `0.4/ci` (pushed, not merged; tip after `31d8640d8`)
- **F11 green.** Android run 44180321542 and iOS run 44180316036 (both on `31d8640d8`): unit tests, emulator / UI
  smoke and the iOS release-clean build all pass. Fixes it took: Android gym runs on mocks make no account calls to
  `.com` (no read-token minter, no PQ binder, account-gone names nothing: a stray 404 had put the account-removed screen
  over every later scenario); iOS CI fetches `@ibisllc/maintainers` (the conformance vectors) and uploads the unit
  result bundle on failure; iOS CallKit's start-up `providerDidReset` showed "Call ended" over the whole app on an idle
  phone (four UI smoke failures; a real bug, not only CI); PolishRules (fixed sizes, rounded fields, teal text, four
  "box" strings, renamed in all seven languages) were already red on `release/0.4` from the folded branches; voi.ci call
  sockets now go through the update lock. `main`'s iOS workflow has been red since 2026-11-06 (not looked at; `main` fails PolishRules on `MessagesTabIcon.swift`).
- **F15.** `builder-pipe-upgrade`: `.com` answers an outdated Studio itself before the upgrade budget and the session
  object (`refuseOutdatedStudio`), and the Mac Studio waits 5/10/20/40/60 s before a new session after one the relay
  never accepted (as Windows and Linux do; build + 19 pairing tests green). `account-resolve`: boxes hold their calls
  about an account `.com` says is gone (15 min doubling to 6 h; `accountGone.ts`), and mocked Android gym runs no
  longer mint read tokens for the fixture account. Re-check `npm run rate-limits` a week after the deploy.
- **F6 (code done, owner steps left).** The broker's `POST /service` writes and deletes only `_acme-challenge` TXT
  (pinned ACME account digest when set) and reads the zone; `.com` uses it when `DNS_BROKER_URL` + `DNS_BROKER_SECRET`
  are set; release step 20 deploys it. Owner: deploy the broker, set both, issue one certificate through it, then
  `wrangler secret delete CLOUDFLARE_DNS_API_TOKEN`. After that `.com`'s legacy DNS clean-ups (account-event record
  removal, demo/gym teardown records, the opt-in legacy sweep, its own stale-challenge cron) skip quietly; the broker's
  hourly cron removes stale challenges, and the wildcard layout writes no per-account records.
- Checks: vitest (com, dns-broker, server-daemon, release) 5,717 green; `npm run i18n` ok; `npx tsc -b` clean. The 66
  `tsc --noEmit -p apps/com` errors are in files this work did not touch (40 in `controlPlaneRoutes.ts`, tests,
  `servingAuthority.ts`) and predate it; `tsc -b` is the gate.
- Resume point for 0.4/ci: merge it into `release/0.4`, then tick F6 (owner steps pending), F11 and F15 above.
- Merged 0.4/ci: CI green on iOS and Android; F6 broker path; F15 loop fixes; iOS 'Call ended' at launch fixed (CallKit reset); PolishRules fixed. main's iOS workflow has been red since 2026-11-06 (it goes green when release/0.4 lands).
- Owner correction, 2026-11-17: the enterprise features go in 0.4, not 0.5. Agent on 0.4/business: the Business plan at $6/seat (min 3), org gating, a 10-seat 30-day trial, the org wallet, and invoiced blind voucher batches, with the plans doc's recommended answers as provisional defaults. Cluster backup and Vault stay in 0.5 unless the owner says otherwise.
- Resume point (usage limit, 2026-11-17 late): two agents were stopped mid-work. Their work is local in its worktree; unpushed commits may exist, so check with git status/log.
  - E UI pass, ~/flagship-0.4-ui on 0.4/ui-pass: BEFORE captured (web 294, iOS complete, Android none); ~15 fixes committed (webapp, voi.ci, iOS). Still to do: the Android port, 4 webapp items, the voi.ci rebuild, AFTER captures (iOS phone-light and part of iPad done), the before/after page, the gyms, then rebase (shell v234) and push.
  - Business plan, ~/flagship-0.4-business on 0.4/business: build per its brief (plans doc defaults); state unknown.
  Then: merge both, the owner's browser tasks, the deploy.

### 2026-11-17 night: resumed after the usage limit; four owner requests
- Resumed the UI pass (now also keeps every capture in `~/flagship-art-review/2026-11-ui-pass/` for an art critique, store pages included) and the Business plan (finishing its own iOS/Android parts).
- New agents:
  - `0.4/voici-front`: voi.ci front door for newcomers, French-first (doc `docs/voici-front-door.md`).
  - `0.4/phone-apps`: design only (`docs/phone-hosted-apps.md`, `docs/phone-apps-copy-proposal.md`), for apps that are dormant on .com, a mailbox while the phone is offline, and live while it is online.
- Stripe and Apple payment set-up: no browser reaches this session; it stays with the owner's browser Claude (`0.4-browser-tasks.md` §B, §D).
- Both the UI pass and Business took shell v234; renumber whichever merges second.
- Resume point: wait for the four agents; merge the UI pass and Business (renumbering the shell), then voici-front. Phone-apps is docs only; its copy waits for the owner. Then the owner's browser tasks, then the deploy.

- Merged `0.4/phone-apps` (docs only). Proposal: a spike in 0.5, then forms/polls in 0.6 and shops/booking in 0.7, about 118 engineer-days. Rules are data, interpreted in the app (Apple 2.5.2); 8 owner decisions are in the doc.

- Merged `0.4/voici-front`: the voi.ci root now serves a static front door (French first, App Store and Play links, works when storage is down), and every page has a "Make your own page" footer. Gates green. Owner decisions are in `docs/voici-front-door.md` (trademark, calls are off in prod, noindex, share image, vous/tu, native review).

- Merged `0.4/business` (20 commits; D1 0156; shell v234). Gates are green, iOS unit tests and the iOS gym pass, and Android unit tests pass. The Android gym is NOT run (local AVDs broken for every class, so it is not this branch); run it in CI or a cloud session. Owner calls: Android voucher-file import vs the doc §4.3 and Play billing policy; a finance buyer with no account; Stripe invoicing answer. The UI pass must renumber the shell to v235 at merge.

- Merged `0.4/ui-pass` (38 commits, shell v235). Gates are green; web gym 151 passed; iOS gym 28 passed, 1 skipped; Android gym 23 OK. The before/after page (19 cards) and 1,465 shots for the art critique are in `~/flagship-art-review/2026-11-ui-pass/`. Found on release/0.4 before the merge: voici-call.spec handed-off and anonymous calls stall at the phone harness "won" (status idle). An agent is investigating.
  Before/after page published privately for card approval: https://claude.ai/artifact/9zbXGKeRJMjhYpWJ2cP2Ar
- Resume point: wait for the callspec agent (`0.4/callspec`), then the owner card approvals (revert any dropped cards), the owner browser tasks, the final rebase on main, and the deploy.
- Merged `0.4/callspec`: the stall was the test, not the product (it ran without its fake-microphone config after the "no microphone" message landed). The spec now brings its own fake devices; voici-calls passes 3/3 and the voi.ci gym 72/72.
- Owner approved every UI card except the iOS publish bar (card 11, third part): reverted (the pill stays). The iOS app builds.
- Final rebase: release/0.4 now sits on top of main (eb43ae84c), 789 commits, linear; the tree is byte-identical to the tested tip. A fast-forward of main is possible when deploying.
- Owner decisions (2026-11-17 night): apply phone copy set (a) [agent 0.4/phone-copy]; voi.ci pages noindex by default with a switch, and calls ON in 0.4 [agent 0.4/voici-decisions]; "Load into Flagship" voucher link (vouchers only in the URL fragment, no username) on all three apps in 0.4, B6/C review notes to be rewritten [agent 0.4/voucher-link]. The browser agent is running the owner's brief (A, B1-B5, C1-C4, D, E, F1); B6/C5 wait for the builds.
- Resume point: merge the three agents, then deploy prep.
- Owner: Business defaults kept; voi.ci keeps "vous"; a per-page share image (added to 0.4/voici-decisions); trademark search not now. `0.4/phone-copy` is done (4 commits, gates green); the og:description follow-up is running.
- Merged `0.4/phone-copy` (5 commits: homepage, store texts, iOS, Android, og:description). Gates green. iOS strings not compiled (literals only; the catalog check is ok).
- Owner: calls go on in 0.4 with China no-ring mode and the relay gaps accepted; the privacy calls section is being drafted (0.4/privacy-calls, for approval). voucher-link: webapp and iOS done, shell v236, Android finishing. voici-decisions: web done, native finishing; it will renumber its shell above v236.
- Merged `0.4/voucher-link` (shell v236): a "Load into Flagship" link with vouchers only in the URL fragment, a signed-out web shop, and iOS/Android/webapp import. Gates green; vitest 7274 passed; iOS gym and Android emulator gym 2/2. Owner calls: build the prod voucher key into the apps (after the ceremony), a shared "couldn't add" sentence, the wallet always merges.
- Merged `0.4/privacy-calls`: privacy §2.12 "Calls on voi.ci" (owner approved) plus the fixes: a removed or taken-down page deletes its call data; the device room URL carries no account name. Also an allowlisted parity detection miss (Android routes /app/vouchers by its path). Open: the ring and ring-back URLs still name the account.

### RESUME POINT (2026-11-17 ~23:00, usage limit near): read this first on "resume 0.4"
release/0.4 is rebased on top of main (linear), and every merged branch is in it. Shell v236.
Two agents may be mid-work. Check each worktree with `git status` and `git log origin/release/0.4..HEAD`:
1. `~/flagship-0.4-voici-decisions` (branch `0.4/voici-decisions`): the "Show in search engines" switch for voi.ci pages (`showInSearch` in the signed index; noindex by default) and the per-page share card (a signed `share` piece, 1200x630 JPEG ≤256 KiB). Web, protocol, .com and Android are committed (c01be929f).
   - Left to do:
     - commit the iOS diff (SocialTab, MessagesStore, VoiciShareCard(+Tests), PageControlsTests, GymMessagesTests, i18n/ios via `i18n-ios.mjs build`);
     - build and test iOS;
     - add parity rows for the switch and the card;
     - rebase, collapse the shell bumps to ONE at v237 (buildInfo.js, service-worker.js incl. precache lib/voiciShareCard.js, release/compatibility.json, apps/web/tests pins);
     - full vitest, push, ff-merge.
   - The calls readiness checklist is §3a of docs/runbooks/0.4-deploy-sheet.md: calls go ON (owner decision) after the store builds are live.
2. `~/flagship-0.4-ring-names` (branch `0.4/ring-names`): make `POST /api/voici/pages/<u>/ring` and `POST /api/voici/web/ring-back?u=<u>` name-free (an opaque id; accept the old form too) on .com, iOS, Android, webapp and voi.ci. Update privacy §2.12 to say every call address is name-free.
   - HARD OWNER UX RULE: voi.ci/<username> must still lead to a direct-to-phone, quantum-secure call. Prove it with `apps/web` `npx playwright test e2e/voici-calls/` and the voi.ci gym (add a test if needed).
   - If the webapp changes, use shell v238.
Merge order: voici-decisions (v237), then ring-names (v238). Gates for each: npx tsc -b, npm run i18n, `npm run parity` (read EVERY line, not the tail), relevant vitest, native unit tests under the lock /private/tmp/claude-501/flagship-locks/native-build.lock (mkdir + an `owner` file; under caffeinate -dimsu).

Then the deploy (docs/runbooks/0.4-deploy-sheet.md, scripts/release.sh; ask the owner before every outward step).

Owner decisions made tonight (all applied unless noted):
- UI pass: all cards approved except the iOS publish bar (reverted to the pill).
- Phone copy set (a) applied; set (b) waits for phone apps (docs/phone-hosted-apps.md: spike 0.5, feature 0.6/0.7).
- voi.ci: front door live in 0.4; "vous"; a per-page share image; pages noindex by default with a switch; calls ON in 0.4, with China no-ring mode and the relay gaps accepted; trademark search not now.
- Business: defaults kept ($6/seat, min 3, 10-seat 30-day trial, 100 GB/seat pooled, batches ≥100).
- Voucher "Load into Flagship" link on all three apps (merged). Privacy §2.12 calls section approved (merged), with the two privacy fixes.
- Let's Encrypt fshp.app request: 1,000/week, account https://acme-v02.api.letsencrypt.org/acme/acct/3960486542.

Open owner items:
- The owner's browser Claude is running 0.4-browser-tasks.md A, B1-B5, C1-C4, D (incl. D10), E, F1. B6/C5 (review submissions) wait for the 0.4 builds.
- Build the prod voucher key into the apps after the PQ/key ceremony (next update).
- Add a shared "couldn't add vouchers" sentence on all apps (Android says "Sign in…" on non-offline errors).
- "Build a service" → "Build an app" everywhere? (asked, no answer yet)
- Android voucher-FILE import: keep or remove? (asked, no answer yet)
- The native translation review, the 245 store captures, YubiKey signing, the DNS broker steps.
- Art critique: ~/flagship-art-review/ (1,465 UI-pass shots plus the voi.ci front door). Before/after page: https://claude.ai/artifact/9zbXGKeRJMjhYpWJ2cP2Ar
- Merged `0.4/voici-decisions` (shell v237): the voi.ci search switch (noindex by default), the per-page share card, the calls readiness checklist (§3a), the ring-watch fail-safe fix, and an iOS fix (ImageIO on iOS 26 adds EXIF/Photoshop APPn, now stripped). The iOS build and tests pass (30/30, 8/8, gym 2/2); the Android unit tests and gym 8/8 pass.
- **TO FIX (failing on release/0.4, found by the full vitest; not caused by voici-decisions):**
  (a) tools/adversarial/tests/envelopeForgery.test.ts AT-ENV-10: classify the tags voucher-link/v1, voucher-batch/v1, org-voucher-wallet/v1, org-voucher-wallet-write/v1 and org-plan-attestation/v1 in tagInventory.ts;
  (b) tools/gym/tests/webRegistry.test.ts: register the 2 voucher gym specs as scenarios;
  (c) scripts/check-versions.test.ts: 6 tests still expect 0.3 (version.json says 0.4);
  (d) scripts/ios-release-clean.test.ts: GymCallStagePreview.swift:8 names GymSweepSeams/"-smoke-" in a Release-compiled file (wrap it in #if DEBUG).
- Resume point: ring-names (agent running; worktree ~/flagship-0.4-ring-names, shell v238 if the webapp changes), then fix (a)-(d), then the deploy.
- Browser tasks done by the owner's browser Claude; results are kept at docs/runbooks/results/0.4-browser-tasks-results-2026-11-17.md (no secrets). Agent `0.4/browser-followups` (worktree ~/flagship-0.4-browser-followups) is acting on its "What the code / repo needs to act on" list and fixing the runbook drift. Do NOT do the "Left for the owner" items. Play C2 (products) is blocked until a 0.4 bundle with BILLING (versionCode 12) is on a testing track: a deploy step.
- browser-followups: items 3, 4 (code), 5 (code), 6 done: voucher Stripe calls pin `2025-03-31.basil`, basil snapshot refund/dispute fixtures pass, `statement_descriptor_suffix` FLAGSHIP on packs and batches, batches cards only (Checkout bank transfer needs an existing Customer), inclusive tax + txcd_10000000 tested.
- browser-followups: item 2 done: APNs "Flagship push" key recorded (deploy sheet "APNs key", voici-calls.md, v1-operational-tasks.md); JWT names only kid/iss, topic per push, APNS_HOST picks env; test added in pushBridge.test.ts.
- browser-followups: items 4, 5 (docs), 8, 10 done: browser-tasks status table + drift fixes + "Stripe live pass" section; payments-setup sandbox/Workbench/basil, suffix not account descriptor, invoice prefix a caution, Play SA documented, bank transfer = cards-only Checkout + manual send_invoice (open gap: no auto issue for a paid invoice).
- browser-followups: items 7, 9 done: deploy sheet "Store builds" orders upload 0.4 bundle to internal -> C2 products -> test, C4 send-for-review noted; no /user/tokens/verify call exists; zone id a697107564580e33cd2dc75d30f9ff57 recorded in deploy sheet + browser tasks.
- browser-followups: item 1 done: iOS already shows StoreKit displayPrice (PlanScreen, OrgPlanScreen); mock store + FlagshipVouchers.storekit now price the 120 pack $119.99, VoucherShopTests checks it; B3/A2.3 tables and the review note ("each worth $1 of credit; $10.00, $30.00, $119.99") fixed; no $120 in store/listings or release notes. iOS package tests green on sim (19, 1 skip); full FlagshipApp archive build skipped: disk fell to 4.3 GB.
- browser-followups: gates green (tsc, i18n, parity 0 red, 11 vitest files / 116 tests). Pushed 0.4/browser-followups. Item 10 last bullet (older copies of the runbook on 0.4/release-prep, 0.4/pro-page, 0.4/plans-design) left: those branches take release/0.4 when they rebase.
- Merged `0.4/browser-followups`: App Store pack at $119.99; APNs key note; Stripe basil version pinned, with tests; the FLAGSHIP descriptor suffix on voucher sessions; batches take cards only, with bank transfer as a manual Dashboard invoice (GAP: a paid invoice does not mint vouchers yet, so do not promise bank transfer); tax-inclusive test; Play C2 order in the deploy sheet; runbook drift fixed. The full FlagshipApp build was not run (disk); run it at the deploy.
- Merged `0.4/ring-names` (shell v238): the ring is `POST /api/voici/rings/<ringId>`, the ring-back is `POST /api/voici/web/ring-back` (no query); old forms accepted. Fixed a pre-existing bug: app device-signed ring-backs always failed (the canonicaliser path rule). New e2e `voici-call-frames.spec.ts` proves voi.ci/<username> leads to a phone call with sealed 88-byte frames, anonymous and signed in (5/5). Still names the page (by design): the call-challenge GET and the page lookup.
- Resume point: fix the 4 failing tests (a)-(d) listed above, then the deploy per docs/runbooks/0.4-deploy-sheet.md (owner OK at each outward step; run the full FlagshipApp build first).
- Agent `0.4/stale-tests` (worktree ~/flagship-0.4-stale-tests) is fixing (a)-(d). On resume: check its branch, then rebase, gate and ff-merge.
- stale-tests: (a) fixed: AT-ENV-10 classifies voucher-link (hash), voucher-batch (kdf), org-voucher-wallet (kdf+aad), org-voucher-wallet-write (org-approval vectors) and org-plan-attestation (CA vectors) in tagInventory.ts.
- stale-tests: (b) fixed: the two gym-vouchers.spec.ts tests are registered as web scenarios (web-total-vouchers-shop-signed-out, web-total-vouchers-link-import) in tools/gym/src/suites/webPlan.ts with their screenshot points.
- stale-tests: (c) fixed: check-versions.test.ts pins the 0.4 versions once (iOS 1.3 (9), Android 12, Studio 0.4.0, plus a Wear = phone + 1,000,000 check) and every drift case now reads release/version.json, so the next bump touches only that pin.
- stale-tests: (d) fixed: GymCallStagePreview.swift now opens with a plain `#if DEBUG` (then `#if os(iOS)`), which the Release-clean scanner recognises; it was `#if DEBUG && os(iOS)`, already Debug-only but read as neutral. FlagshipApp builds for the simulator in Debug and Release (Xcode 27.1 RC), and the scan of the built Release app is clean.
- stale-tests: full `npx vitest run` 1390 files / 18565 tests passed, 0 failed (serverTransfer and sniRouterFlowControl passed in the full run); `tsc -b`, `npm run i18n` and `npm run parity` clean. Branch 0.4/stale-tests ready to merge into release/0.4.
- Merged `0.4/stale-tests`: (a)-(d) fixed. FULL vitest green: 18,565 passed, 0 failed. FlagshipApp builds in Debug and Release; ios-release-clean finds nothing.
- RESUME POINT: release/0.4 is code-complete for 0.4 and on top of main. Next is the deploy per docs/runbooks/0.4-deploy-sheet.md and scripts/release.sh (ask the owner before every outward step). Calls flip ON only at §3a after the store builds are live. Play C2 products come after the internal-testing upload. Owner items: see the browser results file "Left for the owner"; the Stripe live pass after Stripe says yes; do not offer bank transfer (gap). Open questions: "Build an app" everywhere?; Android voucher-file import keep or drop?
- Owner (2026-11-18): keep "Build a service". Android voucher-file import is removed only if (1) it could hurt store acceptance AND (2) the link is safe, anonymous and easy. Assessment: (2) holds; (1) does not, because the file import is the same consumption path as the link under Play's policy, so removing it would not change review odds. Kept as is.
- iOS voucher-FILE import: not in 1.3 (Apple 3.1.1 "license keys" risk on the first IAP review; the link already covers the case). Revisit after the IAP approval. If Apple objects to the link, the fallback is to disable it server-side or in a quick update.
- 2026-11-18: owner said start the deploy and app submission (Stripe stays on SANDBOX credentials; prod has no Stripe key, so the card rail is off). main fast-forwarded to release/0.4 and pushed (push to main deploys nothing; only release.sh does). Pre-checks: versions ok, release-guard ok, release-manifest: 19 hardware/manual receipts missing (as accepted in 0.2/0.3) plus FAILED ga-placeholders (the DMCA agent name, address and phone in terms.html: owner text needed).
- Agent `0.4/presubmit` (worktree ~/flagship-0.4-presubmit, off main): the IAP review screenshots (B3) and checking the no-card-rail UX on prod (no Stripe key). Next: the owner runs `bash scripts/release.sh --new --phase A` in their own terminal (the YubiKey steps need /dev/tty); I follow ~/.flagship-release/state.json.
- presubmit task 2 (prod with no Stripe key; `/api/payments/config` says `rails.stripe: false`): webapp Plan and the signed-out `?shop=buy` already hid the packs and said "Card payments aren't available right now." (now tested for the shop). Dead ends fixed: the Business batch button was disabled with no reason (now the same sentence under it, shell **v239**); /pro's Webapp card linked to a shop that can't sell (its script now asks `/api/payments/config` and, unless `rails.stripe` is true, swaps the sentence for "Card payments aren't available yet. Buy in the iPhone or Android app.", translated in all six languages). Tests in marketingPages, webappPlan, webappOrgPlan. Gates: tsc, i18n, parity clean.
- presubmit task 1 (B3 IAP review screenshots): `IapReviewCaptureTests` (in UITests/StoreCaptureTests.swift; opt-in on `IAP_OUT`; DEBUG seam `-smoke-iap-review` hides the gym test credit) captured Settings → Plan with the three packs ($10.00, $30.00, $119.99) on an iPhone 17 Pro Max simulator, English, light: `~/flagship-art-review/2026-11-iap-review/vouchers-{10,30,120}.png` (1320×2868, no alpha, the pack outlined) + index.md. Not copied into the repo: it keeps no store images in git (store/out, store/captures are build outputs). Simulator deleted, derived data removed, lock released.
- Merged `0.4/presubmit` (shell v239): IAP review screenshots in ~/flagship-art-review/2026-11-iap-review/ (one per pack, 1320x2868); with no card rail, the Business batch and pro.html show "Card payments aren't available yet" (the Plan and the signed-out shop already did).
- Owner (2026-11-18): payments go LIVE now on all platforms, without waiting for Stripe support's answer (owner's call). The owner enters the live Stripe key and webhook secret (wrangler secret put on prod, before release step 23). The owner registers the DMCA agent (self/company) and adds the bank and tax details in App Store Connect, then starts release.sh.
- Side task (owner, 2026-11-18): houstonautomationlab.com, the IBIS LLC company site and Stripe business website, in ~/houstonautomationlab (its own git, not this repo). The agent deploys only to workers.dev for preview. The owner removes the Cloudflare redirect rule to ibis.capital, sets up Email Routing for howdy@ and switches the Stripe website from mailypop.com. The Maily Pop acquisition wording and date need the owner's confirmation.
- houstonautomationlab.com: preview at https://houstonautomationlab-site.harrywinner.workers.dev (~/houstonautomationlab, commit f4f1779). Go-live steps: the owner reviews the OWNER: comments, removes the redirect rule, uncomments the routes in its wrangler.toml, redeploys with `npx wrangler deploy --config ~/houstonautomationlab/wrangler.toml` (from apps/com), sets up Email Routing for howdy@, and sets the Stripe website.
- DMCA agent registered by the owner (IBIS LLC, DMCA-1084982) and filled into the Terms; ga-placeholders ok. Production OHTTP_RELAYS added to wrangler.toml [vars]. Missing prod secrets before step 23: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, VOUCHER_SIGNING_KEYS, OHTTP_GATEWAY_KEYS, VOICI_CALL_POW_SECRET (APPLE_IAP_ENVIRONMENTS later). release-manifest: only the 19 hardware receipts remain.
- 2026-11-19: the owner completed pre-release steps 1-4 (Stripe live setup; prod secrets confirmed present by name: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, VOUCHER_SIGNING_KEYS, OHTTP_GATEWAY_KEYS, VOICI_CALL_POW_SECRET; Apple bank/W-9/contacts). Left: the IAP review screenshots upload (one per product, ASC → In-App Purchases → product → Review Information). Next: the owner starts `bash scripts/release.sh --new --phase A`.
- 2026-11-19, release run (pinned 2cea7d50): steps 1-13 done (CA lease renewed, endorsed 05905b23, box release sequence 3, catalog security version 2, floor 0). Step 14 gym failed to start (the worktree has no .gym-secrets.env); rerun with `GYM_SECRETS_FILE=~/flagship/.gym-secrets.env bash scripts/release.sh --from 14`. TODO release.sh: default GYM_SECRETS_FILE to the main checkout.
- Owner: HIDE the marketplace in 0.4 (findings: docs/runbooks/results/marketplace-findings-2026-11-19.md). Agent `0.4/marketplace-off`: a build-time "marketplace": false in release/version.json carried to all apps; .com MARKETPLACE="off"; the invented listings removed from the site. Must merge to main before step 23 (.com) and steps 44-45 (store builds); the owner answers yes to re-pin.
- 2026-11-19: step 14 stopped because the gym branch would not rebase onto main (1006 commits). I rebased it by hand in ~/.cache/flagship/gym-worktree: rerere for the Android variants; for the box-release pin and the abuse-key list I kept the GYM side (its own box release 8b4c168d, sequence 202610302231, the gym artifact base, the gym throwaway abuse key) and ran gen-box-release --write. Pushed origin/gym c1968ad89 (16 gym commits on main). Owner resumes: `GYM_SECRETS_FILE=~/flagship/.gym-secrets.env bash scripts/release.sh --from 14`.
- Step 14 stopped again: the gym lacked prod-only secrets (device attestation, the purge token, APPLE_IAP_ENVIRONMENTS which is a gym [vars] value). They were added to NOT_NEEDED_IN_GYM with reasons, on release/0.4 and main. The owner re-pins at --from 14.
- `0.4/marketplace-off` part 1 (switch): `"marketplace": false` in release/version.json; check-versions carries it to webapp `MARKETPLACE_ENABLED` (buildInfo.js), iOS `ProductFeatures.marketplace` (FlagshipCore, generated) and Android `BuildConfig.MARKETPLACE` (gradle reads the file); drift checks + tests.
- `0.4/marketplace-off` part 2a (webapp, shell **v240**): Services card Marketplace/Developer buttons and note, build-chooser tile hidden (`data-marketplace`, shown by app.js only when on); wizard has no "Browse marketplace"; `?view=marketplace|developer|view-marketplace|view-developer` open Home; no "Publish this app". Test `webappMarketplaceOff.test.ts`; apps/web/tests 340 files green.
- `0.4/marketplace-off` part 3 (.com): `MARKETPLACE = "off"` in wrangler.toml and wrangler.gym.toml (no gym group or spec uses it). Anything but "on" answers /api/marketplace/*, /api/developer/sales/* and POST /api/stripe/app-checkout 404 `{error:"not found",code:"marketplace-off"}` (blocks box publishing); admin + internal routes stay. route.test.ts: off (unset/off/OFF/1) and on.
- `0.4/marketplace-off` part 2b (native): iOS `ProductFeatures.marketplace` hides the Home quick action (one column on iPad), the Services tab card, the build-chooser tile and ignores `flagship://marketplace` / `/app/marketplace`; Android `BuildConfig.MARKETPLACE` hides the empty-Services button (now `NoServicesYetState`), the build-chooser tile and the deep link. Android: all 3199 unit tests green (new `MarketplaceOffComposeTest`), androidTest compiles. iOS tests pending.
- `0.4/marketplace-off` part 4 (website): removed /marketplace/ (English + 6 generated), the homepage §3 "Real services from real users" (invented listings, "A"/"B" grades, CSS, #apps nav; FAQ renumbered §3), the "Browse the full marketplace" link, every footer/nav/404 link in 7 languages, docs "Or install someone else's". i18n-web extract/build; 81 stale translations pruned per language; the shortened docs sentence translated. Tests: marketingPages (no page, no link in any language), s14 and gym-total specs, s03 runs only when on. Legal/FAQ prose that mentions the marketplace is left as it is (owner call).
- `0.4/marketplace-off` part 5 (docs): release notes "Left out on purpose" names the marketplace (switched off, opens in 0.5); AGENTS.md feature-branch note; docs/release-0.5-list.md item 5 "Turn the marketplace on" (scanner, moderation and reporting, paid apps, then the flip steps); store-assets brief + capture plan (re-capture the iOS Home shot without the card, 7 languages).
- `0.4/marketplace-off` part 6-7 (tests + gates): tsc -b clean; npm run i18n ok; npm run parity ok (no marketplace presence rows); full vitest 1391 files / 18583 tests green; webapp mock gym specs (total, builds, onboarding, smoke, sweep, ux, features, apps) 149 passed on port 8899; Android 3199 unit tests green; iOS DeepLinkTests + ProductVersionTests green (package build). Not run: the iOS UI tests (GymTotalTests marketplace-absence checks) because an app build would take the disk under 5 GB; e2e s14 (needs wrangler dev). RESUME: merge `0.4/marketplace-off` into release/0.4 before release step 23 and the store builds; re-capture the iOS Home store shot.
- Merged `0.4/marketplace-off` into release/0.4 (shell v240): "marketplace": false in version.json, carried to all apps; every entry point hidden; .com MARKETPLACE="off" (routes 404 marketplace-off, plus the paid-app checkout); the site lost /marketplace/ and the invented listings. Gates green; vitest web/com/scripts 5311 passed. The iOS UI tests for the hidden buttons were NOT run (disk).
- NOT yet on main: a release run is in step 14 (gym.lock), and step 14 itself pushes to main. After step 14, ff main to release/0.4, then the owner re-pins and RE-RUNS step 11 (`release.sh --only 11`): the shell moved v239 -> v240, so v239's signature no longer matches. Re-capture the iOS Home store shots later.
- 2026-11-19: step 14 failed on a Fly race ("machine getting replaced, refusing to start"). Fixed: gym-refresh retries the relay start for 2 min. The marketplace-off change and the fix are on main (5e73c1ae4); the gym branch is rebased (06033c1e1). Owner plan: re-pin; re-sign the shell (`--only 11`, now v240); step 14 as a narrowed run of the groups 0.4 changed (R1/R2 covered every group on earlier 0.4 commits), run by hand with `--groups`, then type verified.
- 2026-11-19 ~19:20, narrowed step-14 gym (`gym-results/release-20261119T184246Z-*` in ~/.flagship-release/worktree). arch-v2 (what new boxes use): every group green (core 30, voici 23, update 9, rollback 7, phone-route 9, browser-grants 7 = browser verdict PASS, serving, canary, catalog, outbound-proxy 8, fleet) EXCEPT three gym-setup failures: direct-access (the gym branch lacked gym-0.4's `82790718` gym apex, so the gym .com named fshp.app; the guard stopped it, nothing published), vouchers (the gym now holds Stripe + Google test secrets, so rails are on; the check demanded off), ohttp-failure (no gym relay: R2 deployed `flagship-ohttp-relay-gym` and set OHTTP_RELAYS/OHTTP_RELAY_URL gym secrets for the run). Classic: its own scope (core, update, update-rollback, stack-switch, serving) green; `--groups` also pushed out-of-scope groups onto classic (my mistake in the narrowed command), where browser-grants failed (classic is not in CLASSIC_GROUPS for it) and phone-route had a one-off route-held (green on arch-v2, relay-side, no relay code changed).
- Fixes: cherry-picked `82790718` onto origin/gym (3a8ffa3f5, pushed); vouchers check now follows each rail's reported state and an on Stripe rail must open a `cs_test_` session (catches a live key in the gym) — release/0.4 9a1b1ef01, NOT on main yet (step 14 mid-way). Creating the gym relay Fly app was blocked by auto mode: owner to approve or run it.
- Rerun plan (arch-v2 only, the three groups, from ~/flagship-0.4 so the fixed harness runs): deploy the gym relay + set its two gym secrets; `GYM_STACKS=arch-v2 GYM_SECRETS_FILE=~/flagship/.gym-secrets.env GYM_BASE_REF=origin/main GYM_REFRESH_ARGS=--skip-fly-deploy bash scripts/gym-release-run.sh --groups direct-access,vouchers,ohttp-failure` (full refresh: the gym tip changed, so a new gym box artifact). Then destroy the relay app, delete the two secrets, type `verified`, ff main to release/0.4.
- 2026-11-19 ~20:00 owner: (1) asked whether the gym still uses real Let's Encrypt certificates: YES, it does. The test CA (Pebble, docs/gym-test-acme.md, journal P3/F6b) has its code on main but was never deployed (no `flagship-acme-gym` Fly app, no `ISSUANCE_ACME_DIRECTORY` in wrangler.gym.toml, box seam 8acbc77a0 only on `0.4/gym-test-ca-gym-seam`). The three-group rerun costs a few real certificates (direct-access and vouchers boxes; ohttp-failure has none). Planned: switch the gym to Pebble right after the release (not mid-release: a new CA path in the gym would itself need proving). (2) "almost no users today": forcing upgrades and breaking old builds is acceptable (memory updated). (3) Approved the gym relay only if needed: it is (redeemVouchers, the spend through the relay, changed since R2; both vouchers and ohttp-failure drive it). Created Fly app `flagship-ohttp-relay-gym` (healthz ok) and the gym secret OHTTP_RELAY_URL; gym /api/payments/config lists it. AFTER THE RERUN: `flyctl apps destroy flagship-ohttp-relay-gym --yes` and `npx wrangler secret delete OHTTP_RELAY_URL --config wrangler.gym.toml`.
- 2026-11-19 ~23:58, three-group rerun (arch-v2, `gym-results/release-20261119T232808Z-arch-v2` in ~/flagship-0.4): direct-access 16/0, ohttp-failure 7/0, fleet 8/0, vouchers 9/1. The one failure was the test: its bogus Stripe id `cs_test_gym` (and a 3-char Play token) stops at .com's shape check (400 malformed) before any rail is asked. Fixed to well-formed bogus proofs (release/0.4, pushed). Rerunning vouchers alone with --skip-refresh (gym unchanged). Then: owner types `verified`; destroy `flagship-ohttp-relay-gym`, delete gym secret OHTTP_RELAY_URL; ff main to release/0.4.
- 2026-11-20 owner: voi.ci page UX round (agent on `0.4/voici-ux`, worktree ~/flagship-0.4-voici-ux, no deploys): Message/Call side by side; explainer "Quantum-safe encrypted communication."; one report link ("Report this page"); no language picker (browser language, not the owner's: no new identity signal, no app update); "Make your page"; one footer font; drop "Made with Flagship"; footer in normal flow; compact header on scroll (photo, name, icon buttons); posts newest first, comments oldest first. Site-only (phones publish data, .com serves the look), so it ships with the .com deploy at release step 23: MERGE BEFORE STEP 23. Terms gap to draft for owner review: §8 says we claim no licence to user content, but voi.ci hosts and shows public pages: needs a narrow host/display licence for what an owner publishes there.
- 2026-11-20 ~00:05: vouchers rerun green 10/10 (`gym-results/release-20261119T235821Z-arch-v2`): Stripe, Apple and Google rails each refuse a well-formed bogus proof 400 payment-invalid; Stripe checkout opens a cs_test_ session (the gym's key is test-mode); spends via the relay. Step 14 is GREEN: arch-v2 all groups across the runs, classic its own scope, browser verdict PASS (appBrowser stays true). Cleaned up: Fly app `flagship-ohttp-relay-gym` destroyed; gym secret OHTTP_RELAY_URL deleted (gym config lists no relay; wrangler's list lags). Owner: type `verified`. release/0.4 is ahead of main with test + journal commits only; ff main at the next pause. 0.4/voici-ux must merge (and main re-pin) before step 23.
- 2026-11-20 owner, voi.ci round 2: buttons before links; footer back to small uppercase mono (callout keeps its colour); post permalinks `#p-<id>` with a copy/share icon and scroll-to (loading older chunks): given to the agent on `0.4/voici-ux` (also commits the gym footer-check fix). Links: already capped at 12 (§2.4). Capped server copy of posts with older chunks fetched from the phone, and comments/reposts (quote post = own stream; plain repost = shared stream): written into docs/release-0.5-list.md items 6-7 (need a phone update and a new index version, so 0.5). Release: step 14 green but not yet `verified` in release.sh state (done 1-13).
- 2026-11-20: merged `0.4/voici-ux` into release/0.4 (both rounds: Message/Call row before the links, quantum line, compact bar, one report control with the abuse link in its sheet, mono footer, no language picker, posts newest first, permalinks #p-<id>; gym footer check updated). Gates: tsc ok, i18n ok, parity 0 red, versions ok, vitest voici-site + com 78 files / 1070 tests. Needs main (ff) and a re-pin before release step 23. Terms §8 voi.ci licence drafted, waiting for owner approval.
- 2026-11-20 owner, app UX round for 0.4 (no new release soon, so in the 0.4 store builds): agent on `0.4/social-ux` (worktree ~/flagship-0.4-social-ux): (1) one-time "Get your own voi.ci page" sheet right after account creation (Set it up → page editor; Not now), with a server-driven localized promo slot shipped empty; "anonymous" not used (the owner's page is public); (2) "Page options" → "Social options"; Who can call loses "Anyone signed in with Flagship" (signed-in maps to callback, first publish defaults to callback; .com still accepts signed-in); the app's own DND removed (phone's DND/Focus decides); "Only at certain hours" → "Set business hours"; "Remove page" → "Turn off social features"; (3) welcome illustration: globe instead of the lock; design audit after. MUST merge before release steps 44/45 (store builds) and step 23 (.com: promo config). Pushed back: capping stored posts is not needed in 0.4 (storage is small; the phone-fetch design stays 0.5 item 6).
- 2026-11-20 owner: intro sheet leads with features, not "voi.ci" ("Turn on safe messages, calls and posts"); Yes/No with a bright "Turn on" that publishes the page public with first-publish defaults (rules agreement kept) then opens the editor; sent to the `0.4/social-ux` agent. Comments (0.5): commenters = whoever may see the page; per-post sticky "Allow comments"; no approval queue (owner delete/block, report and takedown kept); in docs/release-0.5-list.md item 7.
- 2026-11-20 owner: NO gym rerun for the UI round (cosmetic: app screens, the voi.ci site look, strings, a .com promo var). release.sh's re-pin only warns ("untested by the gym run above") and keeps step 14 done. Plan: verified → steps 15-22 → stop at 23 → merge 0.4/social-ux, ff main → re-pin, `--only 11` (shell moves) → `--from 23`.
- 2026-11-20: `0.4/social-ux` done (tip cbe3184e6; webapp shell v241, needs step 11 re-sign): intro sheet after Secure your account (not before: Turn on would skip the backup step), Turn on = rules + public warning + first publish (messages on, calls callback, noindex) then the editor; promo via `GET /api/voici/promo` and wrangler vars VOICI_PROMO/VOICI_PROMO_UNTIL (empty); Social options rename; signed-in removed (maps to callback); in-app DND removed (iOS CallKit honours Focus, Android channel never bypasses DND); "Set business hours" (the existing synced sealed setting); "Turn off social features"; globe on Welcome (iOS, Android, webapp gains the illustration). Gates green (vitest 6893, webapp gym 80/80, Android 3205, iOS unit 44 + UI 5/5). Follow-ups sent: iOS Welcome title truncated ("Your stuff,…"), Android/webapp callback label = iOS. Independent design audit of the globe running. Freed 3.7 GB (rust/target + node_modules in merged worktrees mkt-off, voici-decisions, stale-tests, voici-ux).
- 2026-11-20 design audit (independent) of the Welcome globe: ship with small fixes. Sent to the social-ux agent: teal dots at ~50% (privacy path visible, no extra badge), iOS globe semibold ~21pt, one key glyph and server colour on all apps, web dot contrast >= 3:1 and button label >= 4.5:1, iOS headline up 60-80pt, web gets the same headline/subline as iOS.
- 2026-11-20 owner approved the Terms §8 voi.ci licence: added (store, copy and show what you publish, only to run voi.ci incl. caches and link previews; ends on removal), Last updated 2026-11-20; Terms are English-only. apps/web tests 3784 passed, i18n ok.
- Step 14 outside-the-runner checks: `dns-ent-experiment.ts --canary` exit 0 (root wildcard still answers under a TXT); gym.flagshipserver.com/api/health 200; flagship-services-gym.fly.dev:8443/api/health 200 (relays started for the check, stopped again). Not covered by the gym: the static webapp Worker; the .com deploy's post-checks (step 23) are its first test.
- 2026-11-20: step 15 stopped: disk at 0 GB (the social-ux agent's iOS build, .dd 1.8 GB plus simulator data). Freed to ~6.9 GB: rust/target in every 0.4 worktree but social-ux, node_modules in clean merged worktrees, `xcrun simctl delete unavailable`. Agent told to clean after each build and stop under 5 GB. Owner resumes `release.sh --from 15`.
- 2026-11-20: `0.4/social-ux` follow-ups done and rebased onto release/0.4 (10 commits; tsc, i18n, parity, versions ok): Welcome title shows in full (iOS; SE + largest type checked), Android/webapp callback label = iOS and the webapp picker drops `accepted`, audit fixes (teal dots, iOS globe 21pt semibold, one key badge, web label 7.96:1, iOS headline up ~74pt, web gets the headline in 7 languages). NOT YET VERIFIED: the last two iOS edits (top-spacer cap, OnboardingSmokeTests taps "No thanks") were never compiled (needs ~3 GB; wait until the release run pauses at step 23, then build iOS + run the onboarding UI tests, then merge). No Android screenshot (no emulator).
- 2026-11-20 release run: steps 15-19 done, 20 skipped (0.3 TS hub; prod already runs the mesh: iad1 in the live directory, feed.flagshipserver.com serves it), 21-22 done; run stopped at step 23 (owner answered N). Now: iOS build + OnboardingSmokeTests on `0.4/social-ux` (rebased onto 15dac1a1e, native-build lock held), then merge, ff main, owner re-pins, `--only 11` (shell v241), `--from 23`. Owner: "update the app based on the changes" (the social-ux round goes into the 0.4 store builds, steps 44/45) and "change the deploy script so it fits the current state of the project - no more skipping outdated steps": written as docs/release-0.5-list.md (release.sh item; do before the 0.5 run). For the rest of THIS run: steps 24-27 are 0.3's one-time mesh setup (expect "already" answers; 25 says iad1 already admitted; 27's RELAY_MESH may already be on), 28 is the real relay update; 36, 38, 46, 47 are 0.3-only: skip.
- 2026-11-20 step-23 pause: `0.4/social-ux` verified and merged (ff). iOS build + OnboardingSmokeTests 5/5 (the two uncompiled edits now proven); gates: tsc, i18n, parity 0 red, versions, vitest apps/web + apps/com 415 files / 4821 tests. Build output cleaned, native lock released. main fast-forwarded to release/0.4. NEXT (owner): `release.sh --only 11` (yes to re-pin; sign webapp shell v241), then `--from 23`.
- 2026-11-20 step 23 first try refused by deploy-webapp-static.sh: GYM_SECRETS_FILE was set in the owner's environment (my instruction's prefix). Nothing deployed. release.sh defaults the gym secrets path itself: run it with NO prefix. 0.5 release.sh item: unset GYM_SECRETS_FILE for the .com deploy (or never document the prefix).
- 2026-11-20 step 23 done (.com + flagship-webapp deployed; GYM_* env had to be unset in the owner's terminal). Revocation key prompt: answered N (unchanged since 0.3; FLAGSHIP_RELAY_LOG_PUB and FLAGSHIP_SERVING_REVOCATION_PUB share Fly digest e9e9f4a1). Steps 24-27 SKIPPED, verified live first: Fly secrets FLAGSHIP_RELAY_KEY_SEED/RELAY_LOG_PUB deployed, iad1 in feed directory, certs iad1.tunnel + tunnel issued and both :8443 health 200, wrangler RELAY_MESH on + TUNNEL_HUB_URL tunnel. Step 28 (Rust relay deploy) is the real 0.4 relay update; its require_done meshon warning is expected.
- 2026-11-20 step 28 done: Rust relay deployed as Fly release v48 (one machine). Demo box confirmed 0.3 (boxLevel 3); baseline tunnels 1 (from iad1.tunnel:8443/api/health). Step 29 SKIPPED: checked ~60 min after the deploy instead: no restart since (uptime 3549 s), mesh ready on iad1.tunnel and tunnel, tunnelsOnline 1 = baseline, demo box tunnel true and HTTPS 200. Relay reports version "0.3.0": rust/Cargo.toml workspace version never bumped (cosmetic; 0.5 list).
- 2026-11-20 steps 29-32: 29 skipped (checked by hand, above), 30 skipped by the owner, 31 done (both VM appliances from the 2026-11-19 runs), 32 running. Step 33 failed: it pushes to device-results/windows-2026-10-17, which no longer exists on origin; no Windows agent tests 0.4, so 33 is skipped. Plan for the rest: 34 y (expect WAIT/defer), 35/36/38/46/47 skip (0.3-only), 37 y, 39 y with "no" to the Windows acceptance question, 40-42 y, 43 paste first (VOICI_CANONICAL), STOP before 44 (iOS marketplace-absence UI tests + disk + native lock first), 45 y, 48 y.
- 2026-11-20 phase A finished (33 skipped). Phase B: step 37's gym sweep got 403: release.sh reads GYM_ADMIN_SECRET with grep|cut and keeps the surrounding quotes from .gym-secrets.env. Dry run done by hand (file sourced properly): 0 servers, 0 DNS records, zone 40 = base. Owner answers N, reruns --from 37 with skip-gym. Also: ~/flagship has stale package dist (tools need a built checkout).
- 2026-11-20 owner: "next release I want nothing with the experimental label, regardless of the testing done. it looks wrong. if possible remove it in this release too". State: Windows already off since 0.3 (69b2144850); only Linux had it (site tag + AppImage window title). Branch `0.4/no-experimental` (worktree ~/flagship-0.4-no-experimental, off main, commit df2779f22, NOT pushed): linux false, version.py stamped, marketingPages test updated (72 tests ok). Step 39's studio-release run 44830736814 had already started with Linux EXPERIMENTAL = True; I could not cancel it (auto mode refused). Owner chooses: cancel + land + rerun 39 (label gone everywhere), or let it publish and land after 39 (site tag gone at step 42; Linux window title keeps it until the next Studio build). Memory: feedback_no_experimental_label.
- 2026-11-20: studio-release run 44830736814 finished before it could be cancelled; GitHub release studio-v0.4.0 is public (Windows zip, Linux AppImage with EXPERIMENTAL = True in its window title). Pushed df2779f22 (no Experimental on Linux) to main; the site tag goes at step 42. Owner reruns --from 39 (re-pin yes; step 39 skips the build because the release exists, then points the downloads). Linux window title keeps "(Experimental)" unless studio-v0.4.0 is deleted and rebuilt (owner's call). Steps 37/38 not recorded in state: check.
- 2026-11-20 phase B: 37 (reap: nothing to reap, zone 40/200, kept records explained) and 38 skipped/handled, 39 rerun after the re-pin (pin dc9d43ef), 40-42 run. Step 43 skipped: i18n already gated at every merge; native translation review NOT done (machine drafts, as in 0.3: open owner item, not attested); store-art check moves to the iOS Home re-capture; VOICI_CANONICAL stays off (named-links never fully green). Before 44: iOS marketplace-absence UI tests + disk + native lock.
- 2026-11-20 before step 44: iOS on main (dc9d43ef era): GymTotalTests test_homeHasNoMarketplaceActionWhileOff + OnboardingSmokeTests 5/5 passed; build output deleted, lock released, disk 9.7 GB. Owner runs 44.
- 2026-11-20 owner: store listings must clearly mention communicating on voi.ci and show up in searches for voici / voi.ci. Agent on `0.4/store-voici` (worktree ~/flagship-0.4-store-voici): voi.ci lead paragraph, 'voi.ci' in the App Store subtitle, voici/voi.ci in keywords, store name 'Flagship: voi.ci & Cloud' (owner to confirm), Play short description; all 7 languages; drops 'Linux is experimental'. Store text is pasted into App Store Connect / Play by hand; App Store name/subtitle/keywords change only with a version submission (1.3 (9) now).
- 2026-11-20: store listings voi.ci round done (73df05058 on 0.4/store-voici, cherry-picked onto release/0.4; main after the run): names 'Flagship: voi.ci & Cloud' (owner to confirm), subtitle 'Calls & messages on voi.ci', keywords lead voici,voi.ci, lead paragraph on messaging/calls, no 'experimental'; listings.mjs counts ok. Calls text assumes calls go ON per deploy sheet §3a.
- 2026-11-20 step 44: archive built by release.sh; first upload failed (Xcode RC account session expired: 'App Store Connect access for 8G8RHBU9BN is required'); owner signed in again and uploaded the same archive (~/.flagship-release/ios.FFwcMV) by hand with xcodebuild -exportArchive: Upload succeeded, iOS 1.3 (9). Step 44 skipped in release.sh state (done by hand). Step 45 running (phone versionCode 12 > Play's 11).
- 2026-11-20 owner: (1) browser-session instructions to finish both store submissions: agent on `0.4/store-submit` (worktree ~/flagship-0.4-store-submit) writes docs/runbooks/0.4-store-submission-browser.md, self-contained with every listing text inline (generator script under scripts/store-assets/); the session stops for the owner's yes before any final submit/rollout. (2) GitHub CI failures: agent on `0.4/ci-fixes` (worktree ~/flagship-0.4-ci-fixes, own node_modules, no native builds, no publishing workflows, never pushes main).
- 2026-11-20 ~23:30 step 48: all live probes ok (.com, .services, status, webapp 200; notices 204; both appliance manifests 200; zone-health OK, root-wildcard layout, 40/200, only warnings = playstore-test-0725's own records kept on purpose; schema ledger to 0156). release-manifest: 19 receipts MISSING/STALE, the same class of real-device proofs 0.2/0.3 accepted as known gaps; relay-echo-live verified by hand (GET /echo on 149.248.216.86:8444 names reachedAt 149.248.216.86) but not recorded; d1-export STALE only matters for the skipped scrub; box-code diff since endorsement = generated BOX_RELEASE pin (step 8) only; CAA lists only letsencrypt.org. Owner accepts step 48. RELEASE RUN COMPLETE. Next: store submissions (browser runbook from 0.4/store-submit), calls ON (deploy sheet §3a) after the stores carry 1.3 (9) / 12, store-listing commit to main, reconcile release/0.4 with main, CI fixes (0.4/ci-fixes), iOS Home store shots without the marketplace card, gym to Pebble.
- 2026-11-20 owner decisions for the store submission: name "Flagship: voi.ci & Cloud" confirmed; accept App Review's sandbox purchases (owner sets APPLE_IAP_ENVIRONMENTS=Production,Sandbox with wrangler secret put) and Play licence testers (GOOGLE_PLAY_ALLOW_TEST = "1" in wrangler.toml [vars]); Business launches in 0.4 (keep listing lines); CALLS ON NOW, before review ("the same update under review is the one making voi.ci pages and calls"; the switch idea goes in 0.5: docs/release-0.5-list.md). Privacy §2.12 (calls) was already live, so C10 holds. Gap: FCM_PROJECT_ID / FCM_SERVICE_ACCOUNT_JSON are NOT on production: Android phones with Google Play services get no pushes (call rings included) until the owner sets them; UnifiedPush and iOS work. Merged origin/main and 0.4/store-submit into release/0.4 (merge commits; force push not allowed), so main fast-forwards. Also fixed scripts/mobile-clients-inventory.test.ts (social-ux's promo GET clients were not listed; my earlier merge gates ran apps/web + apps/com only).
- 2026-11-20 ~00:00: .com deployed from main 94fdfd90f (version 45a11adc): calls ON (POST /api/voici/calls answers 400 malformed instead of 404; voi.ci permissions-policy camera/microphone=self); health 200 on .com, webapp, .services. Owner still to: wrangler secret put APPLE_IAP_ENVIRONMENTS = Production,Sandbox; FCM secrets for Android rings; one live call check (deploy sheet §3a live checks); hand docs/runbooks/0.4-store-submission-browser.md to the browser session.
- 2026-11-20 FCM gap is deeper: the Android release AAB (dc9d43ef) has NO Firebase config: release.sh never linked apps/mobile/android/app/google-services.json into the release worktree, and the local file is the placeholder project "flagship-placeholder" anyway. So FCM pushes could never reach a store build (likely true since 0.2; UnifiedPush works). Fix: browser runbook Part F (Firebase project, Android app com.flagshipserver.app, google-services.json to ~/flagship/apps/mobile/android/app/, FCM v1 on, least-privilege service account flagship-push with the FCM API Admin role; the owner runs wrangler secret put FCM_SERVICE_ACCOUNT_JSON / FCM_PROJECT_ID), then rebuild Android (same versionCode 12; not uploaded yet) with `release.sh --only 45`, which now links google-services.json and refuses the placeholder. Part B (Play) waits for the rebuilt bundles.
- 2026-11-20 owner: live call test uses iOS 1.3 (9) from TestFlight internal testing (no review needed). FCM kept as Android default (UnifiedPush overrides it when a distributor is installed); 0.5 item: a Settings line offering ntfy/UnifiedPush to keep Google out.
- 2026-11-20 CI agent (`0.4/ci-fixes`, CI/e2e/ios green on the branch) cherry-picked onto release/0.4 and main: (1) inventory allowlist for the voi.ci intro's promo GET (dedup with my earlier entry); (2) iOS VoiciIntroSheet promo read through gatedData (the update-lock gate) and (3) its icon through the type scale: both are app code NOT in the uploaded iOS 1.3 (9) (harmless: an anonymous promo GET that skips the update-lock gate; same icon size); they ride the next iOS build; (4) e2e fixture answers 404 for /shell-manifest.json (wrangler dev's SPA fallback broke the signed service worker; e2e red since 11-18); (5) nightly marketplace scan skips while marketplace is off (0.5: add SERVICES_CONTROL_SECRET, FLAGSHIP_SCANNER_PRIV_HEX, R2 secrets). Follow-up (0.5 or next shell bump): service-worker.js should treat a non-JSON manifest as missing, not broken (the gym serves the webapp without a manifest).
- 2026-11-21 ~00:05: Android bundles rebuilt with the real Firebase config (owner placed google-services.json: project flagshipserver, number 346530028971, package com.flagshipserver.app). Built in ~/flagship at the pin dc9d43ef (clean tree; the release worktree was gone after step 48; no Android change between the pin and main), under the native-build lock: gradle clean + assemble/bundle Release app + wear, check-release-clean ok for both. Verified: versionCodes 12 and 1000012; app AAB resources carry google_app_id, gcm_defaultSenderId, project_id (no placeholder); both signed with the upload cert (SHA-256 3A:83:3A:30:…:3C:6B = keystore/upload_certificate.pem). ~/flagship-release-artifacts/dc9d43ef: app-release.aab ea8f000a…7e32, wear-release.aab 5ecf8f02…6e0c; the earlier no-Firebase bundles moved to superseded-no-fcm/. Wear has no Firebase (its pushes come through the phone). Still needed for Android rings: the owner's FCM_SERVICE_ACCOUNT_JSON / FCM_PROJECT_ID secrets on .com (runbook Part F4).
- Resume point: browser session Part B (Play) with the AABs above; owner: FCM secrets, APPLE_IAP_ENVIRONMENTS; live call test on TestFlight 1.3 (9).
- 2026-11-21: Play flagged phone 12 at 1,577 fewer devices (~11% phones, 7% tablets, 45% Chromebooks vs an old internal 0.0.8): Play treats the hardware implied by 0.4's new permissions (CAMERA → camera.autofocus, RECORD_AUDIO → microphone, BLUETOOTH ≤30 → bluetooth, ACCESS_FINE_LOCATION ≤30 → location/gps) as required. Against the owner's 0.3 rule (broad reach). Fix: those features plus camera.any/front, location.network and touchscreen marked required="false"; androidVersionCode 13 (Wear 1000013; 12 burned by the upload). Owner: 12 is never published; 13 goes internal (needed for the products) then straight to production. Runbook Part B, AGENTS.md and the 0.5 list (manifest reach guard, x86 calls, native symbols) updated.
- 2026-11-21: Android 13 built at main 70dd958b (versionCodes 13 / 1000013, Firebase config in, all 14 uses-feature required=false, upload-cert signed, release-clean ok). ~/flagship-release-artifacts/70dd958b: app-release.aab 1c5f7904…561e, wear-release.aab 91474801…3c8b. The 12 folder renamed dc9d43ef-superseded-12. Resume point: browser Part B with these files (12 draft discarded).
- 2026-11-21 owner note for 0.5 (discussion item): drop the post-creation "Lock it to your device." screen in favour of Home + a cloud-recovery reminder; clarify the cloud-recovery toggle (no password field: passkey). In docs/release-0.5-list.md.
- 2026-11-21 owner, same 0.5 item: skip the post-creation backup page too; Home needs a "create your social page" reminder/link; the design (cover logo first) looks AI-generated: design pass.
