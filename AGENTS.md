# Flagship — orientation for Codex

Personal-cloud ecosystem. The phone is the trust root; users run their own server on commodity hardware at home; **TLS terminates on the user's box** so flagship.services literally cannot read user content. Verified end-to-end in production with a real green padlock as of 2026-05-05.

**This file is the single in-repo source of truth for current status and open work** — see "Current status & open work" at the bottom; update that section as work lands rather than starting new `docs/*handoff*.md` files. `CLAUDE.md` imports this file using Claude Code's supported `@AGENTS.md` syntax; never hand-sync a second copy. If you have access to agent memory, `project_overview.md` is a deeper architectural briefing (`final_architecture_2026_05_05.md` has the gory detail). Dated session handoffs and completed launch trackers are frozen in `docs/archive/` (history only).

## What's where

```
apps/com/                  Cloudflare Worker — flagshipserver.com (identity + state) + webapp./remote.flagshipserver.com (host-rewrite)
apps/web/                  Fly app — flagship.services (stateless data plane) + the webapp static surface
apps/web/public/           Static assets served by the Worker's [assets] binding
   studio/                 /studio — short desktop download + direct phone-pairing guide
   dev/create-server       /dev/create-server — phone simulator
   status/                 /status/ — live health dashboard
   security/               disclosure.html, report.html
   webapp/                 PWA source (served at root on webapp. AND remote.flagshipserver.com)
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
- `https://webapp.flagshipserver.com/` — the owner webapp (PWA)
- `https://remote.flagshipserver.com/` — browser remote (phone-approved, keyless)
- `https://flagshipserver.com/studio` — download Studio + direct phone-pairing guide
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
npx tsc -b && (cd apps/com && npm run deploy)   # Worker — it bundles the BUILT dist/ of the packages in scripts/com-bundled-packages.sh. Use `npm run deploy` (NOT `wrangler deploy` directly): its `predeploy` rebuilds those packages from an empty dist/ (scripts/clean-build-com.sh — `tsc -b` alone never deletes a removed module's output) and then runs the guard (scripts/predeploy-com.sh — route-safety + dist-freshness + orphaned-output + migration drift)
export PATH="$HOME/.fly/bin:$PATH"
flyctl deploy --remote-only --strategy=immediate --yes -a flagship-services

# D1 schema migrations
cd apps/com && npx wrangler d1 execute flagship-state \
    --file=../../packages/storage/migrations/0003_install_events.sql --remote

