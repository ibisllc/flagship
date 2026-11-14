# 0.4 list

Work the owner has put on 0.4. F6b (the gym on a private test CA, `docs/gym-test-acme.md`) comes first, after the
0.3 release and before anything here.

## "Let's start 0.4": the playbook (owner, 2026-11-07)

When the owner says "let's start 0.4" (or similar), work through these phases in order. Keep a journal for 0.4 the
way `RELEASE-0.3-JOURNAL.md` worked (create `RELEASE-0.4-JOURNAL.md` on first start, log every step and decision,
keep a resume point). Ask the owner only for what is theirs (signatures, YubiKey, store consoles, money, decisions).

**Phase 1: close out 0.3 after the store reviews.** Read the end of `RELEASE-0.3-JOURNAL.md` (its last "Resume point")
and its open plan items, then:
1. Check the verdicts: Apple review of iOS 1.2 (8) and Google review of Android 11 / Wear 1,000,011. A rejection comes
   first: fix, rebuild, resubmit (version numbers climb). Keep `playstore-test-0725` untouched while any review is open.
2. After both stores approve: the owner signs the 0.2 "you have to upgrade" notice (journal F9); anything else the
   journal holds back "until store approval". (The `.com` deploy of the terms username-format fix, the dibs window
   2026-11-05 to 2027-05-05 and the USB seed is already live: deployed 2026-11-07 19:41 UTC.)
3. Release step 36 that 0.3 skipped (first bullet below), and fix release.sh as it says.
4. F6b: the gym on the private test CA (`docs/gym-test-acme.md`).
5. F6: hall of fame entries still held, the translation review request, hardware receipts, the weekly rate-limit check.
6. Fold what is still true of 0.3 into `AGENTS.md` "Current status", then retire `RELEASE-0.3-JOURNAL.md` to
   `docs/archive/` (its own header says to).

**Phase 2: gather every advisor's 0.4 work into this file.** Several advisors left findings that are not yet copied
here. Before building, sweep each source, check each item against the current code (many were fixed later), and add
what is still open to a section below, naming its source:
- **Windows device-test agent:** branch `device-results/windows-2026-11-05` (already folded in, section "From the
  Windows Studio 0.3 acceptance"); check for anything pushed there after 2026-11-07 (`git log` the branch past
  `8669e1970`). Any later device-results branch the same way.
- **B2 reviewers (2026-10-25):** journal Log entry "B2 OPEN, not fixed" (health route signature, gpud replay and
  unsigned claim fields, arch-v2 verdict file, keyd master freshness, TPM/PCR trial boot, premount disk binding,
  installer disk choice, model-install digest, update-receipts, rate limits, recovery record under strict, mDNS,
  5-minute replay window; NOT REVIEWED: WASI worker, flagship-runtime, flagship-crypto, typed.rs).
- **Independent security review (2026-11-02):** journal entry "SECURITY REVIEW (since 10-25, read-only)" (M1-M6 and the
  Lows) and the fix-agent entries after it.
- **voi.ci + Messages review (2026-11-03):** journal entry "B2 voi.ci+Messages review" (items 1-6, the owner question on
  one-off code targets).
- **Release-manager DEFERRED list (2026-11-02)** and the follow-ups named in journal entries (e.g. self-heal devices
  holding a wrong current IRK, from F5a item 3; offline USB burn "burn anyway" question; G9 repro fix).
- **Android and iOS store agents:** journal entries of 2026-11-06/07 (Play and App Store notes, CI).
- **`SECURITY-0.3-PROGRESS.md`, `docs/architecture-v2/REGISTER.md`:** items marked open or after-0.3.
Group the result by priority (security first, then the Windows/device failures W14 and W19, then the rest) and show
the owner the list before starting the build.

**Phase 3: build 0.4.** Work the list top to bottom, one item per commit, tests with each fix, and follow AGENTS.md's
rules (main only deploys, feature branches for unlaunched features, i18n for every user string, explicit `git add`).

