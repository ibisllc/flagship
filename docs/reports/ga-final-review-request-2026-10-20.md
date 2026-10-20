# Flagship: GA review round 2, and a request for a last pass

Written 2026-10-20 by the engineer who applied round 1, for the owner to hand to a second
reviewer (an advanced AI). Repository: `origin/main`, working tree `/Users/harrywinner/flagship`.
The round-1 review document was deleted after it was applied; everything it raised is restated in
section 2 so this page stands alone.

## 0. What you are asked to do

You are the last reviewer before general availability (GA) of Flagship: the phone apps (iOS,
Android, Wear), the three Studios (Mac, Windows, Linux), the website and webapp
(`flagshipserver.com`), the data-plane site (`flagship.services`), the control plane (`.com`, a
Cloudflare Worker with D1), and the relay (`.services`, one Fly app).

1. Read section 1 (the product), then 2 and 3 (what round 1 raised and what was done), then 4
   (what is still open).
2. Do a **last-pass review for GA readiness** of the app, the Studios and the site. Do not trust
   this page: check it against the code and the docs. Round 1 was wrong or overstated in places
   (section 3.3); this page may be too.
3. Write your answer as a report, in the shape of section 5, and give it back to the owner so it can
   be applied. **Mark every claim** as **[V]** verified from text or code you read or ran, **[I]**
   inferred, or **[G]** a guess. Be blunt; do not praise.

Rules while you work:

- You may read the repo and run local, read-only checks and tests. Do **not** deploy, sign, publish,
  spend money, run `scripts/release.sh`, run the live gym, or touch production data or any account
  (never `playstore-test-0725`).
- Do not stage `apps/mobile/android/keystore/upload_certificate.pem` (untracked, private).
- The owner's decisions in section 3.1 stand. If you disagree with one, say so and why, but list it
  separately from the findings that apply to the product as decided.

Useful commands (macOS, from the repo root; the full TypeScript suite takes about 3 minutes):

```
npx vitest run                                  # TypeScript, everything
npm run parity                                  # cross-language vectors and versions
npm run release-manifest                        # hardware receipts: MISSING / STALE
npm run ops -- health                           # live health (reads only)
node scripts/ios-release-clean.mjs              # iOS release carries no mock/gym code (source check)
(cd apps/mobile/shared && swift test)           # shared Swift suite
(cd apps/mobile/android && JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew --offline :app:testDebugUnitTest)
```

Start with `AGENTS.md` (orientation and status log), then
`docs/reports/changes-since-store-builds-2026-10-18.md` (section 0.3 is this round),
`docs/relay-addresses.md`, `docs/outbound-hosts.md`, `docs/metadata-threat-model.md`,
`docs/preview-criteria.md`, `docs/security-notices.md`, `docs/launch-mvp.md`.

## 1. The product in one page

A personal cloud. The user runs a server (the "box") on their own hardware or a VM; the **phone is
the trust root**. TLS ends on the box, so the vendor cannot read content.

- `.com` (flagshipserver.com): identity and state. Accounts, devices, server registrations, orders
  signed on the phone, the web app. Cloudflare Worker, D1, currently on the **Workers Free plan**
  (10 ms CPU per request) by the owner's decision.
- `.services` (flagship.services): one Fly app that passes encrypted connections to boxes by the TLS
  server name (SNI), holds the boxes' outbound tunnels, and carries box-initiated AI calls. It is
  not a general proxy.
- The box: runs the user's apps, makes backups, updates itself to code the maintainers endorsed with
  a YubiKey, unlocks its disk only with the phone's approval.
- Authority: admin-root keys on the phone sign sensitive orders; `.com` and the box verify.
- Distribution: App Store and Play for the phone apps, signed installers for the Studios, a
  republished VM appliance for Windows/Linux hosting.

## 2. What round 1 raised

Twelve GA blockers and a 30-item change list. Status after this round: **Fixed** (in code, tested),
**Owner** (decided differently), **Open** (needs hardware or production, tracked in section 4).

### 2.1 The twelve blockers

