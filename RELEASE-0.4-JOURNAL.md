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
- [ ] F1 Direct access (`docs/direct-access-and-domains.md` §6): app-side direct path to public addresses, the
      direct-access order + vectors (TS/Swift/Kotlin), `.com` direct-name registry + prober + `fshp.app` records +
      issuance, clients' opt-in and name screens, take `fshp.app` off the website mirror, tests.
- [ ] F2 Subscriptions + payments: design `docs/payments-privacy-and-rails.md` (`8faecc2ec`): $1 blind-signed vouchers are the only
      currency; Apple IAP / Google Play / Stripe / Monero / Lightning (BTCPay) all sell vouchers; subscriptions as a
      voucher drip to the lead server; the box pays its own bill via OHTTP; plan via `plan-attestation/v1`. Owner
      answers its §9 Q1-Q11. DECIDED 2026-11-13: crypto = Monero only (no Lightning); no refunds; no cash by mail.
      Rest (store drip, iOS in-app vs web, Stripe vs reseller, caps, marketplace cut, prices) to discuss. Then: fold the branches, voucher core + box stash, Stripe, stores, Monero, paid apps. Was: (Q3): fold `feat/marketplace` (62 predicted conflicts; webapp shell above main's) and the
      children Q3 names onto `release/0.4`; Pro payments + anonymous vouchers end to end on all three apps.
- [ ] F3 Calls: build `docs/voici-calls.md` after the owner settles D1-D4 (plus its three voi.ci page fixes in the 0.4 list).
- [ ] F4 Retail box setup (Q2): design `docs/retail-box-setup.md` (`c69d039aa`): printed 100-bit claim code (QR + 20 chars)
      keys a local-only X-Wing handshake (`flagship/box-claim/v1`), recipe as consent, box-signed receipt pins the
      server key, 5-press reset window; no NFC/first-come in v1; drop `box_serials`. Owner answers its Q1-Q10, then build
      (phase 1 software, testable on a VM; doubles as a preinstalled image for DIY metal).
- [ ] F5 Quantum-safe everywhere, three stages (0.4 list): close the crypto-graph bypasses (hybrid admin root first;
      strict check green); hybrid channel on by default with classical fallback and a fallback count; strict default
      for new accounts after the external review. Also the hybrid release catalog and the boot client's ML-DSA key.
- [ ] F6 Take the zone-wide DNS token off `.com` (challenge TXT through the broker; release step 20 skips when unset).
- [ ] F7 UnifiedPush for de-Googled Android.
- [ ] F8 Human `voi.ci` service names (`docs/voici-service-names-todo.md`).
- [ ] F9 Windows acceptance findings (0.4 list section): W14, the silent second boot approval, first-boot daemon
      restarts restarting the certificate order, W19 empty Home, Android stale recovery banner and "another account"
      backup refusal, the Studio for Windows items, W3 Continue hint.
- [ ] F10 In-app rules sheet names the nudity / violence rule (all apps, all languages).
- [ ] F11 CI: Android emulator smoke on API 34; iOS CI green.
- [ ] F12 The Studio pairing refusal must be visible: a 0.2 Studio refused by `STUDIO_PIPE_MIN` loops on new QR codes
      (found 2026-11-13 on the owner's Mac); the current Studios must show the relay's `error` reason and stop.
- [ ] F13 Repo housekeeping: rebase the remaining feature branches and `gym` (0.4 list), smallest first.
- [ ] F15 Rate limits (first check, 2026-11-13, 30 days): `builder-pipe-upgrade` refused 2,685 from 339 sources (likely 0.2
      Studios looping on the STUDIO_PIPE_MIN refusal, see F12); `account-resolve` refused 6,019 across 1,224 usernames
      with 23 accounts in D1 (enumeration, or a client looping on unknown names?): find the callers' pattern, fix.
- [ ] F14 The parked "after launch" work (from P14): second relay by DNS round-robin, Rust production
      qualification (G10), removal of old implementations once proven (G8), gym IPv6-only, `VOICI_CANONICAL`.

### U. UX feedback lane (parallel; owner's notes, Q4)
- [ ] U1 Write each note as an item here with the screen and platform; iOS first, then port (memory rule).
- [ ] U3 (owner 2026-11-13) Social tab layout: the editor becomes the tab (old landing page removed, its features moved);
      the page previews itself (minus voi.ci's footer); title row "Your page" + Public switch + options menu (theme,
      share/copy link, accept messages); profile fields read as the live page with a pencil each; the unpublished bar
      only when something changed, spinning while it publishes; Profile / Messages tabs; Messages: who can reach you
      (all / some people), conversations vs requests; guests-only posts; comments and calls fit in without clutter.
      Prototype for critique: https://claude.ai/artifact/ABqoHvYhdTEWaDb7cGMkLt (owner will have other models critique
      it before it is built; then iOS first, Android and webapp after).
- [ ] U2 (owner 2026-11-13) The Messages tab is too cumbersome: rename it **Social**, give it a simpler icon (the message
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

## Resume point

Waiting on the owner's answers to Q1-Q4. Meanwhile: S1 (advisor sweep, read-only agent) and P3 (gym test CA) run.
