# Flagship — orientation for Codex

Personal-cloud ecosystem. The phone is the trust root; users run their own server on commodity hardware at home; **TLS terminates on the user's box** so flagship.services literally cannot read user content. Verified end-to-end in production with a real green padlock as of 2026-05-05.

**This file is the single in-repo source of truth for current status and open work** — see "Current status & open work" at the bottom; update that section as work lands rather than starting new `docs/*handoff*.md` files. `CLAUDE.md` imports this file using Claude Code's supported `@AGENTS.md` syntax; never hand-sync a second copy. If you have access to agent memory, `project_overview.md` is a deeper architectural briefing (`final_architecture_2026_05_05.md` has the gory detail). Dated session handoffs and completed launch trackers are frozen in `docs/archive/` (history only).

## What's where

```
apps/com/                  Cloudflare Worker — flagshipserver.com (identity + state) + web.flagshipserver.com (webapp host-rewrite)
apps/web/                  Fly app — flagship.services (stateless data plane) + the webapp static surface
apps/web/public/           Static assets served by the Worker's [assets] binding
   ready/                  /ready/ — after an order: copy/download the recipe + get the builder (replaced the old /build/ paste-a-code page; /build/iso/ stays as the R2 ISO-stream backend)
   dev/create-server       /dev/create-server — phone simulator
   status/                 /status/ — live health dashboard
   security/               disclosure.html, report.html
   webapp/                 PWA source (served at root on web.flagshipserver.com)
apps/mobile/               iOS Swift + Android Kotlin clients — substantial code; not yet on TestFlight/Play

packages/protocol/         Canonical-bytes + Ed25519 sign/verify for every signed message
packages/storage/          Storage interfaces + InMemory + D1 adapters + SQL migrations
packages/control-plane/    Pure runtime-agnostic handlers (used by Worker AND Fastify)
packages/server-daemon/    PRODUCTION daemon entry (acme, tunnel client, service runner, lease store, browser bundle)
packages/hello-daemon/     Minimal demo daemon — kept around for chain smoke-testing only
packages/iso-personalizer/ Trailer format (build/parse/personalize-stream)
packages/installer-apkovl/ Builds the apkovl tarball baked into the Alpine ISO
packages/tunnel-protocol/  Frame format for the tunnel + SNI parser
packages/services-zone/    `<server>.<user>.flagship.services` validation + DNS publisher
packages/bootkey-builder/  Caddyfile + per-server FQDN/SAN helpers
packages/llm-providers/    BYOK provider adapters

installer/                 Public install scripts the apkovl curls at boot
   install.sh              First-boot installer: LUKS + git clone + register
   boot-stage.sh           Steady-state boot: contact .services for unlock-key

Dockerfile                 Builds the Fly app image
fly.toml                   :443 raw-TCP (SNI passthrough) + :8443 TLS-term (API + tunnel hub)
```

## Architecture in one sentence

**`.com` (Worker + D1 + R2)** owns identity & persistent state. **`.services` (single Fly app)** is a stateless pipe: SNI passthrough on :443 + tunnel-hub WebSocket on :8443. **The user's daemon** runs ACME locally (TLS-ALPN-01 over the same passthrough chain), holds the Let's Encrypt cert, and serves services. **Routing-Control-Key (RCK)** is a phone-held primitive that decouples "who can claim a subdomain's traffic" from "which server is currently handling it" — enables failover/migration/delegation.

## Live URLs

- `https://flagshipserver.com/` — landing
- `https://flagshipserver.com/ready/` — after an order: copy/download the recipe + get the builder
- `https://flagshipserver.com/dev/create-server` — phone simulator (mints build codes)
- `https://flagshipserver.com/status/` — live health
- `https://flagshipserver.com/api/health` — JSON health
- `https://flagship.services/api/health` — direct Fly health
- `https://<server>.<user>.flagship.services/` — user content (after a real install)

## Common operations

```sh
# Tests
npx vitest run                                  # everything (~30s)
npx tsc -b                                      # typecheck the whole tree

# Deploy
npx tsc -b && (cd apps/com && npm run deploy)   # Worker — tsc -b FIRST: it bundles the BUILT control-plane dist/, so a deploy without a rebuild silently ships stale handler logic. Use `npm run deploy` (NOT `wrangler deploy` directly): it runs the `predeploy` guard (scripts/predeploy-com.sh — route-safety + dist-freshness)
export PATH="$HOME/.fly/bin:$PATH"
flyctl deploy --remote-only --strategy=immediate --yes -a flagship-services

# D1 schema migrations
cd apps/com && npx wrangler d1 execute flagship-state \
    --file=../../packages/storage/migrations/0003_install_events.sql --remote

# Smoke a fresh build chain
# 1. Open https://flagshipserver.com/dev/create-server in a browser
# 2. Mint an order; collect the recipe from https://flagshipserver.com/ready/
# 3. Run packages/hello-daemon with the printed creds
# 4. curl https://<assigned-subdomain>/   (real green padlock)
```

## Conventions

- **No `Co-Authored-By: Codex` trailer on commits** — user preference.
- BUSL-1.1 license. Change Date 2030-05-03 → Apache 2.0.
- Imperative commit subjects. Body explains *why*, not *what*.
- TypeScript ESM, strict mode, `noUncheckedIndexedAccess`.
- Tests live next to packages: `packages/<pkg>/tests/`.
- Canonical-bytes use `|` separator and `flagship/<purpose>/v1` tag prefix.
- No comments unless the *why* is non-obvious; never explain *what*.
- **Unlaunched features live entirely on their own branch; `main` ships clean.**
  Every not-yet-launched feature — site literature, app code (iOS/Android/
  webapp), backend logic, AND tests — lives ONLY on its feature branch, so
  `main` "doesn't think of" it at all. Current branches: **`feat/marketplace`**
  (the marketplace) and **`feat/retail`** (getting the app working with
  retail / NFC boxes). **No marketplace/retail code may sit on `main` until
  that feature launches** — branching IS the gate, there is NO gating/flag code
  in `main`.
  - **`feat/transfer-a-box` was a *develop-then-MERGE* branch — DONE.** Merged to
    `main` 2026-06-22 (branch deleted); only the box-side re-home + disk-key
    handshake reburn-validation remains (see the status log). Design:
    `docs/account-deletion-and-name-reclaim.md` §4.
  - **`alpine` is a *parked* branch, not a feature-to-launch.** It holds the
    full Alpine bare-metal installer path (ISO builder + apkovl + installer-tiny
    + the builder Quick/trailer flow + `/api/personalize-iso`) that `main` shed
    when we went Debian-only. Same mechanics (it's `main` + the Alpine delta,
    built by reverting the removal commits — `git diff <pre-extraction> alpine`
    was empty = lossless), but its purpose is *revival* if/when the Alpine
    initramfs USB-enumeration blocker is solved, not merging into a launch.
  - **Each branch = `main` + exactly one feature.** A branch is built so its
    diff against `main` is *only* that feature (so merging it ships the
    feature). Branches are **independent of each other** — you can check out one
    at a time to work on it; neither carries the other's code.
  - **Dependencies go through git, not entanglement.** If a feature ever
    depends on another, branch it OFF that feature's branch — never co-mingle
    two features on one branch.
  - **Extraction/reorg is forward-only** (no history rewrite on `main`) and
    **lossless** — nothing in features/UX/code/tests is lost, only relocated;
    anything removed from `main` exists on the feature branch.
  - **Workspace artifacts stay on `main`, never extracted:** DB migrations +
    repo-root `docs/*` design specs. Neither ships to users or the website —
    they're dev scaffolding. A feature-only table in prod (`marketplace_listings`,
    `box_serials`) is fine: develop the feature by checking out its branch and
    running against the live table. Only *application* code is extracted.
  - **At commit time, weigh impact on the feature branches** — they don't
    auto-receive `main`'s commits, so a `main`-only fix to shared code needs
    cherry-picking forward when a branch is integrated.

## Current status & open work

> **This section is the single source of truth.** Update it as work lands —
> don't spawn new `docs/*handoff*.md` files. Dated handoffs + completed launch
> trackers are frozen in `docs/archive/`. Keep entries terse: what changed +
> what remains, not test counts or commit hashes. Last updated **2026-07-20**.

### Pending owner validation (the standing caveat — applies to nearly every entry below)

Recent features are CI-green + byte-compatible but need physical validation the
harness can't do:

- **A reburn** validates box-side changes live: the JSC/Rhino preseed generator
  boots; CGK deposit→gossip claim/yield + route-nudge; the debug-access gate; the
  post-boot SWK / pairing / entitlement deposits; the self-delete consumer; the
  transfer re-home + giver→acquirer disk-key handshake; phone-approval unlock on a
  box sealed with current code.
- **App rebuilds** (Xcode / Gradle) surface mobile changes on device. The apps are
  not yet on TestFlight/Play, so push / Live-Activity can't be received on hardware.