- **BEFORE ANY 0.4 WORK: finish what 0.3's release step 36 skipped (owner, 2026-11-06).** The owner skipped step 36
  (reap orphaned DNS records and demo servers, then zone-health) in the 0.3 phase B run because the gym sweep half
  answered 401: release.sh runs `tools/live-e2e/sweep-cli.ts` without `GYM_ADMIN_SECRET` (it reads
  `GYM_ADMIN_SECRET || FLAGSHIP_ADMIN_SECRET`, and the release shell has neither for the gym). So neither half ran:
  (1) the production reap (`npm run reap-orphans`, dry run then `--apply`, keeping `playstore-test-0725` and every
  "left on purpose" record) and `npm run zone-health`; (2) the gym sweep (`flagship-env=gym` servers and gym DNS).
  Before starting 0.4: run `release.sh --only 36` with `GYM_ADMIN_SECRET` set from `.gym-secrets.env` (or the two
  halves by hand), and fix release.sh so step 36 loads the gym secret itself (or asks for it) and a failed gym dry run
  stops before the destroy prompt instead of asking to destroy an empty list. Also decide with the owner how the gym
  sweep should get its secret in future releases. **release.sh fixed 2026-11-08 (`c3f3cbb71`):** the step reads
  `GYM_ADMIN_SECRET` from the environment, else `.gym-secrets.env` in the main checkout, else asks silently, and
  sweeps with only that secret; `sweep-cli` exits 1 on a refused call, so no destroy prompt follows. Still to do:
  the run itself (needs both admin secrets: the Mac, or this machine with the secrets file).
- **In-app rules sheet: name the nudity / violence rule (2026-11-07).** Terms §8.2 now forbids nudity or sexual
  content and graphic real-world violence on pages and in messages (`7accf8146`, needed for the Play content rating
  answers), but the "Page and message rules" sheet's one-line summary in the iOS, Android and web apps still lists
  only illegal content, harassment, threats, spam and impersonation. Add it to the summary in every language in the
  next app builds; the sheet's "Full terms" link already carries the rule.
- **UnifiedPush for de-Googled Android (owner, 2026-11-05).** Today every push goes through Firebase
  (`apps/mobile/android/.../push/FlagshipFcmService.kt`, `PushRegistrar.kt`), so a phone without Play Services
  (GrapheneOS without sandboxed Play, LineageOS, CalyxOS, /e/) gets no pushes at all, e.g. "your server needs
  approving to start", and only sees requests when the app is opened. Add UnifiedPush as a second push path: the
  app registers with whatever distributor the phone has (ntfy, NextPush, the microG/FCM distributor), signs the
  endpoint URL like the FCM token, and `.com` sends the same content-free payload to it. Keep: pushes carry no
  content; the endpoint is per device and revoked with it; FCM stays the default where Play Services exists. Show
  in Settings which path is in use and say when none is. Also check on a real de-Googled phone what else degrades
  (Messages falls to the unattested tier; passkey recovery needs a provider such as Bitwarden or Proton Pass; the
  Wear OS companion needs Play Services on both ends).

- **Quantum-safe by default, in three stages (owner, 2026-11-05).** In 0.3 release signatures, install packages and
  new CA leases are hybrid, but "Quantum-safe protection" (the hybrid X-Wing channel and strict mode,
  `docs/architecture-v2/pq-suites.md` §13.6) is opt-in per server, and the strict crypto-graph check
  (`full-test-vm.sh` suite crypto-graph) still finds all 18 strict targets reachable through classical-only keys
  (e.g. the Ed25519 admin root authorizing app access, device enrolment, recovery). Default-on strict today would
  refuse browsers/WebViews without ML-KEM, classical connectors and older apps, while leaving those paths open.
  1. Close the bypasses the crypto-graph lists, starting with a hybrid admin root; the strict check goes green.
  2. Hybrid channel on by default wherever both ends support it, falling back to classical without refusing
     (nothing breaks; most traffic becomes quantum-safe). Measure how many sessions fall back.
  3. After the external review and with the bypass list empty: strict on by default for new accounts, a clear
     switch for existing ones, and the apps explain each refusal.

- **Take the zone-wide DNS token off `.com` (owner, 2026-11-05).** Cloudflare can't scope a token by record type or
  name, so `.com`'s `CLOUDFLARE_DNS_API_TOKEN` can rewrite all of `flagship.services`, including the `*` wildcard; a
  `.com` compromise could redirect every server name (it still could not read traffic: TLS ends on the box and the
  apps pin box certificates). `apps/dns-broker` was built to be the only holder of that token, but production never
  turned it on (`DNS_BROKER_URL` unset, the Worker never deployed; release step 20 was skipped for 0.3) and in 0.3 its
  remaining job, challenge TXT records, moved to the issuance service (`apps/com/src/certificateIssuance.ts`). Move
  those `_acme-challenge` writes (and any other DNS write `.com` still makes) behind the broker, or a small dedicated
  Worker, with a policy that allows only challenge TXT under names `.com` has an open order for, set `DNS_BROKER_URL`,
  then delete the token from `.com`. Also make release step 20 skip itself while `DNS_BROKER_URL` is unset.
