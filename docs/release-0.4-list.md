# 0.4 list

Work the owner has put on 0.4. F6b (the gym on a private test CA, `docs/gym-test-acme.md`) comes first, after the
0.3 release and before anything here.

- **BEFORE ANY 0.4 WORK: finish what 0.3's release step 36 skipped (owner, 2026-11-06).** The owner skipped step 36
  (reap orphaned DNS records and demo servers, then zone-health) in the 0.3 phase B run because the gym sweep half
  answered 401: release.sh runs `tools/live-e2e/sweep-cli.ts` without `GYM_ADMIN_SECRET` (it reads
  `GYM_ADMIN_SECRET || FLAGSHIP_ADMIN_SECRET`, and the release shell has neither for the gym). So neither half ran:
  (1) the production reap (`npm run reap-orphans`, dry run then `--apply`, keeping `playstore-test-0725` and every
  "left on purpose" record) and `npm run zone-health`; (2) the gym sweep (`flagship-env=gym` servers and gym DNS).
  Before starting 0.4: run `release.sh --only 36` with `GYM_ADMIN_SECRET` set from `.gym-secrets.env` (or the two
  halves by hand), and fix release.sh so step 36 loads the gym secret itself (or asks for it) and a failed gym dry run
  stops before the destroy prompt instead of asking to destroy an empty list. Also decide with the owner how the gym
  sweep should get its secret in future releases.
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

## Product plans carried over

- **Human `voi.ci` service names** (owner discussion 2026-10-21): one free, user-chosen `voi.ci/<name>` per public
  service, a 302 to its `flagship.services` address, following the service between boxes. Plan:
  `docs/voici-service-names-todo.md` (found untracked in the main checkout on 2026-11-07; reconcile with the naming
  and monetization docs when it lands).