- **Deploys**: webapp + backend ride the next `.com` Worker deploy (`npx tsc -b`
  FIRST — it bundles the built control-plane `dist/`; **apply pending D1 migrations
  before the Worker deploy** — the predeploy gate blocks on drift); hub changes ride
  the next `.services` Fly deploy.
- **Android on-device USB-OTG** burn still needs a server-side pre-remastered base
  ISO + a physical OTG drive (`apps/mobile/android/OTG-BUILDER-NOTES.md` §5).

### Recent work (condensed log, newest first)

**2026-07-20 (pairing polish) — Mac Builder no longer flashes the USB form
while phone authorization is pending.** The post-SAS `.session` stage now owns a
full-pane "Awaiting authorization" state through biometric approval and recipe
delivery, then advances to destination selection. The destination chooser now
presents the verified server domain as a plain, larger page heading instead of a
white rounded status card that resembled a third choice. **Remaining (owner):**
cut + publish the next notarized Studio build to ship this UI.

**2026-07-20 (ship) — Flagship Studio Mac app is DISTRIBUTION-READY + live on
the site.** Signed (Developer ID: IBIS LLC / 8G8RHBU9BN), **notarized + stapled**
(Apple Accepted), packaged as a DMG, and published: `flagshipserver.com/download/
mac` 302s to `apps/web/public/downloads/FlagshipStudio.dmg` (in git + served;
`/downloads/` is coming-soon-exempt; sha-verified byte-identical live). The
notarized build is installed to `/Applications`. **`scripts/release-studio.sh`**
cuts a new build in one command (build→sign→notarize→staple→DMG→stage; `--publish`
also commits+pushes+deploys); supports the API-key OR app-specific-password path.
On the release Mac, the three non-secret identity vars persist in `~/.zprofile`;
the app-specific password lives in the macOS Keychain profile `flagship-studio`
(seed/replace it with `scripts/release-studio.sh --setup-keychain`), and the
script uses that profile after a reboot without exporting the password.
`apps/builder-mac/Makefile` fixed for the spaced app name (make can't carry
"Flagship Studio.app" as a prerequisite → zip/staple/dmg are now phony) and its
`check-env` no longer needs the Apple ID on the API-key path. Also this session:
the pairing cover now shows a clean "waiting for internet" state instead of a
flickering QR + sticky yellow notice (NWPathMonitor; Mac-only — Linux/Windows
pair via the user-initiated `flagship-build` subprocess, no auto-cover flicker);
a **native menu bar** on all three desktops (Mac: File→New Server, View→Appearance
Auto/Light/Dark, Help; Linux: GNOME ☰ menu; Windows: File/Help — no Appearance,
WPF is light-only-static, dark mode is a separate effort); the in-window theme
toggle removed; and log-drawer polish (circled caret, Clear moved into the log +
only-when-open, the top rule slides to the very top of the UI, footer rules
realigned). Gates: builder-mac `swift test` 162 · vitest green (route tests
updated) · `.com` deployed (Worker `d7c2694e`). **Notary learnings (owner):** the
Apple Developer account is `kamdemharry@yahoo.fr` (NOT the gmail); Developer-ID
apps show the cert's legal entity "IBIS LLC" — "Houston Automation Lab" is only an
App Store seller name and can't appear on a Developer-ID app without an Apple
entity-name change (paperwork, not a build flag); **Individual** ASC API keys have
no Issuer ID and can't notarize — use a Team key or an app-specific password.
**Remaining (owner):** notarize+publish Windows/Linux builds and wire
`INSTALLER_DOWNLOADS.windows/linux`; the DMG-in-git bloats the repo ~2.3MB/build
(move to R2 / a GitHub release if it gets frequent); TestFlight for iOS/Android.