- **A hybrid release catalog (owner, 2026-11-05).** The catalog root and timestamp keys are Ed25519 only
  (`tools/release-catalog/catalog.ts`). A forged catalog can only delay or withhold releases, since every release it
  names also needs the hybrid endorsement and a hybrid-signed artifact, but it belongs with the quantum-safe item.

## Advisor findings still open (swept 2026-11-13)

Plan item S1. Every source the playbook names was read and each finding checked against the code on `release/0.4`
(the fixing commits are all ancestors of it). Sources: B2 = the 2026-10-25 reviewers' "B2 OPEN" list (numbered #1 to
#15 in journal order); SR = the 2026-11-02 independent security review; VM = the 2026-11-03 voi.ci + Messages
review; the other 2026-11-03 B2 reviews (issuance/serving, updater/rescue, mesh); DEF = the 2026-11-02 DEFERRED
list; SP = `SECURITY-0.3-PROGRESS.md`; REG = `docs/architecture-v2/REGISTER.md`. The Windows branch has nothing after
`8669e1970`, and that commit's notes are already in `docs/runbooks/device-test-agent.md`.

### Security (highest first)

- **Medium. App image builds run as root and outside gVisor.** `npm ci` and lifecycle scripts run in the engine's
  build (root dockerd/podman, not rootless, not gVisor), so a hostile dependency's install script runs with the
  build's privileges. Where: `docs/architecture-v2/execution-surfaces.md` (App image builds row),
  `release/build-isolation-profile.json`. Source: SP item 9 (N12), REG P02.
- **Medium (review gap). Four Rust parts were never reviewed:** the WASI worker (`rust/crates/flagship-wasi`, the
  sandbox for WebAssembly apps), `flagship-runtime`, `flagship-crypto` (the hybrid PQ code every strict check uses) and
  the v2 `typed.rs` capability path in the broker. No later review entry covers them. Source: B2 "NOT REVIEWED".
- **Medium. Strict servers refuse their own health reports. FIXED on `0.4/security-fixes`:** the timer asks keyd
  (`flagship-keyd sign-health`, `packages/keyd/src/healthSign.ts`) for the STK signature plus the hybrid
  `pqSignature`, which `.com`'s gate already takes under the stored STK binding; `flagship/box-health/v1` is on both
  keyds' purpose lists; with keyd down it falls back to the boot key, classical only (fine while not strict). Needs
  an endorsed box release. Source: B2 #2 residual (3174b2e06 notes).
- **Medium. gpud approval residuals. PARTLY FIXED on `0.4/security-fixes`:** approvals expire after 90 days and
  can't be future-dated (the daemon asks the owner again), which bounds a withheld withdrawal; strict needs the
  owner's hybrid signature under `/boot/flagship-owner-pq.pub`; maintenance ops are refused unless root passes
  `--allow-daemon-maintenance yes`. Still open (design): a withdrawal channel to gpud that bypasses the daemon, a
  root-held owner PQ key (the /boot copy is daemon-written; none for an admin root), clients signing approvals
  hybrid, owner-signed maintenance orders. Where: `rust/crates/flagship-gpu/src/owner_approval.rs`,
  `docs/architecture-v2/gpu.md` §5. Source: B2 #3/#4 residuals (7c34cd7db).
- **Medium (design). No external review of the new crypto.** `flagship/pq-session/v1`, the hybrid KEM combiner and
  signature binding, and boot unlock v2 are unreviewed compositions; the plan says not to rely on them before an
  external review. Gate for strict-by-default (F5 stage 3). Where: `docs/architecture-v2/pq-suites.md` §15.1. Source:
  REG Q01/Q07 and blocker 6.
- **Low/Medium. keyd's master check trusts the daemon to deliver revocations. PARTLY FIXED on `0.4/security-fixes`:**
  `.com` signs (CA key) the account's revoked-grant list beside `GET /device-grants`; keyd (TS and Rust,
  `evidence.list`) checks it against CA keys root writes (`keyd-ca-keys` step, `ca-keys.json`) and signs master only
  while it holds a list issued within 7 days (else the admins get manager). Still open: rank demotions never reach
  `.com`, so a withheld one is not covered; manager rank still rests on the daemon's word. Deploy `.com` before the
  box release (without lists, keyd boxes stop asserting master). Source: B2 #6 residual.
- **Low. A box keeps serving an app certificate the CA revoked. FIXED on `0.4/security-fixes`:** the box asks
  `.com` (`POST /api/certificates/revoked`) every 6 hours whether the service revoked a certificate it serves, drops a
  revoked one and orders anew; a removed box serves its app names nothing (classic path). Residual: under keyd the
  revoked key stays in service until a replacement is activated (keyd refuses to remove the key in service), so a
  removed keyd box keeps it until it expires. Needs a `.com` deploy and an endorsed box release.