| # | Round 1 said | Status |
|---|---|---|
| 1 | iOS relay route under a real DNS block never ran on hardware | **Open** (receipt `ios-relay-dns-block`) |
| 2 | Android's handshake was seen closing under a DNS block, cause unknown | **Open** (`android-relay-dns-block`); no cause found |
| 3 | iOS pairing has no two-device run | **Open** (`ios-two-device-pairing`) |
| 4 | Windows hosted-VM first boot not retested after the fixes | **Open** (`windows-hosted-vm-first-boot`) |
| 5 | Windows "Restart as administrator" after cancelling UAC unverified | **Open** (`windows-uac-restart`) |
| 6 | Backup and restore not proven on a production-format box | **Partly.** Backups are now read back and opened (2.2 item 22). The destructive restore drill is **Open** (`destructive-restore-drill`) |
| 7 | Existing app data not interruption-tested through the loop-image move | **Partly.** Verification and unit tests over every cut point are in; the real-disk run is **Open** (`loop-volume-interruption`) |
| 8 | Gym recorded Worker routes far over the Free plan's 10 ms CPU | **Owner.** Stays on Free. Measured: handler CPU is tiny (3.3); the gym now fails a route that is systematically over; `npm run ops -- workers` shows production numbers. Production p99 is **Open** |
| 9 | Old accounts without an admin root have not created a server against the new enforcement | **Open** (`old-account-create-server`); the order of that enforcement against store builds is an owner release decision |
| 10 | Store build numbers not checked against the consoles | **Open** (`store-builds`) |
| 11 | CA lease, endorsement, wildcard/CAA, final artifacts are release-time work | **Partly.** `npm run release-manifest` checks the lease horizon (88 days left) and the schema ledger; the rest is release-time (`scripts/release.sh`) |
| 12 | The relay-address security claim is overstated | **Fixed** (2.2 item 1) |

### 2.2 The 30 items

| # | Item | Status |
|---|---|---|
| 1 | Offline-signed relay-address manifest | **Owner.** Replaced by the **relay echo** (3.1). Both phones require it of any address `.com` recommends |
| 2 | Distinct error for a failed relay hint | **Owner.** Same calm sentence; the real reason is kept (`DiagnosticCode`, `DiagnosticsLog`). Not shown in any screen yet |
| 3, 4 | iOS forwarder stops on suspend, restarts on foreground | **Fixed** (`RelayRoute.suspend()`, new port at next need) |
| 5 | Connection count, header and idle deadlines on the forwarder | **Fixed** (32 clients, 5 s, 60 s) |
| 6 | iOS tests for restart, stale port, concurrent clients | **Fixed** |
| 7 | Join migration reads into one D1 query | **Declined with evidence.** Steady state is 0.06 ms of JavaScript and 2 D1 calls; the gym's 114 ms was a cold isolate |
| 8 | CPU scenarios for migration, assignment, health, usage, eviction, sample-create | **Partly.** Migration read and assignment added; the others not |
| 9 | Fail the gym on any CPU over 10 ms regardless of outcome | **Changed.** Fails a route over 10 ms in a fifth of 5+ requests; a single slow request is noted |
| 10 | Record Worker plan and limits in release evidence | **Partly.** `release-manifest` and the runbook say where the evidence comes from; the plan is an account setting not in the repo |
| 11 | Sample-user provisioning off the request | **Not done.** Probably cold-start; measure first |
| 12, 13 | Journal and verification around the loop-volume move | **Fixed** (fingerprint before the old folder goes; a pending marker already existed; tests for a cut at every step). The real `find` fingerprint runs only in the Linux CI integration test |
| 14 | iOS CI workflow | **Fixed on paper** (`.github/workflows/ios.yml`); never run on GitHub |
| 15 | Android emulator gyms in CI | **Fixed on paper** (`android.yml`); never run on GitHub |
| 16 | Peer backup off | **Fixed** (box refuses, apps do not offer it) |
| 17 | Security-notice lock off | **Fixed** (release builds show the nag only) |
| 18 | Production wildcard canary | **Fixed** (`npm run ops -- dns`, a 30-minute CI job) |
| 19 | Guard for current CA lease and endorsement | **Partly.** Lease horizon is checked by `release-manifest`; the endorsement hash is printed in the manifest (needs `tsc -b`) |
| 20 | Hold `.com` enforcement until store builds are live | **Not done.** A release-order decision for the owner |
| 21 | Routing-target writer inventory | **Fixed**, and it found a real race (3.2) |
| 22 | Restore-verification receipt | **Owner.** Reduced to "backup read back and opened before it counts as saved"; no "Restored" receipt |
| 23 | Migrate must not wipe the source until the restore is proven | **Owner.** Migrate ends with the old server deleted by design; the careful path is the downloadable `.flagship` file |
| 24 | Split boot-unlock from the notice lock | **Fixed** (the two boot writes are exempt from the lock). Not proven on a device |
| 25 | Deeper teal for state borders and focus | **Owner.** Bright teal stays (decision of 2026-10-17); shipped as a known contrast issue |
| 26 | Copyable diagnostic codes on every mapped error | **Partly.** Codes and log exist; no screen shows them |
| 27 | Machine-readable release manifest | **Fixed** (`release-manifest manifest`) |
| 28 | Freeze map that expires receipts on change | **Fixed** (`release/freeze-map.json`) |
| 29 | Metadata documentation | **Fixed** (`docs/metadata-threat-model.md`) |
| 30 | Preview acceptance criteria | **Fixed** (`docs/preview-criteria.md`) |