**2026-07-20 (rename) — the desktop tool is now "Flagship Studio"
(burner→builder, everywhere).** Front-facing name **Flagship Studio**; package /
bundle id `com.flagshipserver.Burner`→`.Builder` (+ helper `.Builder.helper`,
mach service, `.desktop`/polkit app-ids). EVERY "burner" identifier renamed to
"builder" repo-wide (~1,900 occurrences across TS/Swift/Kotlin/C#/Python):
directories (`apps/builder-{mac,linux,windows}`, `packages/flagship-builder`),
Swift modules (`FlagshipBuilder{,Core,Helper}`), the Android `…app.builder`
package, the C# `Flagship.Builder` namespace, the `flagship-build` CLI, the
`BuilderPair*`/`builderRelay` classes, the pairing wire tag
`flagship/burner-sid/v1`→`flagship/builder-sid/v1` (golden vectors + cross-lang
sha pins regenerated), the VM data path (`FlagshipBuilder/VMs`), and CI
(`builder-linux.yml`). The ONLY surviving "Burner" is DO **migration history** in
`wrangler.toml`/`wrangler.gym.toml` (v2 created `BurnerRelaySession`; new **v3**
`renamed_classes` renames it forward — applied migration history can't be
rewritten, and the DO is ephemeral). Gates: vitest **7393** · `tsc -b` clean ·
`swift build`+`test` **162** · Android tests+APK · pytest **280** (Windows/WPF
uncompiled — no .NET SDK here). The Developer-ID Mac app (**Flagship Studio**,
`com.flagshipserver.Builder`) is rebuilt + signed + installed to `/Applications`.
**Remaining (owner):** `make release` with your notary secrets to
notarize+staple+dmg; rebuild iOS/Android/Windows from this source so every peer
speaks the new `builder-sid` tag; the next `.com` deploy applies DO migration v3.

**2026-07-20 — app-review demo path repaired and validated live.** The real
operator path is `scripts/sample-user.mjs`; the older `scripts/demo-account.mjs`
is only a non-executing authorization/plan printer, and `TEST_ACCOUNTS` is legacy
fixture compatibility rather than live reviewer state. Demo creation now shares
the real 3–30-character username validator (interior single hyphens allowed),
and all admin/provision endpoints use that same grammar. W13 direct-cloud demos
now finish CLI polling at `up`, snapshot the running server before the idle
reaper, and allow a post-registration ACME retry to replace a transient error
with `live`. DNS maintenance now removes hour-old ACME TXT records and reconciles
old generated A/AAAA routes against active D1 servers in bounded cron batches;
the live repair removed 2 stale challenges + 104 orphan routes without touching
the 3 active servers. Reviewer account **`openai-build`** (display **OpenAI Build
Week**) is live with a 30-day idle window, snapshot-backed cloud server
`home.openai-build.flagship.services`, public DNS, a valid Let's Encrypt cert,
and HTTP 200 through the production passthrough.

**2026-07-20 (later) — VM-hosted "still coming up" root-caused (initramfs
virtio_net); biometric "random Face ID" fixed; desktop hosted-servers UI.**
Driven by a stuck Mac-hosted VM (`hali.jolly-quince`) + scary idle Face-ID prompts.
- **VM stuck "still coming up" — a DIFFERENT bug from frank's daemon-restart.**
  Prod-D1 fingerprint: hali REGISTERED at install then went totally silent — no
  unlock/entitlement/swk mailbox posts, no `daemon_status` — i.e. a pre-daemon
  boot/unlock stall, not frank's post-SWK `exit(0)` death. Root cause: the
  installed system's **initramfs unlock hook staged no NIC driver**. The d-i
  INSTALLER kernel has virtio_net built in (so install-time registration works),
  but the installed initrd relies on `MODULES=most` and a virtio-backed guest
  (Apple VZ / QEMU-KVM) can boot without `virtio_net` → net-ensure sees only `lo`
  → no DHCP → the unlock request never leaves the box → disk sealed forever. Fix:
  the `flagship-unlock` initramfs hook now `manual_add_modules virtio_net
  virtio_pci virtio_mmio e1000 e1000e` (harmless on metal). Shared engine ⇒
  reaches metal + Mac VZ + Linux KVM + Windows QEMU via the regenerated bundle;
  re-pinned both cross-language sha pins + added semantic assertions. GRUB/disk
  resolution was verified CORRECT for VZ (Feature A is NOT hali's cause).
- **Biometric "random Face ID while idle" — trust the unlocked session.** The
  LiveSync poll signs nothing, but on a stream change `reconcile → onRegistered →
  SwkDepositCoordinator` derives the IRK when a deposit is OWED (the state a stuck
  box leaves), and **iOS opened a fresh LAContext against a `.biometryCurrentSet`
  SE key on every derive** → Face ID on the Home screen, seemingly at random.
  Fix, matching the webapp (`session.umk`) + Android: (a) iOS `Keystore` caches
  the unwrapped UMK in memory for the unlocked session (RAM-only, cleared on
  lock/background/sign-out via `clearSessionKeyCache`, wired to `isUnlocked ->
  false`); (b) the automatic deposit path DEFERS unless `hasSessionKey()` — so a
  background refresh never *initiates* a biometric, it rides an unlocked session
  or waits. Android brought to parity: `BiometricAuthority` freshness is now
  SESSION-scoped (was a 60s window) + `isFresh()` gates the deposit defer +
  `invalidate()` wired to `isUnlocked/isPaired -> false`. Webapp already correct.
- **Desktop hosted-servers UI.** "Servers on this Mac/PC" title hidden when the
  list is empty (Mac/Linux/Windows); Mac footer divider aligned to the log bar;
  and a Mac "taking longer than expected — check it reached the network" advisory
  once a sealed guest has awaited unlock past 8 min (the poll had no timeout and
  spun forever) — pure `VMLifecycle.comingUpIsStalled` helper + test.
Gates: flagship-builder vitest 251 · `tsc -b` clean · builder-mac `swift build` +
`swift test` 162 green · Android `:app:testDebugUnitTest` + `assembleDebug` green.
**Remaining (owner):** rebuild the Mac builder + re-provision hali to validate the
virtio_net fix live (capture the VZ console/journalctl to confirm the exact
stage); **rebuild iOS (Xcode) + Android (Gradle)** to surface the biometric + UI
changes on device (iOS not compiled here). **Follow-ups (noted, not done):** (a)
persist the WIRED initramfs unlock log to the FLAGSHIP_BOOT partition like the
Wi-Fi path (hali was an 8-hour mystery precisely because the wired path only
echoes to a console the Mac app doesn't capture); (b) the stalled-boot advisory is
Mac-only — mirror it on Linux (`wizard.py`) + Windows (`Wizard.cs`/XAML).

**2026-07-20 — TestFlight code preflight unblocked.** The builder-pair lifecycle
fix is present; all four iOS/watch executable bundles now carry target-accurate
privacy manifests for app-local and App-Group `UserDefaults`. The existing
`group.com.flagshipserver.app` is confirmed registered and assigned to all four
bundle IDs. A first signed upload exposed the Watch target's missing icon catalog;
the Watch app now compiles the shared 1024px `AppIcon` watchOS slot, and its Release
bundle contains `Assets.car` plus `CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconName`
as App Store Connect requires. XcodeGen output was regenerated and fresh Release
simulator + unsigned physical-device builds pass with the iOS widget, Watch app,
Watch widget, and all four manifests embedded. **Remaining (owner):** create a new
signed Archive and upload it to TestFlight.

**2026-07-20 — root cause of "box boots but never serves HTTPS / still coming
up"; installer GRUB-target fix; builder-pairing UX.** Three landings:
- **Daemon self-restart fix (the "still coming up" killer).** The
  flagship-daemon systemd unit shipped `Restart=on-failure`, but the daemon
  signals "restart me to pick up new state" with `process.exit(0)` — the
  SWK-deposit + CGK-deposit consumers, admin-root rotation, and self-update
  commit all do. `on-failure` treats exit 0 as success and does NOT restart, so
  every **secret-free-recipe** box (default since 2026-06-23) died the instant it
  consumed its SWK, before it ever claimed its entitlement, opened the tunnel,
  ran ACME, or served HTTPS. Diagnosed on frank.jolly-quince by querying prod D1
  (fingerprint: SWK + unlock consumed, `entitlement-deposit` NOT consumed,
  `daemon_status` empty). Fixed to `Restart=always` + `StartLimitIntervalSec=0`
  in ALL three unit generators (`flagship-builder/src/userdata.ts` → the preseed
  engine bundle, `demoUsersAdminCloudInit.ts`, `installer-netboot/late-command.sh`);
  corrected the misleading "systemd re-fires under on-failure" comments in the
  deposit consumers. Older boxes came up because pre-2026-06-23 recipes embedded
  the SWK (the poller never armed). **A box already stuck this way recovers with a
  plain reboot + phone entitlement approval — no reburn needed.**
- **GRUB installs to the resolved target disk.** The d-i `partman/early_command`
  now also sets `grub-installer/bootdev "$DISK"`, so GRUB targets the virtio disk
  instead of the USB installer ISO (`/dev/sda`) — the macOS-VZ case that failed at
  `grub-install /dev/sda` after the entire base install.
- **Builder pairing acks delivery + honest pod status.** `pair.ts` sends a
  `recipe-accepted` event to the phone before cleanup; pods render a distinct
  **Pending** pill (not "Provisioning") and suppress the leader flag until a pod is
  online and not pending, across iOS / Android / webapp.
Gates: builder + control-plane + daemon-consumer vitest green, `tsc -b` clean.
**Remaining (owner):** reburn to validate a fresh box comes up clean on the FIRST
boot; the pairing / pod-status UX needs an Xcode + Gradle rebuild; the console
still prints benign kernel/ACPI noise (`AE_AML_LOOP_TIMEOUT` etc.) — GA Bucket C
item 8, diagnose before silencing.

**2026-07-19 — stalled Mac VM diagnosed; Debian media re-pinned + unattended
telemetry added.** The retained guest proved partitioning completed, then disk
writes stopped four minutes into base installation while the hypervisor burned
four vCPUs for over an hour. Its remastered media was Debian 13.5.0 (May 16)
against the live stable package mirror, after Debian 13.6 shipped July 11. Both
blessed manifests and Advanced distro pins now use Debian's official 13.6.0
amd64/arm64 release media and hashes; prod serves them, and an old 13.5 cache is
explicitly ordered to update. The shared d-i preseed now runs a non-blocking
watcher during the previously opaque base-install window: stage changes and a
two-minute heartbeat report only an allowlisted step + elapsed minutes (never
raw syslog, recipe, Wi-Fi, or disk data), and stop before `downloading`. Node,
Mac JavaScriptCore, and Android Rhino assets/vectors are synchronized. The
stalled VM was stopped; its disk and 13.5 installer remain preserved, but the
installer is moved aside so Retry cannot repeat it. The current Developer-ID
Mac app is rebuilt/reinstalled and opens the guest as a safe failed install.
**Remaining:** delete that failed VM, pair a fresh recipe, and physically
validate a complete 13.6 hosted install; the new telemetry will identify the
exact d-i stage if it stalls again.

**2026-07-19 — Mac hosted-server work made background-native.** Hosting no
longer navigates the whole center pane into an install status dead-end. A
successful USB/VM recipe handoff shows a five-second countdown, resets to a
fresh pairing QR, and leaves the VM running independently. The wider Servers
on this Mac sidebar is always visible (including the empty state), shows each
full FQDN, lifecycle, tier, CPU/RAM/disk/encryption, and live install elapsed
time. The redundant in-content app title is gone; theme is top-left and server
details add a neighboring Home button. The selected-server page is now a
scrolling dashboard with honest host-allocation bars, created/state-change/
last-connected activity, lifecycle controls, and phone-grant-gated CLI status.
Persisted VM records accept legacy files while recording new activity fields;
an in-flight install can now be stopped explicitly and retried. The signed app
is installed on disk. **Remaining:** visually validate the new layout during a
fresh hosted install.
Linux/Windows parity is also landed: five-second background-handoff reset,
always-on 330/320px server sidebars with full FQDN + resource summary, Home
navigation, and stop-install/retry controls; Linux is fully tested, while WPF
source/XML is validated but awaits a Windows build (no .NET SDK on this Mac).

**2026-07-19 — encrypted Debian reburn regression fixed.** A physical USB install
reached Debian's raw `Please unlock disk sda4_crypt` prompt because the recipe's
admin-root public key was dropped twice: by the shared preseed serializer and
again by the install-time registration helper. That changed the signed auth-code
bytes, so `.com` rejected registration before the Flagship rekey/initramfs hook
could be installed; the fixed installer passphrase consequently survived into
first boot. The optional field is now preserved and validated end-to-end, with
shared Node, macOS JavaScriptCore, and Android Rhino golden coverage plus a
registration-signature regression test. The helper is published on `main`; the
Developer-ID Mac builder is rebuilt/reinstalled and the Android debug app builds
with the corrected canonical asset. **Remaining:** validate one fresh physical
reburn through automatic unlock and registration.

**2026-07-19 — iOS↔desktop builder pairing repaired; pending-server semantics
made honest.** The iOS scanner now owns one camera session per presentation and
the phone relay waits for socket acceptance/retries transient loss; the Mac
builder tolerates the matching phone reconnecting instead of immediately
relocking. The live 403 was an admin-authority drift: `register-rck` became a
sensitive operation but all create clients still signed it with the membership
IRK; iOS/Android/webapp now use the admin signer when the account is gated.
Recipe delivery has an explicit builder receipt sent only after the Mac or
shared Linux/Windows CLI successfully verifies/stages the recipe; iOS and
Android both wait for it, then close and surface the Home pending row. Pending
is consistently orange and can never carry the Leader badge. Android's JDK 17,
SDK, API-35 ARM emulator, and shell paths are configured on the Mac; the full
unit suite, debug APK build, emulator install, and cold launch pass. A live
follow-up caught the Mac cancelling its socket as soon as URLSession queued the
receipt (before relay delivery): it now holds through the phone's confirmed
departure, leaves the obsolete live-session UI for a recipe-ready state, and
offers Start over instead of Disconnect. Missing receipts time out honestly on
both phones. Mac host-image downloads now retain/resume partials, locally
promote a complete interrupted download, show checksum verification as a
separate phase, and surface failures beside the Create button instead of only
in the collapsed log. A live Host-on-this-Mac retry then exposed both blessed
13.5 URLs as dead after Debian rotated 13.6 into `debian-cd/current`; prod now
serves the tested 13.5 amd64+arm64 bytes from Debian's immutable archive (same
official hashes/sizes), and all builder/download documentation uses that stable
source. The Developer-ID Mac app and development iOS app were rebuilt/reinstalled;
both launch; the manifest fix is deployed. **Remaining:** validate QR-first-open
and live receipt pairing and complete Host-on-this-Mac on the physical phone and
computer.

**2026-07-06 (evening, Chromebook instance) — Linux builder validated LIVE on
ChromeOS; multi-arch Linux remainder DONE; Android/iOS large-screen polish.**
On `feat/chromebook-fit` (branch off main; iOS half needs a Mac build before
merge). Validated on a real Crostini Chromebook (Debian 12 container, /dev/kvm
exposed): 228→278 pytest, a live KVM OVMF boot through QemuHost/QMP
(`query-kvm enabled=true`), the FIRST-EVER GTK render, the app on the
Chromebook's own Android layer (ADB→ARC), and a REAL end-to-end host-here run:
a headless twin of the dev phone-simulator minted a live recipe on prod
(`penguin.eager-birch.flagship.services`, de=none), and the wizard pipeline
took it manifest-download (Debian 13.5.0) → preseed-engine remaster → KVM
unattended install → duration-gated verdict → first boot → **Running** (~47
min wall) → clean QMP power-off. Remaining on that item: the LUKS/sealed
phone-approval half + entitlement grant (needs a real phone). The run
surfaced + fixed four ship-blockers no unit test could see: (a)
`Adw.ToolbarView` needs adw ≥1.4 — Debian 12/Ubuntu 22.04/Crostini ship 1.2 →
fallback layout; (b) a GTK3-only `set_hscrollbar_policy` call — the window had
never built on ANY GTK4; (c) AppImage+Flatpak packaging omitted
`pair_session.py` + the whole `vm/` package → packaged startup ImportError;
(d) the CLI locator preferred `src/cli.ts`, which plain node can't run → every
checkout builder failed its first CLI call (dist/cli.js now wins). Chromebook
fit: Crostini-aware empty-disk-picker hint (share USB via ChromeOS Settings);
`garcon-terminal-handler` support for Open-in-SSH (command verbatim, no `-e`,
symlink-resolved); elevation falls back to passwordless `sudo -n` where pkexec
can't work (stock Crostini). Multi-arch handoff (9bb1d60d) CLOSED: `-machine
virt` + explicit AHCI on arm64 (amd64 argv unchanged), VMManager host-arch
detect + cross-arch create/start refusal, wizard arch pass-through, tests. New
CI: `builder-linux.yml` runs pytest + a `render_smoke.py` window-build under
xvfb on ubuntu-latest AND debian:12 (both adw generations). Apps: Android
edge-to-edge insets (targetSdk-35 bug — slivers drew under the status bar) +
readingMaxWidth caps on detail/flow/welcome screens (validated fullscreen on
ARC with screenshots); iOS twin `.fsReadingColumn()` applied to the 5 matching
screens — **UNCOMPILED, Mac must build + run GymIPadTests + eyeball an iPad
sim before merge**.
(a) **Arch-aware ISO manifest**: `POST /api/iso-manifest` takes optional
`arch` (absent = amd64, deployed builders byte-compatible); the Worker serves a
second blessed manifest `FLAGSHIP_ISO_MANIFEST_ARM64` (official Debian 13.5.0
arm64 netinst) for the desktop apps' HOST-a-VM path on arm64 hardware — VZ and
KVM boot native-arch guests only; burning stays amd64. Guest payload is now
arch-neutral (unseal-helper builds native — no GOARCH pin; initramfs NSS
staging globs the multiarch triplet; `grub-efi-arm64` preseed twin). Engine
bundle + golden vectors regenerated AND synced to the vendored Mac/Android
copies; bootstrap sha pins re-pinned. Re-pin BOTH arches together on a Debian
point release. (b) **Mac app hosts in Simple mode on Apple silicon**: per-arch
base cache (amd64 keeps legacy names), Rosetta-safe host-arch detection
(sysctl hw.optional.arm64), honest "use Advanced + an arm64 netinst" when the
server hasn't blessed arm64; hosting now honors an Advanced BYO ISO (was a
dead end). (c) **Debug-SSH ships in v1** (owner decision): Advanced-hidden,
biometric-gated at mint, consent-as-crypto — Bucket C item 2 resolved-as-
feature; the release-guard EXEMPTS `debugAccessGate.ts`, fails on debug creds
anywhere else, and asserts the gate still calls `verifyDebugAccessGrant`.
(d) **Linux multi-arch is HALF done — HANDED OFF to the Linux-box instance**:
landed = host_arch map, manifest-client arch field, per-arch base cache,
per-arch QEMU locator (AAVMF), VMConfig/inventory arch persistence (253
pytest green). Remaining (ordered list in commit 9bb1d60d): `-machine virt`
+ explicit AHCI argv on arm64, VMManager host-arch detection + cross-arch
refusal, wizard arch pass-through, Crostini/Chromebook README, tests. Also
same evening: prod wiped (58 tables, list re-audited through 0082), 0082
applied+stamped, `.com` deployed, Mac builder re-signed+reinstalled, iOS
jetsam fix (vibe-code log cap) + dead RecoverFromWelcomeContainer deleted,
marketplace/retail re-synced+pushed.

**2026-07-05 — Linux desktop parity MERGED: the desktop trio is complete.**
`apps/builder-linux` (the last thin platform) gains the full VM-appliance host
layer at Windows/Mac parity: a pure Python VM core pinned to the shared golden
vectors (`apps/desktop-shared/golden/vm-core-vectors.json` — Python/C#/Swift
cores provably identical), a QEMU/KVM backend (`-accel kvm -cpu host`, AHCI
main disk ⇒ metal-identical `/dev/sda`, USB-attached installer ISO, OVMF, QMP;
the WHPX-only VMX/SGX masking deliberately NOT ported; TCG degrade with an
honest warning), the "Servers on this PC" sidebar + Host-on-this-PC chooser +
detail pane, phone pairing over the shared `pair --emit-events` CLI, and a
debug-grant-gated **Open in SSH** (`ssh -p <hostfwd-port> debug@127.0.0.1`,
loopback hostfwd — the affordance Mac's VZ NAT can't offer; production VMs get
no console AND no forwarded port). All GTK code stays behind `build_window`,
so the whole layer unit-tests headless. Owner validation on a real Linux box:
GTK render, live KVM boot→sealed→phone-unlock→padlock, real Open-in-SSH, live
pairing, TCG degrade (list in `apps/builder-linux/README.md`). Earlier the same
day (see agent-memory handoff): v1-hardening + gym-integration + desktop
Mac/Windows waves merged; installer disk-selection trap + first-boot-units
bugs fixed on `main`; migrations 0080/0081 applied to prod. **Migration 0082
is pending-apply before the next `.com` deploy.**

**2026-07-03 — Slice D re-escrow seam CLOSED (device-admin tier is now build-complete).**
The last build item of the admin tier: after an admin-root rotation the NEW root is
re-wrapped under the WebAuthn-PRF recovery credential on all three clients, so a
post-rotation credential recovery restores the CURRENT root (before this it restored the
dead OLD one).
- **Root-cause discovery:** `.com` was silently DROPPING the mobile `wrappedAdminRoot`
  escrow field — no storage column, no handler support — so the mobile D-3 escrow
  round-trip was a client-side illusion (webapp unaffected: it concatenates
  `umk||adminRoot` inside `wrappedUmk`). Fixed end-to-end: `wrapped_admin_root_b64`
  (migration **0067** — joins 0064–0066 in the apply-before-the-next-Worker-deploy
  list), upload accept-if-present + preserve-on-replace (mirrors the ACME escrow),
  gated fetch returns it.
- **Mobile mechanism (iOS + Android, byte-parity):** re-wrap under the EXISTING
  credential — recovery passphrase → Argon2id secrets → gated fetch (validates the
  passphrase) → PRF-assert on the existing credentialId → sanity-unwrap the fetched
  wrappedUmk BEFORE overwriting anything → wrap the new root (same
  `flagship/recovery-admin-root-wrap/v1` salt) → IRK-signed re-upload with
  wrappedUmk/wrappedAcme passed through byte-unchanged. The rotate flow gains an
  "update your recovery backup" passphrase step (iOS `.rotatedNeedsRecoveryUpdate` /
  Android `DoneNeedsRecoveryUpdate`), gated on `hasCloudRecovery`, skippable with a
  standing warning; re-escrow runs strictly AFTER publish+seal and can never fail the
  rotation.
- **Webapp:** the seam was already real (the rotation puts the new seed on the session
  before `setupCloudRecovery` re-wraps); now the rotation reports
  `reEscrow: ok|failed|skipped` and an enrolled-but-failed re-escrow shows a persistent
  warning instead of a silent success.
- **Also closed:** the inert `orders.ts` dead-PSK path is admin-gated (destructive phone
  orders route through `authorizeSensitiveOrder` when an admin root is pinned; the live
  `add-paired-session` pairing mint untouched); §9.6 custody regression tests (iOS
  keychain sync-class test for all three admin-root slots; Android backup-exclusion
  test pinning `allowBackup=false`); the release-guard's debug-console markers
  re-pointed at `debugAccessGate.ts` (false-green since the 95a460bb console lockdown —
  its self-test was red on main); a missing `swapAdminRootPub` stub in the legacy
  Fastify adapter (main didn't typecheck).
- **§9.8 transfer re-home admin-root — CLOSED same day (was "flagged, not built").**
  A transferred box now re-pins the ACQUIRER's admin root via a GIVER-root-signed
  proof it verifies against its PINNED anchor (never `.com`'s word). New spine
  envelope `flagship/admin-root-transfer/v1` (distinct tag from the rotation proof so
  it can't replay as an account rotation); the transfer CLAIM canonical → **v2**
  carrying the acquirer's admin root pub in-signature ("" = legacy ⇒ unpin); migration
  **0068** (5 handoff columns on `server_transfers`) + `POST …/transfer/admin-handoff`
  (the admin-root signature IS the auth); `transferRehomeConsumer` REFUSES the re-home
  (`awaiting-admin-handoff`, keeps polling) until the proof verifies, then the marker
  carries `newAdminRootPubHex` and boot-apply overrides `cfg.adminRootPub` with a
  one-time receipt-guarded pin reset. All three clients: acquirer claim carries the
  admin pub, giver deposits the biometric-signed proof at claim-received. Legacy
  (unpinned) boxes byte-identical. Only a reburn-validated live two-account transfer
  remains (owner + hardware).

Gates: vitest 525 files green · `tsc -b` clean · iOS build + package tests green ·
Android `:app:testDebugUnitTest` + `assembleDebug` green · release-guard +
admin-authority-guard OK. **REMAINING (owner):** the Slice D rollout — apply migrations
**0064–0068** → deploy `.com` → wipe → rebuild builder + apps → reburn (spec §7).

**2026-06-30 — builder pairing → ONE-SHOT deposit; debug box LAN-SSH-able; daemon self-heal; status/sliver fixes.**
A multi-part day driven by live hand-testing.
- **Pairing model = one-shot recipe deposit (final design).** First pass made the
  long session *resilient* (relay evicts a stale same-role socket → reconnect; ~1h
  TTL; builder holds + auto-resumes; phone persists + resumes on unlock; countdown;
  `Disconnect` buttons) — committed `449fa227`/`f185e7d6` and the **relay was
  deployed** (`.com` `8bbe7955`). Then we **simplified further** (owner call): the
  two security choices — **debug-friendly** and **embed-secrets** — are now **phone
  Advanced toggles baked into the recipe at mint** (behind the existing mint Face
  ID), so the builder has nothing to ask the phone. The link collapsed to a one-shot
  deposit (scan → SAS → mint → deliver → "Sent ✓ — you can put your phone away");
  removed the debug-consent round-trip + the resume/countdown/persisted-session
  machinery. The builder **keeps the delivered recipe** until the laptop-user hits
  the red **Disconnect from phone** button (or quits) — no auto-lock. The phone
  signs an owner-IRK `flagship/debug-access/v1` grant (`sshAuthorizedKey:""`, no box
  STK) + embeds it as the unsigned `debugGrant` sibling. (The relay's eviction/1h
  TTL/`expiresAt` stay deployed but are now vestigial under one-shot — a harmless
  deposit pipe.) Commits `2d697679` (builder), `27516794` (iOS/Android/webapp). Mac
  builder **rebuilt + reinstalled**.
- **Debug box → actually LAN-SSH-able** (`53affe15`). The grant gate created a
  `debug` sudoer with **no password and no key** ⇒ SSH impossible. Now, ONLY on a
  verified owner grant, the gate also sets the known **`debug:flagship`** password,
  ensures sshd is enabled + accepts password auth (a `sshd_config.d` drop-in), and
  writes an `/etc/issue.d` banner showing the **live LAN IP (`\4`) + creds**. All
  local ⇒ works **even when the public tunnel is down**; production (no-grant)
  untouched; the `chpasswd` line is the constant the GA release-guard targets.
- **Production console locked down** (`95a460bb`). Debug is now ENTIRELY the
  runtime grant-gate, so the inline bootstrap debug machinery was dead code:
  removed the "DEBUG BUILD — console login debug/flagship" `/etc/issue` banner,
  the inline `debug:flagship` useradd, `stripDebugFeatures`, and `debugMode`
  (production bootstrap byte-identical — sha-pin unchanged). Also **locked the
  `flagship` admin user's baked break-glass password to `*`** (Debian preseed +
  Ubuntu autoinstall) — a debug-OFF box now has **NO interactive login by any
  path** (root disabled, no `debug` user, `flagship` SSH-key-only with no key in
  prod). The only console access is the owner-grant debug toggle ⇒ a box created
  WITHOUT debug can't be shelled into without a reburn (intended; the break-glass
  was a committed universal-password liability).
- **Daemon self-heal** (`45789406`). hali came fully up, **fell off ~21 min in**
  (tunnel + heartbeat died), sat dead for an hour while powered on, and only a
  **reboot** restored it. Root cause: tunnel auto-reconnect was already on `main`
  (`f1516d8f` `superviseTunnelClient`) but the *heartbeat* was a bare `setInterval`
  with an unguarded gossip read + no fetch timeout (the daemon has no
  uncaughtException handler) → "one beat then silence". Now a self-rescheduling
  **can't-die loop** + 30s `AbortSignal.timeout`, tunnel-independent (resumes the
  instant the network returns). Incidental: vibe-code `failureReason` surfaced
  (`344772b9`, revertable).
- **Status/sliver fixes** (`f185e7d6`): a server **awaiting a burn** no longer shows
  a spinning **"Deploying"** sliver op (mobile suppresses for pending; webapp gates
  on phase + relabels "preparing"); the **webapp** ops/trust sliver now reserves
  layout space (push-down) instead of a `position:fixed` overlay (iOS/Android were
  already correct).

Gates: builder-mac swift 84 · iOS 1270 · Android `:app:testDebugUnitTest` +
`assembleDebug` green · webapp vitest 1611 · server-daemon vitest 1671 · relay 21 ·
`tsc -b` clean. **Deployed:** `.com` Worker `8bbe7955` (relay). **REMAINING
(owner):** **reburn** to validate the debug-access LAN-SSH gate + the daemon
heartbeat self-heal live (both box-side; existing boxes like hali keep the old
daemon until reburned); **rebuild iOS + Android**; the webapp Advanced toggles ride
the next `.com` deploy.

**2026-06-28 — ONE preseed generator (Swift twin deleted).** The preseed/user-data
generator is now a single TS implementation run on Node (Linux/Windows CLI),
JavaScriptCore (macOS/iOS), and Rhino (Android), ending cross-language drift. ECMA
`utf8ToBase64` replaces the only Node dep; committed es5 bundle
`engine/preseed-engine.js` (zero Node builtins) the native builders ship +
`engine/golden/preseed-vectors.json` cross-engine contract (caught a real Rhino
block-scoping bug in CI). Swift `UserData.swift` 2,200→81 lines (façade); Android
`PreseedEngine.kt` (Rhino, interpreted). Bonus: `debugGrant` now threads end-to-end
(was silently dropped on every non-Swift path).

**2026-06-27 — builder pairing parity.** Linux/Chromebook CLI `flagship-build pair
--debug` mirrors the macOS debug-consent (signed grant verified locally vs owner IRK,
embedded as recipe `debugGrant`). Android `FatVolume.buildPreseedVolume` is a
pure-Kotlin FAT16 builder for the on-device OTG remaster (placement still owner-side).

**2026-06-26 — phone PAIRS WITH the builder (inverted QR).** The builder opens LOCKED
(shows a QR + 8-char code); the phone scans, both confirm a SAS, and the live socket
IS the gate (drop → re-lock); the phone then mints + delivers the recipe over the
session. New `.com` `BuilderRelaySession` DO + `/builder-pipe`. A **delivery chooser**
on iOS/Android replaces "scan the site": Pair with builder / Save recipe file / Copy
recipe / Burn on-device (Android). **Consent-as-crypto**: the builder Advanced debug
toggle → phone signs a `flagship/debug-access/v1` grant → box-side `debugAccessGate.ts`
verifies it vs the owner IRK (no grant ⇒ production image). Android in-device USB-OTG
builder (no-root BOT/SCSI writer); full on-device ISO remaster infeasible → documented
`VerbatimInjector` seam. Spec: `docs/recipe-delivery-and-remote-install.md` (Path B).

**2026-06-24 — direct lead-read.** Clients read live per-service leadership straight
from a box (`GET /api/leads`, unauthenticated) instead of the ~5min `.com` heartbeat
relay; gossip is a full broadcast so any one box serves the whole account map; falls
back to the relay on 404/error.

**2026-06-24 — vendored argon2.** Replaced the flaky `Argon2Kit` git submodule with a
locally-vendored `phc-winner-argon2` (rev 62358ba) under
`apps/mobile/ios/Vendor/CArgon2/` + a thin `FlagshipArgon2` wrapper (identical API),
proven byte-identical via the recovery KAT → hermetic iOS builds, no more submodule
clone failures.

**2026-06-23 — routing resolution (eager-claim + nudge-on-miss + park-or-drop).** The
hub resolves a cold meta-URL on demand: it parks the pre-handshake TCP stream, nudges
the user's online boxes (`POST /internal/route-nudge`, plaintext), the gossip-elected
lead claims the name the normal way (HELLO `controlledDomains`), and the hub pipes the
parked stream on claim; no claim in ~4s → drop. The box claims BEFORE traffic ⇒ no
ordering race. On service delete the harness unclaims at the hub. Cert pre-warm can't
mint unilaterally (a never-minted meta-URL cert still needs the phone's
`ServiceCertAuthority`).

**2026-06-23 — unified live-update channel.** ONE foreground long-poll
`GET /api/users/:u/stream?cursor=<hash>` (hanging GET, content-hash cursor) replaces
the pollers; carries install-event phases, pod liveness, and box-requests. ONE
app-scope `LiveSync` per platform, polls only when focused, graceful fallback to
`/pods` polling on error.

**2026-06-23 — multi-pod liveness + per-service leadership by gossip.** No global
leader — only **per-service leads** (the highest-**clout** live runner of a service is
its `<service>.<user>` route target) + a frontend "preferred server" default. Clout =
recent owner vote > oldest signed birth cert > alphabetical. Boxes gossip over a
reserved `broadcast--<user>.flagship.services` fan-out (the hub fans an opaque
**CGK**-encrypted blob, content-blind; `CGK = HKDF(umk.seed,
"flagship.cloud-gossip.v1")`). Each round a box claims its route iff it's the
highest-clout live runner and **yields** when outranked (the release half is what kills
the route flap). CGK is provisioned post-boot via `flagship/cgk-delivery/v1` (never in
the recipe). "Set preferred server" = a signed `set-leader` deposit. `/pods` carries
honest `liveness:"live"|"unreachable"|"never"` + a per-pod base URL + per-pod token
store. Spec: `docs/multi-pod-liveness-session-leadership.md`.

**2026-06-23 — recipe is FULLY secret-free.** Both the SWK and the create-time pairing
key are gone from the default recipe (the first recipe carries ZERO secrets ⇒ safe to
hand off). DEFAULT (online): IRK-signed orders sealed to the box identity + deposited
post-registration; the daemon polls + opens them with its identity key. OFFLINE
(advanced): orders embedded plaintext, verified under the owner IRK, added locally with
no `.com`. The SWK is delivered post-boot (sealed to the box's registered identity, the
daemon's `swkDepositConsumer` claims it); the pairing keypair is eliminated. A single
"Advanced mode" toggle (OFF by default) gates the offline-embed path. Spec:
`docs/recipe-delivery-and-remote-install.md`.

**2026-06-23 — graceful server REPLACEMENT & decommission.** Replacing an active server
first RETIRES the incumbent so two live boxes never split-brain the FQDN. A signed,
instance-bound (to the retiring box's STK) `flagship/server-decommission/v1` eviction
order tells the box to flush a final backup, release routing, and power off
(disposition: keep / wipe-after-handoff / wipe-now). Backup ≠ routing — the closeout is
entirely outbound, so revoking routing never blocks the final backup. Migration 0063
`server_evictions`; hub `evictionLookup` rejects an evicted STK at HELLO, **fail-OPEN**
on a `.com` outage. Clients: "Replace this server" with a hard backup pre-flight gate.
Spec: `docs/server-replacement-graceful-decommission.md`.

**2026-06-23 — build-a-service ENABLED on real boxes.** Root cause of `/api/services`
404 on every real box: the daemon only constructs `servicePlatform` when it has an SWK,
and the phone→box SWK handoff was never wired. The SWK is deterministic
(`deriveSWK(umk, serverId) = HKDF(seed, "flagship.swk.v1|serverId")`), so the phone
provisions it (recovery is free/automatic). **⚠️ TWO SWK derivations**: the BOX one
(`ServerKeys.deriveSwk`, info `flagship.swk.v1`, **DOTS**) vs the app-backup one
(`flagship/swk/v1`, **SLASHES**) — box provisioning uses DOTS. Un-reburned boxes show
"This server isn't set up to build services yet" (404 mapped). The live LLM provider is
still NOT wired in the daemon (git-import works; AI "adapt"/scratch streaming await it).

**2026-06-22 — username + service addressing.** (a) The slug↔creator delimiter is `--`:
composite `<creator>--<slug>`, url form `<slug>--<creator>`, bare when self-authored;
usernames allow interior single dashes (`^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$`, `--`
banned). Routing/certs are delimiter-agnostic (the SNI router splits on the first dot,
leftmost label opaque) — naming/parsing only, never the cert/routing layer. (b) Sign-up
HANDS the user one random `<adjective>-<noun>` handle (no typed field — a custom name is
a future paid change); `POST /api/username/suggest` pops from a pre-validated queue
(migration 0061; `.com`-excluded via DoH; reject-is-lost defeats reject-then-predict),
with an escalating per-device throttle. (c) Claims are GATED to recently-suggested names
(migration 0062 `username_offer` roster, 1h TTL) — the generator is the gatekeeper.
Specs: `docs/service-addressing-double-dash.md`, `docs/username-suggestion-queue.md`.

**2026-06-22 — naming/recovery model decided.** Names are self-custody + forever (no
admin stripping / GC / no-credential grace-takeover); recovery is credential-only;
account creation assigns a free random name; changing a name costs ~$5 (a same-owner
namespace migration reusing the transfer-a-box machinery; IRK unchanged ⇒ no disk
re-seal); a 12-month launch dibs lets domain holders claim matching names via DNS
proof. Removed the no-credential "claim after a wait" option. Spec:
`docs/naming-recovery-and-name-change.md` (10 open decisions remain there).

**2026-06-22 — Box Request Inbox.** One always-on channel for "a box is asking its
owner" over the generic `flagship/secret-request/v1|...|purpose|...` primitive
(`purpose` IS the type). `/pods` returns a typed `pendingRequests` digest; each platform
has one type registry (`unlock-key`, `entitlement`, …; new types = one entry + one
purpose string); an entitlement-stuck box now surfaces as a one-tap card instead of a
silent crash-loop. Spec: `docs/box-request-inbox.md`. Deferred: an SSE/WebSocket+push
transport (currently a foreground poll).

**2026-06-21 — account-deletion ceremony + reclaim (all 4 surfaces).**
`account-self-delete` + `servers-self-delete` owner-IRK envelopes; last-device-enforced
hard-delete of the username row (frees immediately) + ordered per-server teardown; the
§5 atomic bundle (the content-wipe order is accepted only bundled with a valid
last-device account delete). Box-side self-delete EXECUTION shipped (self-delete mailbox
lane, deposit-on-commit, **revoke-tolerant** consume, daemon `selfDeleteConsumer` →
`realWipeContent`). Admin reclaim ≥90d inactive (migration 0058 `last_active`). Spec:
`docs/account-deletion-and-name-reclaim.md`.

**2026-06-21/22 — transfer-a-box MERGED to `main`.** The broker is a **namespace
migration** (the box FQDN/cert/DNS/routing all encode the owner → `alice`→`bob`
re-homes the box), not a username swap; the LUKS re-seal is a **giver-phone** step (only
it holds the giver IRK). `server-transfer-offer`/`-claim` envelopes; `server_transfers`
broker lane (migrations 0059+0060); daemon `transferRehomeConsumer`; giver-QR +
acquirer-camera clients; server-detail "Transfer to another account" entry wired.
Deployed; box-side re-home + the disk-key handshake need a reburn.

**2026-06-21 — entitlement deposit folded into first-boot unlock.** Approving the
unlock also mints + deposits an owner-IRK RootEntitlement for the box's STK ⇒ an
encrypted box comes online with ONE approval. New blind `entitlement-deposit` lane; the
daemon claims it before relaying.

**2026-06-20 — ⭐ root cause "real boxes never came online".** Hub IRK-signature
enforcement went live but the builder still minted a SELF-SIGNED RootEntitlement ⇒ every
real box's HELLO was rejected ⇒ "Never came online". Fix: the builder writes NO
`entitlements.json`; the daemon's first-boot relay requests an IRK-signed one from the
phone. Follow-ons: pairing-deposit TTL 5min→14d; daemon entitlement self-heal (discard
a non-IRK-signed bundle vs crash-loop); `awaitingEntitlement` on `/pods`. Boxes
self-heal by removing `/var/flagship/entitlements.json` + restarting.

**2026-06-20 — security fixes.** (a) iOS sign-out left the iCloud-synced account key
behind (`SecItemDelete` without `kSecAttrSynchronizableAny` only matches non-synced) →
survived reinstall; FIXED. (b) Low-order Ed25519 acceptance — the all-zero key + zero
sig VERIFIED (squat/forgery); FIXED at the single `ed` chokepoint (`edSync.ts` Proxy
rejects the libsodium small-order blocklist, covering all ~104 call sites). (c)
Migration drift — a Worker deploy can run AHEAD of prod D1; always audit + apply pending
migrations as part of a deploy; added a deploy-time drift gate
(`FLAGSHIP_CHECK_PROD_MIGRATIONS=1`, wired into the predeploy script).

**2026-06-19 — create-time pairing.** The creating device comes online ALREADY paired
(no manual tap). The box identity is random/unknown at create, so the phone mints a
fresh PAIRING keypair, seals an owner-IRK `add-paired-session` order to its pub,
deposits the sealed blob to `.com`, and embeds the pairing key's private half as an
UNSIGNED recipe sibling `pairingKeyPrivHex` (protocol/canonical bytes untouched). Random
revocable token, not deterministic. (Largely superseded for hand-off safety by the
2026-06-23 secret-free recipe work; `pairingKeyPrivHex` is now gone from the default.)

**2026-06-17 — maintainer-trust enforcement.** The maintainer→CA blessing is now
load-bearing: `GET /api/maintainer-blessing` exposes the chain; apps verify
`pin → authorizedCaKeys(now) ∋ servedKey` against their baked
`MAINTAINER_PINNED_MANDATE_HASH` (red sliver + biometric override → device-signed
`TrustException`); the box↔relay fetches a daily `ServiceBlessing` behind
`FLAGSHIP_RELAY_TRUST_ENFORCE` (default OFF, so the fleet is never bricked). A backdated
90d `CaEndorsement` is committed + `CA_ENDORSEMENT_ENFORCE=true` is live. Deferred: the
NFC ceremony app; a direct LAN/box-AP trust channel; flip relay-trust on a canary;
re-mint the lease before 2026-08-31. Spec: `docs/maintainer-trust-enforcement.md`.

**2026-06-14–17 — feature platform + UI + gym.**
- **build-a-service multi-mode** shipped (chooser: scratch / git / mcp / marketplace /
  journal; shared build journal; AI-adapt; value-free env-requests; **BYOK wired live**
  with a transient sealed per-build credential store — `.com` is never in the credential
  path; an AI-key step on every surface). The box never needs an AI key as architecture.
  Spec: `docs/build-modes.md`.
- **global "active operations" sliver** (WhatsApp-style top strip) on all surfaces, fed
  by a generic `ActiveOperationsCenter` (deploy ops derived from `/pods`; build ops
  registered imperatively).
- **owner-only journal diagnostics** (`POST /api/journal`, owner-IRK-signed, same shape
  as `/api/power`; logs never leave the box).
- **session-action buttons simplified** (Lock with Face ID / Lock with passkey / Remove
  device; greyed-but-tappable until recovery is enrolled); **webapp PIN lock**
  (device-pepper-bound, 5-try lockout → wipe).
- **UI test gym** (`docs/ui-test-gym.md`) — deterministic UI-test harness across
  web/iOS/iPad/Android + a live `gym.` tier. `npm run gym:locked` (fast, no cloud) /
  `gym:total` (overnight, real boxes). Proven: full-platform gym boxes (services/build/
  git over a real box), real-server e2e suites (`npm run live-e2e` / `:web`), a live LE
  box. Caught + fixed several real GA bugs (a dead iOS Account-security route, a webapp
  white-screen, cert-pin downgrade).
- **`feat/marketplace`**: `main` shed all marketplace/monetization app code; the branch
  = `main` + the feature, with Android brought to iOS parity. Launches only on merge.

**2026-06-12 — apex "Front page" + phone-approval unlock proven on metal.** The
owner-assignable apex 302s (no-store) to an installed service's tier-1 canonical
(REDIRECT, not serve-in-place); `set-front-page` PhoneOrder. The full phone-approval
LUKS chain validated end-to-end on real hardware — root cause of the earlier hang: the
initramfs opened LUKS as `flagship_root` but Debian's cryptroot only skips an active
target under its crypttab name (`sda4_crypt`); the premount now reads the name from
crypttab. The box serves a self-contained apex landing page (never leaks visitors to
`.com`).

**2026-06-10/11 — cert model A′ + simplification.** Migrated off model C (per-box key +
per-user wildcard, which hit LE duplicate-cert limits past ~5 boxes) to **A′: per-box
wildcard** `[<server>.<user>, *.<server>.<user>]`, box-local key. Reverted `--` →
hierarchical `<service>.<server>.<user>` for tier-1. Three trust tiers encode assurance
in the share URL (canonical pinned / `<service>.<user>` leader-routed / voi.ci visible
redirector). Cert-fingerprint pinning (hard-fail) off the STK-signed daemon-status
heartbeat (`signedStatus` relayed verbatim on `/pods`, migration 0048). Tier-2 shared
service certs via `ServiceCertAuthority`. Cert model simplified to one self-renew policy
(dropped the managed-vs-autonomous choice). Lock & power-off + dead-man heartbeat-lock
shipped (owner-IRK `/api/power`). ⚠️ The PhoneOrder path is dead on real boxes
(`psk.pub.hex` is never written) — power-off + dead-man use the owner-IRK path; fix the
rest of the orders surface before GA. Spec: `docs/cert-model-A-prime-migration.md`.

**Hardware / boot — Debian-only.** Debian is the sole shipping path; Alpine is parked on
the `alpine` branch (its initramfs wouldn't enumerate USB on metal). A server-driven
base-ISO manifest (`POST /api/iso-manifest`, blessed via `FLAGSHIP_ISO_MANIFEST` Worker
env) lets the builder's Simple mode download + sha-verify the Debian base itself.
Wi-Fi-in-initramfs unlock (build-time driver/firmware staging + a bounded best-effort
premount) + a no-LUKS escape hatch (phone-signed `InstallBlob.diskEncryption`, default
on). Boot worker consolidated into `flagship-com` (`boot.flagshipserver.com` is a custom
domain). Earliest phone-home beacons in the preseed.

### GA close-out TODO (do NOT do in dev) — dev-mode disablements ("Bucket C")

> Capabilities intentionally LEFT ENABLED for bring-up that MUST be disabled/removed
> (and gate-enforced) at GA. The CI gate (item 4) is what keeps the rest from silently
> regressing into a release.
>
> 1. **Guard/disarm the prod-wipe script** (`scripts/wipe-all-users*.sh` / `*.sql`) —
>    add a per-env confirmation token + a prod row-count safety/dry-run + an
>    audit-logged admin-only path, or remove it from the deployable surface. Keep its
>    table list in sync with new migrations until then.
> 2. **~~Remove the `debug`/`flagship` console user~~ — RESOLVED AS A FEATURE
>    (owner decision 2026-07-05).** Grant-gated debug access SHIPS in v1 for
>    advanced users who want to tinker: the creds exist ONLY when the box
>    verifies the phone-minted, biometric-gated, owner-IRK-signed
>    `flagship/debug-access/v1` grant (`server-daemon/src/debugAccessGate.ts`,
>    the single sanctioned home — the phone toggle lives under Advanced at
>    mint). The old unconditional inline bake was already removed (95a460bb).
>    The release-guard now EXEMPTS the gate file, still fails on debug creds
>    anywhere else, and positively asserts the gate keeps calling
>    `verifyDebugAccessGrant`.
> 3. **Remove the burn-time LUKS recovery passphrase**
>    (`flagship-build-time-luks-rekey-me-immediately`, in `flagship-builder/src/userdata.ts`
>    + the Swift mirror) **and re-enable the `luksRemoveKey` guard** (deliberately
>    guarded off, not deleted, so the slot survives bring-up).
> 4. **✅ DONE — CI grep-gate that FAILS a RELEASE build** if the item-3 constant is
>    present (`scripts/release-guard.sh` + `.github/workflows/release-guard.yml`;
>    enforces on `release-*`/`v*` tags, advisory on PRs). Correctly RED today (the
>    constant is still present by design) — removing item 3 turns it green.
> 5. **Remove the demo/dev flips** in the builder + apps (demo-mode + the 3-tap
>    live/mock toggle).
> 6. **Fill the `pro.html` payment placeholders** (Monero + mailing address) — needs the
>    owner's real addresses. NOTE: `pro.html` lives on `feat/marketplace`.
> 7. **Remove the `DEV_LATE_LOG` / W12 debug endpoints** (unauthenticated late-command
>    log-exfil + admin-gated Hetzner rescue/destroy/ISO-upload routes in
>    `apps/com/src/controlPlaneRoutes.ts`).
> 8. **Quiet the box console** — booted boxes print benign kernel/firmware noise
>    (`ACPI … AE_AML_LOOP_TIMEOUT`, driver warnings) over the FLAGSHIP login
>    banner because the preseed sets no `quiet loglevel=3` on the kernel cmdline.
>    DIAGNOSE FIRST (pull `journalctl -b -p warning` off a real box; classify each
>    line benign-kernel / firmware-noise / real-Flagship-warning; fix the real
>    ones at the source), THEN add `quiet loglevel=3` (± `pcie_aspm=off`) to the
>    preseed GRUB cmdline. Owner decision 2026-07-20: do not blanket-silence.

### Parity follow-ups

The cross-surface parity follow-up list is **empty** — all closed (add-server chooser,
post-recovery keep/replace/wipe, multi-pod `PodSwitcher`, companion-requests poll,
Android `AddControlDevice` order-send). Re-rebase `feat/marketplace` + `feat/retail`
onto `main` when convenient (the gym + apex-threading are main-only refactors).

### Static-asset content-hashing (site-ops, not started)

flagshipserver.com flashes unstyled during a Worker deploy: `apps/web/public` assets use
plain names served `max-age=0`, so a mid-deploy transient CSS 404 hits the SPA HTML
fallback. Fix (its own effort — touches the same files as the webapp refactor): a build
step that content-hashes filenames + rewrites every reference, then serves them
`immutable, max-age=1yr`. Cheap mitigation: make the Worker return a real 404 (not the
SPA HTML) for `.css`/`.js` (anticipated at `apps/com/src/route.ts:746-752`).

### Live in production

- **Per-box wildcard TLS** (model A′) — one Let's Encrypt cert per box,
  `[<server>.<user>, *.<server>.<user>]`, real green padlock; ACME runs on the user's
  daemon over SNI passthrough; `.services` stays content-blind. Wildcard via DNS-01.
- **Per-user TLS milestone** verified live 2026-06-02; encrypted-box e2e + phone-approval
  unlock proven on metal 2026-06-12.
- Auto-unlock-lease (one-shot + long-lived) with silent renewer; WebAuthn-PRF cloud
  recovery; Web Push (RFC 8291 encrypted payloads); `/consume` → push.
- Recovery Phase B backend deployed (single-device re-pair grace 3d; wrapped-UMK fetch
  returns `registeredIrkPubHex` for rotation detection).
- Brand/teal migration complete (rounded-square-containing-a-circle mark; the flag-on-mast
  pennant is **retired — do not reintroduce**).
- Cloud gossip / per-service leadership machinery shipped (needs a reburn to validate the
  live fan-out).

### Open work

**Remaining to a live box (owner + hardware):**
1. **✅ DONE — ISO manifest is LIVE on prod.** `FLAGSHIP_ISO_MANIFEST` is deployed
   (Debian 13.5.0 netinst, version-pinned, official sha) and a real recipe's Simple-mode
   download worked end to end. Only maintenance remains: re-pin all three fields
   (version/url/sha) on a new Debian point release, then redeploy `.com`.
2. **Rebuild + re-sign the Mac builder** (it ships Simple-as-default + the manifest client
   + the JSC preseed engine).
3. **Run the wipe** — `bash scripts/wipe-all-users.sh` (NOT the raw `--file` .sql: prod
   D1 drifts from the repo migrations; the runner deletes each table independently).
4. **Verify Debian-preseed reliability + live e2e** — cmdline injection was per-ISO flaky;
   then create-account → recipe → burn → boot → phone-home timeline → registers → green
   padlock.

**App / recovery:**
5. **Recovery Phase B re-pair branch** — code done; validate on a real device that a
   rotated-key recovery lands in re-pair-with-grace and an unrotated one pairs instantly.
6. **iOS owner-device confirmations** (cross-device-QR recovery; Passwords-app icon flip;
   a real burn → green padlock).
7. **iOS diagnostics** — jetsam memory crash after ~14 min (Memory Graph Debugger);
   input-field delay on "I already have an account" (confirm with a Release build).

**Ship / launch (owner-side, mostly):**
8. **Stores** — iOS TestFlight (Associated Domains, Archive + ASC upload, 5 testers);
   Android Play (signed AAB, internal track, 5 testers). Neither is on a store yet, so
   push / Live-Activity can't reach a device.
9. **Marketplace security scanner** — `marketplace_listings.scan_grade` ships NULL; needs
   the Trivy + custom-checks service. MVP gate before a public marketplace.
10. **v1-alpha live exercises** (multi-day, observational): recovery / rotation /
    update-pack; peer-backup at scale; marketplace MVP; public disclosure + bounty path.
11. **Disarm dev-mode disablements before real users** → see the GA close-out TODO above.
12. **In-house AI inference server** (build-modes follow-on) — today AI-authoring is BYOK
    (box calls the user's provider directly, no infra). When we host a model, wire it as a
    third posture: run an OpenAI-compatible endpoint and flip the `LlmHarness`
    `baseUrlGuard` (`allowPrivate`/`allowHttp`/`hostAllowlist`). The adapter already
    exists. Spec: `docs/build-modes.md` "in-house inference server".

**NFC retail tier (post-v1; design in `docs/v1-operational-tasks.md § N`):** protocol +
daemon state machine + cloud activation API are built & partly live; the read-only tap
flow + LED-SAS verify landed on `feat/retail` (branch-gated). Remaining agent-doable:
N-PHONE-3 write tap, N-PHONE-6 LED capture UI, N-BOX-8 daemon rendezvous consumer.
Hardware bring-up waits on the hardware-shipping business decision.

### When in doubt

This file is the in-repo source of truth. For deeper detail, read the relevant living
spec in `docs/`, the runbooks in `docs/runbooks/`, or — for architecture —
`project_overview.md` in agent memory. `docs/archive/` is frozen history.

### Living design specs (index)
- **Cert & addressing** — `per-user-cert-and-addressing.md`, `per-user-cert-worklist.md`, `multiplexing.md`, `service-addressing-double-dash.md`
- **Recovery / multi-device / security** — `multi-device.md`, `lifecycle-spec.md`, `security-phone-as-unlock-endpoint.md`, `box-request-inbox.md`, `v1.2-security-cascade.md`, `revocation-ui.md`, `wipe-restart.md`, `watch-delegate-key-design.md`, `v2-device-addressing-and-real-ticket.md`, `account-deletion-and-name-reclaim.md`, `server-replacement-graceful-decommission.md`, `box-recipe-persistence-and-restore.md`, `multi-pod-liveness-session-leadership.md`
- **Login / accounts / demo** — `login-and-account-redesign.md`, `naming-recovery-and-name-change.md`, `username-suggestion-queue.md`, `sample-users.md`
- **Install / ISO / builder** — `recipe-schema-v2.md`, `installer-tiny.md`, `installer-netboot.md`, `cloud-init-direct-provisioning.md`, `installation-real-usb.md`, `reproducible-iso-build.md`, `recipe-delivery-and-remote-install.md`
- **NFC retail box** — `nfc-box-pairing.md`, `v1-operational-tasks.md § N`, `n-cloud-2-design-discussion.md`
- **CA / maintainers** — `ca-operations.md`, `maintainer-ca-endorsement.md`, `maintainers-checkpoints-spec-v0.1.md`, `maintainers-deployment.md`
- **Marketplace / apps / monetization** — `app-developer-guide.md`, `manifest.md`, `monetization-free-tier-first.md`, `multi-device-monetization.md`, `vibe-code-experience.md`
- **Testing** — `e2e-test-plan.md`, `ui-test-gym.md`
- **Design / ops** — `design-system.md`, `psl-submission-flagship-services.md`, `main-reconciliation-plan.md`, `runbooks/`, `policy/`