- **Low. A rogue relay among an account's top 3 ledgers can black-hole its bare phone name** (refuse claims, grant to
  a relay that does not hold the phone). Hijack is closed (7bd9412bc), but the threat table row still says relays do
  not check the admin grant chain: fix the text. Where: `docs/architecture-v2/relay-mesh.md` (threat table, "Rogue
  full relay as phone ledger"). Source: SR M3 residual.
- **Low. A daemon re-compromised on four starts can revert an arch-v2 switch** (root cannot tell it from a box that
  keeps dying). Where: `docs/architecture-v2/engine-and-rust-path.md` (Trial). Source: B2 #5 residual.
- **Low (hardware proof). Android 10 per-use biometric keys** (SR M6, 20fe07600) were proven on the emulator only with
  SELinux off; needs a real Android 10 phone with a fingerprint. **TPM trial boot:** whether GRUB measures PCR 8/9 is
  unverified on metal (B2 #7; the 900 s fallback is in `packages/boot-chain/src/unlockPremount.ts`). Source: journal
  2026-11-02 SeedVault entry, B2 #7.

### Owner decisions

- **Calls D1 to D4** (`docs/voici-calls.md` §13): D1 who may call by default (accepted conversations, recommended, or
  anyone signed in); D2 do iPads ring too (recommended yes); D3 a maximum call length (recommended 60 minutes); D4
  calls off in the China mainland storefront, or ship there without CallKit.
- **Offline USB burn / Save ISO.** The artifact preflight refuses when the control plane can't be reached
  (`.unreachable`), so an offline burn is impossible. Allow a "burn anyway"? Where:
  `apps/builder-mac/Sources/FlagshipBuilderCore/VM/ArtifactPreflight.swift` (and the Windows, Linux and Android
  copies). Source: journal 2026-11-02 (73e0e5fb1).
- **keyd rank orders have no maximum age** ("latest order wins"). Keep, or add one? Source: journal box-side B2 report
  2026-11-02.
- **Runtime manifest:** confirm that an expired or missing manifest is ignored (updates only refuse an unverifiable
  one) and that there is no check at process start. Where: `packages/server-daemon/src/runtimeVerification.ts`,
  `rust/crates/flagship-updater`. Source: journal G2 entry 2026-11-02.
- **`.com` refusal sentences are English** (e.g. `controlPlaneRoutes.ts` "Certificates are issued by Flagship now.
  Update this server."; no `i18n/com`). DEF says they stay English (2026-11-02); the AGENTS.md i18n rule of the same
  day names ".com pages and refusal sentences". Pick one and fix the other.
- **Un-revoke with a time limit:** a box comes back after un-revoke or unsuspend with apps stopped until the owner
  re-signs a policy (by design). Add an app prompt? Source: journal 2026-11-03 un-revoke entry.
- **Community adapters stay off** until the owner makes the attestation signing key, complaint salt and review key
  and pins the public half (`release/adapter-vetting-keys.json` has `keys: []`). Source: SP item 5 (SEC-ADAPTER-002).
- **R5 per-service certificates** were moved out of 0.3 (owner 2026-10-30): in or out of 0.4? Source: DEF.
- **Play: the Wear OS open-testing track** got "Wear 9 (0.2) full rollout + resume track" through the Wear opt-in and
  was submitted with the rest. Halt that track or leave it? Source: Play agent 2026-11-07.

### Other

- **IRK self-heal:** devices that already hold a wrong current IRK (from before `3de59ff78`'s IrkLineage) are not
  repaired; nothing in the code does it. Source: journal F5a item 3.
- **Re-sign the runtime manifest before ~2026-12-20** (`release.sh --only 10`; it was signed 2026-11-05 for 45 days).
  Source: journal phase A entry 2026-11-05.
- **G9 reproducibility:** the cross-machine comparison (`scripts/repro-compare.sh --second-where vm`, or against the CI
  artifact) has not been rerun since the lockfile and Node pin fix. Source: journal G9.
- **Phone route follow-ups:** the mailbox "please release" ask and a presence-list UI (the last-seen list exists, no
  UI). Source: DEF (6cd99ed7d).
- **Gym relay-mesh group needs a third relay** again (gym-c removed 2026-11-09): new seed, `gym-relay-c.sh up`,
  `relays add`. Source: journal 2026-11-09.
- **Hardware and device evidence still missing:** GPU on real NVIDIA hardware (DEF "gpu-real", REG G02), TPM/UKI/Secure
  Boot (SP item 3, SEC-MBOOT-001), the incident drills with receipts and the real-box/device runs (SP item 2), the
  rest of REG's "Blockers that code alone cannot clear".
- **REG statuses are stale** (recorded 2026-10-23, before milestones shipped in 0.3; e.g. K01 still says the TS keyd
  exposes a generic `unseal`, which is now scoped to pairing orders). Refresh it or archive it with the 0.3 docs (P13).
- **If the DNS broker is revived (F6),** its wildcard-grant check lacks the issuance service's 180-day / regGen rule
  (`apps/dns-broker/src/policy.ts`, `serverWildcardGrantOk`; compare `serverWildcardGrantInDate`).

### Checked and already fixed

- B2 #1 PQ pins: 33537330b (`releasePqPin.ts`, `caLeasePq.ts` name a key).
- B2 #2 tagged health reports through `gateBoxMessage`, #11 receipt pruning by cron, #13 strict recovery needs the
  passkey: 3174b2e06.
- B2 #3/#4 gpu-approval/v2 binds the claim fields, root-held withdrawal floor; #5 root's own switch evidence; #6 keyd
  revocations; #7 trial boot 900 s fallback; #8 premount pinned to the recorded UUIDs; #9 installer stops on 0 or 2+
  disks plus the "Disk to install on" UI; #10 model-install digest and size cap; #14 mDNS on-link only; #15 nonces on
  journal-read/v2 and stack-switch: 7c34cd7db.
- B2 #12 re-pair veto and voi.ci name rate limits; SR M1 open redirect, M2 reply scoping, M5 leftover demo rows, voi.ci
  revoke forgery, replay CPU burn, visitor IP in privacy §2.11: 477e41223.
- SR M3, M4 and the mesh/phone Lows (begin eligibility, grant ids, ClientHello SNI, signer stall, /mesh caps, own
  devices' hellos): 947b46e0b; phone claim admin-grant check on every relay: 7bd9412bc; mailbox announce relay id and
  the rest of the mesh review: 4d61f5dc4.
- SR M6 and the clipboard clear: 20fe07600; Android seed not auth-bound: b2b3faa1e.
- SR issuance Lows (budget drain, sweep revocation, wildcard grant expiry): 3174b2e06; issuance/serving review
  (delegation expiry, caps, scope, mesh epoch): a4f49b176.
- VM 1 to 5 (budget after verification, one page per pseudonym, name reuse cleanup, real sign-out, lasting bans):
  d092e945a; VM 6 one-off codes: shorten API removed, 20c1078b0; abuse path: df48cdfc9.
- Updater/rescue review (root-only updater state, rescue flood, LAN name leak, runtime floor): f202215dc; rescue
  LAN-only: 20c1078b0.
- DNS-01 grant age/regGen (3174b2e06 follow-up): moot, the routes answer 410 `dns01-retired`
  (`controlPlaneRoutes.ts`).
- DEF G7/H10: the Rust relay and the mesh went live with 0.3; DEF G2 runtime pin: wired (`flagship-updater` cli,
  broker policy).
- SP item 1 N06 key removal: closed by the owner ("not doing"); SP item 4 watch approval client side: built
  (`WatchBootKeyFlows.swift`, `WatchBootKey.kt`).
- Windows branch: no commits after `8669e1970`; its runbook notes are in `device-test-agent.md`.

## From the Windows Studio 0.3 acceptance (2026-11-05 to 11-07)

Source: branch `device-results/windows-2026-11-05` (`windows-0.3-acceptance-2026-11-05.md`, `WINDOWS-TO-LEAD-2026-11-06.md`,
lead replies). Fixed during the round and not repeated here: Failures 1-5, W18, the a11y row names, the offline start
screen, setup-error handling, the certificate-order cap (3fd80267d), and the phones' lost device ID on a cold start (the Trusted devices 403; fixed in 0.3 as iOS 1.2 (8) and Android 11). W6 and W8 pass on the release build (W9, W26 on 78ce3bc55); the report's verdict is FAIL (W14, W19).

- **W14: a just-joined admin device can't unlock a server, and says nothing.** A browser joined with "Also make this
  device an admin" still lands "under review for 13d 23h". Its Activity lists the boot approval and "Yes, this is my
  server" works, but Unlock does nothing for 6 minutes (no request, no error); the phone's Approve unlocks in 74 s.
  Decide: let a device under review unlock boots (it's the owner's own new device), or disable Unlock with a sentence.
  Also say on the phone, when the admin switch is on, that the device becomes an admin only after the review.
- **The second boot approval arrives silently.** A new box needs "Unlock device" then "Authorize device to join your
  cloud" (~80 s later); the second never prompts or notifies, so Studio sits on "Starting…" / "Taking longer than
  expected" until the owner finds it in Activity → Server approvals. Notify for it, or keep the approval screen open
  for the second step. Also: tapping a fresh order's "Waiting for approval" Home row opens the install screen, not the
  approval.
- **A new box restarts its daemon 3-5 times on first boot (exit 0)** and each restart starts a new certificate order,
  replacing the one in flight (the root of Failure 5). The box should resume its pending order after a restart, and
  the first-boot restarts themselves need a look (Studio Health shows "restarted 4x").
- **Remote (W19): approving a browser lands on an empty Home.** The browser now shows the comparison code and the phone
  connects it ("Browser connected to <server>", a 4 h session), but the browser shows the keyless "Your first server
  is one tap away" Home with Session "Unpaired" instead of the server's page.
- **Android: the recovery banner stays after a rejected recovery.** After Reject recovery (Activity: "Recovery
  rejected by an admin") the phone's Critical banner still says "Someone is recovering this account… 2 days left" on
  every screen; the browser shows Resolved.
- **Android: the account's own backup is refused as "made on another account" after the app locked** (2 of 4 opens):
  the open goes through the app unlock, then a second "Open the backup" prompt, and falls back to "Enter its passcode".
  Retry the account slot after the prompt; never say "another account" unless the account slot is really absent.
- **Studio for Windows:**
  - W10: "Restart as administrator" stops the running server before the UAC prompt, so No or a timeout leaves it
    Stopped; after Yes the elevated Studio did not start it again. Stop only after elevation succeeds, and restart
    what was running.
  - W26: a start refused for lack of memory still creates the server's disk and seed and leaves an "Install failed"
    row; a refusal before start should leave nothing.
  - A recipe that doesn't parse shows the raw .NET JSON error ("'…' is an invalid JSON literal…", English only): show
    a translated "This isn't a Flagship recipe" and put the detail in the log.
  - "Unlocking…" lingers ~50 s after the server already answers HTTPS.
  - On the installer-ISO path (W8) Studio shows "No new guest checkpoint for 3 minutes. Last reported: Sealing the
    disk key" for ~7 min before "Starting…", although the install is fine: the guest should report a checkpoint while
    it seals (or the stall warning should wait longer at that step).
  - Failed remasters leave `%TEMP%\flagship-remaster-*` folders behind.
  - Closing the window once left the process running (1 of 4; File → Exit works). Note the steps if seen again.
  - After a sealed reboot the log says "No server running: this PC may sleep again" while the server runs (W11's
    `powercfg` check passed later; confirm the keep-awake really holds across that reboot).
  - The Delete confirmation's Yes/No read as `Pane` in UI Automation (native MessageBox): confirm with Narrator itself.
- **Phone create-server flow (W3):** Continue does nothing until a backup choice is made, with no hint why.
- **Still owner-only rows:** W1 SmartScreen (browser download), W1b (0.2 Studio upgrade), W0b (Windows 10 PC), W15 (USB
  stick + spare PC), W20 (display language); waivers W2, W4 step 2, W13 (no newer endorsed release on production).

## CI (2026-11-07)

- **Android CI red since ~2026-10-21: the emulator UI smoke (GymEveryMergeTest, all 6) fails "component is not
  displayed" at the first landmark (`home-title` etc.) on the CI emulator (API 34, x86_64, pixel_6). Unit tests pass.**
  The same test passes locally on the `flagship_gym` AVD (API 35): so it's the CI environment or API 34, not a broken
  shell. Next: run it on an API 34 AVD, pull the gym screenshots from the CI artifacts (`gymShot("cold-launch")`), and
  look for an overlay that covers Home on first launch there (notification-permission prompt, app lock, the new
  welcome card or Messages tab).
- **iOS CI** moved to macos-26 + newest Xcode on 2026-11-07 (9c5703154, ec7858824, 5a4d276a3: compiler gap and three
  type-checker timeouts fixed). If it is still red, read the newest run; new slow SwiftUI expressions show locally with
  `OTHER_SWIFT_FLAGS='-Xfrontend -warn-long-expression-type-checking=150'`.

## voi.ci (owner, 2026-11-08)

- **Calls: a visitor calls the page owner's phone, audio only.** Plan: `docs/voici-calls.md`; measurements:
  `docs/voici-calls-spike.md`. WebRTC over TURNS to the phone's bare name (the phone answers TURN itself, TLS ends
  there), every frame sealed again under an X-Wing key from the signed set-up, constant-bitrate Opus; `.com` only
  arranges and rings every admin device; first answer wins and takes the bare name. About 53 days, after the rest of
  the spike (Safari, Firefox, the phones' libwebrtc, an acoustic echo test, a call over two relays). Branch
  `feat/voici-calls`. Open decisions D1-D4 in the plan.

- **One report entry in the page footer.** Today a page's footer has both "Report this page" (a button that opens the
  in-page report sheet, `apps/voici-site/src/report.js`) and "Report abuse" (a link to `/abuse#voici`), side by side
  (`apps/voici-site/src/page.js` `footer`). Fix: on a page, keep only "Report this page", and put one line at the
  bottom of its sheet, "How we handle reports, and other ways to report" → `/abuse#voici`, so the email route and the
  rules are one tap further, not gone. Where there is no page to report (not found, out of date, the About view),
  keep the "Report abuse" link, since the sheet can't open there. Update `tests/render.test.ts`; one new sheet string
  in `i18n/voici-site`.

- **"Send me a message" as a floating button.** Today it sits in the page flow after the links (`messageButton` in
  `page.js`), so a long post list buries it. Fix: a fixed button at the bottom right (inside `env(safe-area-inset-*)`,
  16 px from the edges): the message icon alone under 600 px wide (with an `aria-label` and a tooltip), icon and
  "Send me a message" from 600 px. Keep it early in the DOM (right after the links) so keyboard and screen-reader
  users reach it first; give the page bottom padding so it never covers the footer or the last post; hide it while a
  sheet is open. The note under today's button ("Private messages, with your Flagship app.") moves into the sign-in
  sheet. Shown only while `acceptsMessages = 1`, as today. When calls ship it becomes Message and Call.
  **Pulsing, with one push-back:** a button that pulses forever fails WCAG 2.2.2 (anything that moves on its own for
  more than 5 seconds needs a way to stop it) and tends to read as an ad. Proposed: three slow pulses (a ring that
  grows and fades, about 4 s in all) when the page has loaded, and three again the first time the visitor scrolls to
  the end of the posts; no pulsing under `prefers-reduced-motion` (the site's reduced-motion rule already cuts
  animations to one short run; this one should not run at all). If the owner still wants a constant pulse, it needs a
  visible way to stop it.

- **Page photo from an iPhone: "That photo couldn't be made small enough" every time.** Found in the code (not yet
  confirmed on a device; this Linux machine can't run ImageIO):
  - **iOS, the likely cause.** `VoiciImageEncoder` (`apps/mobile/ios/Sources/FlagshipUI/Services/VoiciMedia.swift`)
    writes the 512 × 512 JPEG with ImageIO and then refuses it when `VoiciPage.voiciJpegHasMetadata` finds an APP1 or
    APP2 segment. It passes `kCGImagePropertyOrientation` to the destination, which makes ImageIO write an EXIF (APP1)
    block, and ImageIO also embeds the image's sRGB ICC profile (APP2). Either one fails every photo, and the refusal
    is reported as "couldn't be made small enough". The webapp met the same thing (its comment: a browser's encoder
    may add an sRGB ICC profile as APP2) and strips segments before the check (`stripJpegMetadata`); Android strips
    too (`VoiciMedia.kt` `stripMetadata`); iOS has no strip step.
    Fix: drop the orientation property (the bitmap is already upright), add the same APP1-APP15/COM strip in Swift,
    keep the check after it, and give each failure its own sentence ("Couldn't open this photo" for a load or decode
    failure, the size message only when it really is too big).
  - **Every iPhone format.** `PhotosPicker` gives the original file: HEIC/HEIF (8- and 10-bit HDR), JPEG, ProRAW (DNG),
    the still of a Live Photo, PNG screenshots, panoramas over 16,000 px wide, wide-gamut Display P3. ImageIO's
    thumbnail path decodes all of them and converts to sRGB in the draw; an item only in iCloud may fail to load
    (`loadTransferable` throws): say "This photo is still downloading from iCloud. Try again in a moment" there.
  - **Android.** `BitmapFactory` ignores EXIF orientation, so camera photos can come out sideways. Use `ImageDecoder`
    (API 28+, below the API 29 floor): it applies the orientation, decodes HEIC and AVIF, and a target size avoids
    loading a 48 MP photo whole. Same separate sentences.
  - **Webapp.** `createImageBitmap` can't decode HEIC in Chrome or Firefox (only Safari can; iPhone Safari's file
    picker usually converts to JPEG on the way). Say "This browser can't open HEIC photos. Save it as a JPEG, or use the
    Flagship app" instead of the generic line.
  - **A crop step in every app (iOS, Android, webapp).** After picking, a crop screen: a square frame with the round
    preview the page shows, drag to move and pinch (or a zoom slider, plus arrow keys on the web) to zoom, rotate
    90°, then "Use photo". The encoders take the chosen square instead of today's centre crop, then resize to 512 ×
    512 as now. Strings for the screen in each surface's `i18n/`.
  - **Tests.** One shared set of sample photos (`packages/protocol/test-vectors/voici-images/`: an iPhone HEIC, a 10-bit
    HDR HEIC, a ProRAW DNG, an EXIF-rotated JPEG, a Display P3 JPEG with its profile, a PNG with transparency, a
    16,000 px panorama). Each encoder must turn every one into a JPEG of at most 150 KiB with no APP1/APP2 segment and
    the right way up (a marked corner pixel). iOS runs them in the simulator tests, Android in Robolectric or on the
    emulator, the webapp in the browser tests (HEIC expected to refuse with the new sentence outside Safari).

## Product plans carried over

- **Human `voi.ci` service names** (owner discussion 2026-10-21): one free, user-chosen `voi.ci/<name>` per public
  service, a 302 to its `flagship.services` address, following the service between boxes. Plan:
  `docs/voici-service-names-todo.md` (found untracked in the main checkout on 2026-11-07; reconcile with the naming
  and monetization docs when it lands).

- **Direct access: skip the relay, and what each domain is for (LOCKED IN, owner 2026-11-08).** Full design,
  decisions and edge cases in `docs/direct-access-and-domains.md`. In short: when a box can be reached from the
  internet, the owner (biometric, admin-root-signed order) gives an app a **direct name on `fshp.app`** whose DNS
  record points at the box; visitors connect straight to it, TLS still ends on the box, and the traffic is free of
  relay quota. Not a redirect (rejected). First the app-side path (LAN-direct extended to public addresses, no DNS),
  then the direct names. `flagship.services` stays a pure wildcard to the relay (the per-box records live only in
  `fshp.app`); the website mirror moves to `fshp.tech` only. Pricing: a free derived name
  (`game--john-doe.fshp.app`) for everyone who opts in, and paid yearly vanity names (`johngame.fshp.app`, $5–12)
  under the existing custom-names surface. Big open points: the PSL is not available yet (the `flagship.services`
  submission is on hold until 2,000–3,000 users), so new `fshp.app` certificates share Let's Encrypt's 50/week and
  names share cookies; the home IP becomes permanently public. **Owner rule:** the direct path is the owner's
  infrastructure: we publish only the records they sign (AAAA and A, for corporate users too) and never add an
  IPv4 relay fallback or re-point a name when the box is down.

## Costs (owner, 2026-11-09)

- **Recreate the `playstore-test-0725` demo server on a 20 GB disk.** The owner resized its UpCloud plan to
  `STARTER-1xCPU-2GB` and asked for 20 GB, but UpCloud never shrinks a disk, so it keeps the 30 GB it was created with
  (`.com` sets `UPCLOUD_STORAGE_GB = "30"` in `apps/com/wrangler.toml`). Only when no store review is open and the box
  has taken its 0.3 update: set `UPCLOUD_STORAGE_GB` to 20 (and `UPCLOUD_PLAN` to `STARTER-1xCPU-2GB` if the owner
  wants new demos that small), deploy `.com`, then recreate the demo with `node scripts/sample-user.mjs` (cleanup,
  then create) and check the review sign-in works. Keep 2 GB of memory: a box update rebuilds its daemon (~1 GB), so
  1 GB risks an interrupted update.

## Repo housekeeping (2026-11-07)

- **Rebase every feature branch and `gym` onto the tip of `main`** with `bash scripts/rebase-features.sh --apply`
  (backup ref, scratch worktree, `npm ci`, `tsc`, push with --force-with-lease; its list was fixed on 2026-11-07).
  Predicted on 2026-11-07: `feat/browser-extension` clean; conflicts in `gym` 9 files, `feat/other-os-installers` 18,
  `alpine` 31, `feat/retail` 34, `feat/marketplace` 62 (its webapp shell v181 must move above main's v204), then
  `feat/custom-names`, `feat/custom-domains`, `feat/outbound-proxy` follow marketplace (they need its payment rail,
  per AGENTS.md). Conflicting branches are a hand job, one branch per session, smallest first (gym).
- Old gym copies are kept as tags `archive/gym-rebase-2026-10-25`, `archive/gym-pre-0.3-rebase2-2026-10-25`,
  `archive/gym-pq-2026-10-26` (1-3 commits each not found on `gym`); `gym` is the only gym branch.