## 3. What was done

### 3.1 The owner's decisions in this round (they override the round-1 text)

1. **Relay addresses.** No new signed protocol. The relay answers "which address did you reach me
   at" over TLS (port 8444, Fly's PROXY header); the phone compares it with the address it dialed
   and drops a mismatch, which exposes a forwarder in front of the relay. The compiled-in pair is
   exempt. An address `.com` recommends is never used untested.
2. **Errors.** A failed relay hint still reads as the unresolved name; the real reason is kept.
3. **Plan.** `.com` stays on Workers Free for now. A command (`npm run ops`) replaces a dashboard.
4. **Scope.** Build the safety work, with peer backup and the notice lock gated off.
5. **Migrate.** Unchanged. It ends with the old server gone. A server page has **Back up now (with a
   passcode)** above **Migrate** for the file the owner keeps.
6. **Outbound AI calls through the hub.** Host list in the database (seeded with the providers baked
   into the apps; any new host is allowed and recorded; one flag blocks it); per-host totals with no
   user in them; a plain message when an address cannot be reached; documented as a known risk.
   TODO recorded: a heuristic blocker if manual review gets too slow.
7. **Teal** state borders stay bright.

### 3.2 Real defects this round found in the product or in the first draft of the fixes

- A **race in name registration**: two different keys registering the same new name at once could
  overwrite each other's key (`D1RoutingStorage.register`). Fixed in the write itself; a new test
  fails on the old code.
- A **crash path I introduced**: invalidating an iOS `URLSession` that a caller is about to use is an
  Objective-C exception. The shim now finishes the session a minute later instead.
- The first backup check covered only the saved/scheduled path; the one-click file download was not
  covered until it was moved into the common `makeArchive`.
- The schema ledger (`KNOWN_MIGRATIONS`) did not know migration 0106.

### 3.3 Where round 1 was wrong or overstated (check these for yourself)

- It said CPU "could fail in production" and asked for joined reads. The harness shows the handlers
  use well under 1 ms of JavaScript; the gym's 85 to 115 ms maxima look like cold isolates. Whether
  production hits 1102 is **unmeasured** (`npm run ops -- workers`).
- It treated the pinned-box handshake as proving the first hop. It does not; the echo is the fix.
- It called Migrate's immediate wipe a defect; the owner's view is that deleting the old server is
  the point of Migrate.
- It named the iOS forwarder a proxy risk. It is a listener on the phone's own loopback, not a
  server of ours. Whether iOS lets another app reach that port is **unchecked**.

### 3.4 Commits (since `ee70cc4c1`)