# Smoke a fresh build chain
# 1. Create and download a signed recipe from the webapp (or pair a phone with Studio)
# 2. Open the recipe in Flagship Studio and write the installer
# 3. Boot the target, then curl https://<assigned-subdomain>/
```

## Conventions

- **No `Co-Authored-By: Codex` trailer on commits** — user preference.
- BUSL-1.1 license. Change Date 2030-05-03 → Apache 2.0.
- Imperative commit subjects. Body explains *why*, not *what*.
- TypeScript ESM, strict mode, `noUncheckedIndexedAccess`.
- Tests live next to packages: `packages/<pkg>/tests/`.
- Canonical-bytes use `|` separator and `flagship/<purpose>/v1` tag prefix.
- No comments unless the *why* is non-obvious; never explain *what*.
- **Minimum OS = the oldest version that is still SAFE to use** (owner rule,
  2026-10-07). "Safe" = the vendor still ships security fixes for that branch
  AND every security feature the app relies on works there. Never raise the
  floor for convenience; raise it when a branch stops getting security fixes
  or a security-critical API needs it. Re-check on every toolchain update.
  Current floors: **iOS/iPadOS 18.0** (iOS 17 stopped receiving fixes, every
  iOS 17 iPhone can run 18, and passkey PRF — cloud recovery — is iOS 18+),
  **watchOS 11.0** (the iOS 18 companion). Not yet reviewed against the rule:
  the Mac Studio app (`macOS 14`) and Android (`minSdk 28`) — see the open
  list. Platform versions in the `swift-tools-version:5.9` manifests use the
  string form (`.iOS("18.0")`); `.v18` needs tools 6.0, which also flips on
  Swift 6 strict concurrency.
- **Unlaunched features live entirely on their own branch; `main` ships clean.**
  Every not-yet-launched feature — site literature, app code (iOS/Android/
  webapp), backend logic, AND tests — lives ONLY on its feature branch, so
  `main` "doesn't think of" it at all. Current branches: **`feat/marketplace`**
  (the marketplace; also Pro payments + vouchers), **`feat/retail`** (getting the
  app working with retail / NFC boxes), **`feat/browser-extension`**,
  **`feat/phone-usb-burn`** (Android burns a USB stick on its own),
  **`feat/custom-names`** (dibs + paid name change) and **`feat/custom-domains`**
  (custom domains as a Pro feature) — the last two branch OFF `feat/marketplace`
  (they need its payment rail), so rebase them onto it after it moves —
  **`feat/lan-direct`** and **`feat/free-tier-throttle`** (both off `main`). **No marketplace/retail code may sit on `main` until
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

> **Current state only.** Update entries in place as work lands; delete them
> when done. History up to 2026-10-10 is frozen verbatim in
> `docs/archive/status-log-through-2026-10-10.md`; read it for the why behind
> anything below. Keep this section short: it loads into every agent session.
> Last updated **2026-10-10**.

### Urgent

- **Renew the CA endorsement lease before 2026-11-05.** The production CA's
  only live lease (`.maintainers/ca-endorsements/bundle.json`) expires then, and
  every CA-chain check fails closed after it (app trust checks, relay blessing,
  Alpine bootstrap). Needs the owner's YubiKey: mint a `CaEndorsement` with the
  maintainers CLI, commit it, redeploy `.com`.

### In flight

- **iOS 1.0 (build 4) is in App Review.** Apple asked a 2.1 business-model
  question; it was answered (no paid features; Terms §3/§4 and Privacy §2.4 now
  say nothing is sold) and build 4 resubmitted 2026-10-10. Reviewer login: demo
  `playstore-test-0725`, shared with Google Play review: never tear it down
  while either review is open. Still to confirm: the export-compliance answer
  (the app does its own X25519/AES-GCM/Ed25519 sealing).
- **Google Play:** reviewer build `versionCode 8`. Version codes are burned by
  any upload, so always take one above the highest in App bundle explorer. The
  upload cert is not in `assetlinks.json`, which is right for Play but breaks
  passkey recovery on a sideloaded APK.
- **Throwaway demo `drill-1010`** (UpCloud) exists for update-server testing.
  Tear it down with `node scripts/sample-user.mjs cleanup drill-1010` when done.
- **VM appliances published 2026-10-10 (both arches)**, built by `vm-appliance.yml`
  from `9873b83e` (amd64 under KVM, arm64 on `ubuntu-24.04-arm` under TCG) and
  uploaded to R2 `flagship-iso/` with their manifests in
  `apps/web/public/downloads/`. They include the one-approval restart fix and
  per-provider AI model defaults. The July hand-built arm64 image is retired.

### Built, waiting on deploys or rebuilds

- **`.com` Worker:** current with `main` as of 2026-10-10 (webapp shell **v33**).
  Always `npx tsc -b` first and apply pending D1 migrations before deploying.
- **iOS / Android:** `main` has fixes not yet in a store build: the iOS
  known-bug fixes (retried account creation registered a second device; Wipe &
  restart kept the old key), Android's matching retry fix, the Android parity
  fixes, and the update card's "last update" line. Both need rebuilds.
- **Box-side changes** reach existing boxes only through an endorsed update or a
  reburn. Not yet validated live on a phone-created box: phone-approval unlock
  on a box sealed with current code, the post-boot SWK / pairing / entitlement
  deposits, CGK gossip claim/yield + route nudge, the debug-access gate,
  self-delete, transfer re-home + giver→acquirer disk-key handshake.

### Update this server (2026-10-10)

The whole pipeline works on a demo box: the owner's YubiKey endorses a release
with `node scripts/endorse-release.mjs --to <sha> --from <box commit> --sign`
(run in a real terminal: the PIN prompt reads `/dev/tty`), the order goes in
(demo: `POST /api/dev/sample-user/<u>/order-update` with `x-admin-secret`), the
box applies it, and a release that fails its boot health gate rolls back on its
own (drilled on `drill-1010`). Boxes now record the verdict in
`/var/flagship/update-outcome.json` and server-detail returns it as
`lastUpdate`. Remaining: send an order from the webapp, iOS and Android on a
real (non-demo) account (demo sessions are keyless), and see the new
`lastUpdate` line live once a box runs that code.

### Desktop Studio

- **Mac:** notarized DMG at `/download/mac` (`scripts/release-studio.sh`).
- **Windows + Linux:** `studio-v0.1.0` on GitHub Releases, built by the
  on-demand `studio-release.yml` (pass `publish=true` to release). Windows is a
  zip with `xorriso` bundled in `tools\`, **unsigned** (no code-signing cert;
  v0.0.1 wasn't signed either). Linux is an x86-64 AppImage that needs Node.js
  20+ and pkexec. Neither has been run on a real Windows PC or Linux desktop:
  see "Validating on Windows and Linux" below.
- Studio's VM networking is NAT on every host, so a hosted VM can never be
  reached directly from a phone on the same Wi-Fi (matters for `feat/lan-direct`).

### Validating on Windows and Linux

Follow `docs/runbooks/desktop-windows-linux-validation.md`: the released
Windows zip and Linux AppImage each need one real run (pair with a phone, host a
server through phone unlock to a green padlock, burn a USB and boot it on
metal), plus the Debian 13.7.0 check. Record results under "Desktop Studio".

### Open work (owner + hardware)

1. **Debian 13.7.0 re-pin.** 13.6.0 still downloads from `cdimage/archive/`.
   Validate a 13.7.0 install first (Studio Advanced mode with a downloaded ISO,
   USB on metal), then update `FLAGSHIP_ISO_MANIFEST` + `_ARM64` in both
   wrangler files (gym has no `_ARM64` yet), `distros.ts`, `docs/iso-manifest.md`,
   the docs page + its test, and the phone-usb-burn seed pin.
   `iso-manifest-urls.yml` fails loudly the day a pin moves to `archive/`.
2. **Hosted-VM footprint (2026-10-10).** Mac Studio now hosts on the published
   prebuilt appliance by default: it downloads, verifies and expands the qcow2
   natively (`ApplianceCache` + `Qcow2Expander`, no qemu-img), APFS-clones it per
   server, and falls back to the Debian installer only when no image fits.
   Boxes install/build only the daemon (`--workspace=packages/server-daemon`,
   `tsc -b packages/server-daemon`; box `node_modules` 182 → 113 MB). Hosts with
   ≤16 GiB RAM give a VM 4 GiB, not 6 (all three cores + vectors). Unused cached
   ISOs are pruned after 30 days (Mac + Linux). **Validated live on this Mac
   2026-10-10** (`home2.plucky-avocet`, iPhone dev build + signed Studio):
   create → specialized and resealed in ~45 s → phone unlock → Let's Encrypt
   cert + HTTPS 200 about 2.5 min after creation. The first attempt exposed that
   both appliance seed builders (Swift + Node CLI) seeded the raw recipe instead
   of install-blob.json, so the guest bootstrap read nulls and stopped silently;
   fixed via the engine's `buildInstallBlobJsonFromRecipe`, and the specializer
   now reports each stage and any failure to the install timeline. Remaining:
   publish the CI rebuilds of both arches (they bake the code of their build
   day, so rebuild when `main` moves meaningfully); Linux/Windows still host via
   the installer ISO by default.
3. **Hetzner:** account suspended; five orphaned servers to delete by hand when
   it unlocks (153213447, 153638469, 153643080, 153813669, 155315594).
4. **Minimum-OS review** (Conventions rule): Mac Studio is macOS 14, Android is
   `minSdk 28`. Decide for the next releases.
5. **Restricted-device profile-key delivery is unimplemented.** The server
   stores and authorizes `accountDirectoryKeyGrant`s, but no client seals or
   unseals `sealedKeyHex`. Mirror the `AcmeAccountKeyGrant` envelope with
   TS/Swift/Kotlin parity, golden vectors and negative tests.
6. **Native UI tests** for account/device rename, managed override, lock/unlock
   were deleted in the private-naming cutover and never replaced.
7. **Recovery Phase B re-pair** needs a real-device check (rotated key ⇒
   re-pair with grace; unrotated ⇒ instant pair). iOS jetsam crash after ~14 min
   and the "I already have an account" input delay are undiagnosed.
8. **Marketplace security scanner** (`scan_grade` ships NULL) gates a public
   marketplace.
9. **In-house AI inference** (build-modes follow-on): flip the `LlmHarness`
   `baseUrlGuard` when we host a model.
10. **iOS 1.1:** hinge-aligned list/detail on the open iPhone Duo (confirm how
    iOS 27 reports hinge geometry first); the closed-fold return to portrait is
    unverified.
11. **Static-asset content-hashing:** the site flashes unstyled mid-deploy.
    Content-hash filenames and serve them immutable, or at least 404 `.css`/`.js`
    instead of the SPA fallback (`apps/com/src/route.ts`).
12. **Netboot path** (`parse-trailer.sh`) verifies v2 blobs but nothing ships it.
13. **Relay-trust enforcement is OFF** (`FLAGSHIP_RELAY_TRUST_ENFORCE`). Before
    flipping it on a canary, do `docs/maintainer-trust-enforcement.md`
    live-validation steps 7–9 (dedicated hub credential, persisted blessing,
    re-verify on expiry).
14. **VM boot observability:** the wired initramfs unlock log isn't persisted to
    the FLAGSHIP_BOOT partition (the Wi-Fi path's is), and the "taking longer
    than expected" stalled-boot advisory exists on Mac only, not Linux/Windows.
15. **Obsolete plaintext display-name fixtures** remain in some active tests.

### Feature branches (each = `main` + one feature; rebase when `main` moves)

- **`feat/marketplace`** (+ Pro payments, vouchers). **`feat/custom-names`**
  (dibs + paid name change; off marketplace): server side built; remaining are
  renaming an account that has servers, the client flow on all three apps, a
  live D1 run, and owner config (`DIBS_WINDOW_START/END`, $10/$20 vouchers,
  exempt `/dibs` from the coming-soon gate). Migrations 0092–0094 live there.
- **`feat/custom-domains`** (off marketplace): Pro gate built. `main` refuses new
  orders with "Custom domains aren't available yet"; keep the branch's Pro
  wording at launch. Remaining: live e2e, Stripe price ids.
- **`feat/free-tier-throttle`:** 256 kbit/s over quota instead of a hard stop;
  needs a `.services` deploy once merged.
- **`feat/lan-direct`:** needs a metal box and a dev-built phone on one Wi-Fi
  (Studio VMs are NAT), a recipe whose `installerGitRef` is the branch (phones
  always sign `main`), and `NSLocalNetworkUsageDescription` on iOS.
- **`feat/phone-usb-burn`:** validate the OTG write on a real phone + stick,
  publish the seed and set `FLAGSHIP_ISO_SEED`.
- **`feat/retail`** (NFC box), **`feat/browser-extension`**, **`alpine`** (parked
  installer), **`gym`** (test harness; run its live account-recovery spec).

### Pricing decisions (owner, 2026-10-09)

Free 25 GB; Pro $10/mo (250 GB, 1 custom domain); Pro Max $20/mo (500 GB,
unlimited domains); overage $0.05/GB; name change $10; dibs claim $20 (`.com`
holders only, one year from October 2026). Quotas are live on `main`; nothing
is purchasable yet. Detail: `docs/naming-recovery-and-name-change.md` §16,
`docs/monetization-free-tier-first.md`.

### GA close-out (do NOT do in dev)

1. Guard or remove the prod-wipe script (`scripts/wipe-all-users*`); keep its
   table list in step with migrations until then.
2. Remove the burn-time LUKS passphrase
   (`flagship-build-time-luks-rekey-me-immediately`) and re-enable the
   `luksRemoveKey` guard. `release-guard.sh` stays red on release tags until then.
3. Remove the demo/dev flips (demo mode, any remaining hidden toggles).
4. Fill the `pro.html` payment placeholders (on `feat/marketplace`).
5. Remove `DEV_LATE_LOG` / W12 debug endpoints in `controlPlaneRoutes.ts`.
6. Quiet the box console: diagnose `journalctl -b -p warning` on a real box
   first, fix real warnings at the source, then add `quiet loglevel=3`.
- Grant-gated debug SSH ships in v1 by owner decision; `debugAccessGate.ts` is
  its only sanctioned home and the release guard enforces that.

### Environment traps

- `apps/com`: `npm run deploy` rebuilds the bundled packages from an empty
  `dist/` and runs the predeploy gates; never call `wrangler deploy` directly.
- Build and deploy only from a worktree with its own `node_modules`; a symlinked
  one silently compiles another branch's sources.
- iOS: the `Flagship` scheme is a SwiftPM library (empty archive). Build the app
  from `apps/mobile/ios/App/FlagshipApp.xcodeproj`, scheme `FlagshipApp`, with a
  `-destination` and no `-sdk`. Xcode 27.1 RC lives at
  `/Applications/Xcode-27.1.0-Release.Candidate.app` (`DEVELOPER_DIR`).
- Android: Gradle needs `JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`.
- This Mac's disk is tight; clear DerivedData and simulator data before big builds.
- `.services` Fly deploys with `--strategy=immediate` drop every box's tunnel for
  ~20 s; that's expected, not a regression.

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