`857c4e163` relay echo on `.services`; `dfa58f4ec` Android echo and no untested addresses;
`7c5df51c0` iOS echo, shim limits, diagnostics; `96d651c95` Android diagnostics; `ef72d246f` outbound
host list; `b94baa910` ops command, outbound wording, seed list; `ca87b84ff` relay doc;
`5d5b181b3` CPU scenarios and gym rule; `bdc9408f5` peer gate; `076783927` lock gate and boot-unlock
exemption; `40a9c0e82` loop-volume check; `664ac23b3`/`89a9ea1b5` backup check; `1e6a2e499` CI;
`72eb28fb5` DNS canary; `3c00c279a` routing race, backup check in `makeArchive`, schema ledger;
`303c04152` release manifest; `48275f809` metadata and Preview docs. (`39b811f6b` and its revert
`9d890398f` added then removed a sentence on the Migrate screen at the owner's request; `9584fb336`
and its reapply are one wrongly-aimed revert and its undo.)

### 3.5 Test state at the time of writing

- Shared Swift suite: 360 tests, 0 failures. Android unit tests: pass (`:app:testDebugUnitTest`).
  iOS app target: builds for testing.
- TypeScript: see the last line of this section, filled in when the run ended.
- Not run: the live gym (spends money, needs the owner), the Linux integration test for the loop
  images, the two new GitHub workflows, anything on a device.

TypeScript, full run: 850 test files ran, 1 failure (a `release.sh` ledger test that assumed 0105 was the
newest migration; fixed and passing, 33/33). Three files did not run in that pass: the two Linux/Postgres
integration tests (skipped off Linux) and `scripts/release-guard.test.ts`, which hangs in this checkout
because of stale `.claude/worktrees/agent-*` folders and passes 18/18 in a clean worktree.

## 4. What is still open or unverified

Run `npm run release-manifest`: 14 of 15 receipts are MISSING today (one is optional). In plain terms:

- On devices: the iOS and Android relay routes under a real DNS block; iOS two-device pairing;
  Android auto-unlock (approve, two automatic reboots, revoke); a locked phone approving a boot
  (only if the lock is switched on).
- On machines: a fresh Windows hosted-VM first boot; UAC cancel and restart; a reboot with `.services`
  and `.com` blocked; the real-disk loop-volume interruption; the destructive restore drill with real
  files and PostgreSQL.
- On production: the relay echo naming the relay's own dedicated address (first deploy of
  `.services`); an old account creating a server; a YubiKey-signed banner notice; store build numbers;
  a D1 export; production Worker CPU and `exceededCpu` counts.
- Deploys needed: `.com` (migration 0106 first, then the Worker), `.services`, an endorsed box
  release, new store builds (relay echo, lock, peer gate).
- Not built: showing the diagnostics log in a screen; a heuristic outbound blocker; async sample-user
  create; a guard holding `.com`'s enforcement until store builds are live.
- Known issues shipped on purpose: bright teal state borders (2.3:1); Windows/Linux Studio and Wear are
  Preview (`docs/preview-criteria.md`).

## 5. The report to write

Return one document with these parts, each claim marked [V], [I] or [G]:

1. **Verdict.** Ready for GA, ready with named known issues, or not ready. One paragraph, then the
   five things that most decide it.
2. **Blockers.** Each with: the failure, who is hurt, the file or document that shows it, and the
   smallest change (one commit) or proof (one named receipt) that clears it.
3. **App (iOS, Android, Wear).** A walk of the first run, pairing, a server's page, backups, Migrate,
   update, account removal and error states in the code: what could confuse, lose data, or break
   trust. Confirm or dispute: the relay echo and shim, the lock being off, the peer-backup gate, the
   backup check, the diagnostics, accessibility.
4. **Studios (Mac, Windows, Linux).** Install, first boot, UAC, update, stop and start, the hosted
   VM, and whether "Preview" is honest under `docs/preview-criteria.md`.
5. **Site and webapp** (`flagshipserver.com`, `flagship.services`): claims that are no longer true
   (for example anything saying we never relay traffic, or about privacy, backups and Preview),
   broken or missing pages, store links, versions, the security and abuse pages.
6. **Control plane and relay.** The new echo, outbound host list, `/api/stats`, migration 0106 and
   deploy order; anything that works on the gym but not on the Free plan.
7. **The round-1 findings you disagree with**, and the round-2 changes you think are wrong, with
   reasons. Include anything in sections 3.2 and 3.3 you can confirm or refute.
8. **What you could not judge** from the repository alone.
9. **A numbered list of concrete changes**, each small enough for one commit, ordered by how much
   they block GA, and a separate list of proofs the owner must produce on hardware or production.
