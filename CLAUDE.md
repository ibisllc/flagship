# Flagship — orientation for Claude Code

Personal-cloud ecosystem. The phone is the trust root; users run their own server on commodity hardware at home; **TLS terminates on the user's box** so flagship.services literally cannot read user content. Verified end-to-end in production with a real green padlock as of 2026-05-05.

**This file is the single in-repo source of truth for current status and open work** — see "Current status & open work" at the bottom; update that section as work lands rather than starting new `docs/*handoff*.md` files. If you have access to agent memory, `project_overview.md` is a deeper architectural briefing (`final_architecture_2026_05_05.md` has the gory detail). Dated session handoffs and completed launch trackers are frozen in `docs/archive/` (history only).

## What's where

```
apps/com/                  Cloudflare Worker — flagshipserver.com (identity + state) + web.flagshipserver.com (webapp host-rewrite)
apps/web/                  Fly app — flagship.services (stateless data plane) + the webapp static surface
apps/web/public/           Static assets served by the Worker's [assets] binding
   ready/                  /ready/ — after an order: copy/download the recipe + get the burner (replaced the old /build/ paste-a-code page; /build/iso/ stays as the R2 ISO-stream backend)
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
- `https://flagshipserver.com/ready/` — after an order: copy/download the recipe + get the burner
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
cd apps/com && npx wrangler deploy              # Worker
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

- **No `Co-Authored-By: Claude` trailer on commits** — user preference.
- BUSL-1.1 license. Change Date 2030-05-03 → Apache 2.0.
- Imperative commit subjects. Body explains *why*, not *what*.
- TypeScript ESM, strict mode, `noUncheckedIndexedAccess`.
- Tests live next to packages: `packages/<pkg>/tests/`.
- Canonical-bytes use `|` separator and `flagship/<purpose>/v1` tag prefix.
- No comments unless the *why* is non-obvious; never explain *what*.

## Current status & open work

> **This section is the single source of truth.** Update it as work lands —
> don't spawn new `docs/*handoff*.md` files. Dated handoffs + completed launch
> trackers are frozen in `docs/archive/`. Last updated **2026-06-05**.

### Live in production
- **Per-user TLS** — one Let's Encrypt cert per user, SANs `[<user>, *.<user>]`, real green padlock (per-box → per-user cutover verified live 2026-06-02). ACME runs on the user's daemon over SNI passthrough; `.services` stays content-blind. Wildcard SANs via DNS-01.
- Auto-unlock-lease (one-shot + long-lived) with silent renewer; WebAuthn-PRF cloud recovery; Web Push (RFC 8291 encrypted payloads); `/consume` → push.
- **Cert model** (iOS + web + Android): creation is a binary — *managed* (your devices renew it, default) vs *autonomous* (the box self-renews); renewal window is an account-wide "Certificate validity" setting (presets 7/30/90, default 30).
- **Recovery Phase B backend** deployed — single-device re-pair grace 7d→3d; the wrapped-UMK fetch returns `registeredIrkPubHex` for rotation detection.
- Brand/teal migration complete (rounded-square-containing-a-circle mark; the flag-on-mast pennant is **retired — do not reintroduce**). `/og` social card, `/ready` page, webapp no-server empty states, iOS Apps→Services rename + persistent pending servers.
- **All prod users wiped 2026-06-02** for a clean pre-release slate (`marketplace_listings` preserved).

Gates (2026-06-03): web 978 · com+control-plane 1108 · iOS 755 XCTests · `npx tsc -b` clean. `npx vitest run` ~30s. Workspace deps: `npm install` + `npx tsc -b`.

### Open work

**Hardware / boot — the active thread (needs real metal):**
1. **Alpine bare-metal boot.** The ISO-builder UEFI fix is DONE + locally proven (`scripts/build-flagship-iso.sh` now emits a true BIOS+UEFI hybrid via `xorriso … -boot_image any replay`; the old build silently dropped Alpine's UEFI entry). But on the test box Alpine's initramfs USB stack doesn't come up ("mounting boot media failed" → emergency shell). Next (blind-iterable): rebuild adding `xhci_pci`/`xhci_hcd`/`uas` to the boot cmdline, re-burn, observe how far it gets.
2. **Ship the Alpine UEFI fix** — re-run the reproducible-build CI → rebuild ISO → upload to R2 as `flagship-alpine-base.iso` → bump the burner's `BaseIsoCache.version` + `sha256Hex` → rebuild + reinstall the signed Mac burner. Until this lands, `POST /api/personalize-iso` 503s and the Alpine "Recommended" path is unavailable.
3. **Debian-preseed is the working path today** — it boots, autoinstalls, reaches `flagship-pod login:`. The burner "Quick" mode still points at the dead Alpine path (`BurnerMode.swift`) — repoint Quick to Debian-preseed until Alpine boots. `/ready` copy still frames Alpine as recommended — stale, update.
4. **Verify Debian-preseed reliability** — cmdline injection (`Remaster.swift` grub/isolinux patch) was per-ISO flaky earlier; confirm a burned box registers + gets a cert.

*Pending design calls (home, no hardware): Alpine-vs-Debian shipping default; burner UX (make Debian the recommended path); personalized-ISO trailer vs the isohybrid backup-GPT (`sgdisk -e` relocate vs in-ISO recipe file).*

**App / recovery:**
5. **Recovery Phase B re-pair branch (iOS, on-device validation).** Wire `recoveredKeyMatchesRegistered` into post-recovery completion: recovered IRK == registered → instant pair (Phase A); != → re-pair with `oldIrkPub = registeredIrkPubHex` + 3d grace; `KeyfileImportViewModel` instant skip-grace. Backend already deployed.
6. **iOS owner-device confirmations** (from 2026-06-02, never confirmed on device): cross-device-QR recovery fix (`f4593a3`); Passwords-app icon flips to the teal ring; a real burn → box registers → green padlock.
7. **iOS diagnostics:** jetsam memory crash after ~14 min (use the Memory Graph Debugger; note which screen grows); input-field delay on "I already have an account" (confirm with a Release/Profile build).

**Ship / launch (owner-side, mostly):**
8. **Stores.** iOS TestFlight (Associated Domains capability, Xcode Archive + ASC upload, metadata, 5 external testers); Android Play (signed AAB via `./gradlew :app:bundleRelease`, internal track, 5 testers). Neither app is on a store yet, so push / Live-Activity timelines can't be received on a real device.
9. **Marketplace security scanner** — `marketplace_listings.scan_grade` ships NULL; needs the Trivy + custom-checks service that posts grade + R2 report. MVP gate before public marketplace.
10. **v1-alpha live exercises** (multi-day, observational): recovery / rotation / update-pack over 7 days × 2 pods; peer-backup at scale; marketplace MVP; public disclosure + bounty path.

**NFC retail tier (post-v1; design in `docs/v1-operational-tasks.md § N`):** protocol + daemon state machine + cloud activation API are built & partly live; **C3 — iOS + Android NFC read flow** is the remaining agent-doable chunk. Hardware bring-up waits on the hardware-shipping business decision.

### When in doubt
This file is the in-repo source of truth. For deeper detail, read the relevant living spec in `docs/` (index below), the operational runbooks in `docs/runbooks/`, or — for architecture — `project_overview.md` in agent memory. `docs/archive/` is frozen history.

### Living design specs (index)
- **Cert & addressing** — `per-user-cert-and-addressing.md`, `per-user-cert-worklist.md`, `multiplexing.md`
- **Recovery / multi-device / security** — `multi-device.md`, `lifecycle-spec.md`, `security-phone-as-unlock-endpoint.md`, `v1.2-security-cascade.md`, `revocation-ui.md`, `wipe-restart.md`, `watch-delegate-key-design.md`, `v2-device-addressing-and-real-ticket.md`
- **Login / accounts / demo** — `login-and-account-redesign.md`, `sample-users.md`
- **Install / ISO / burner** — `recipe-schema-v2.md`, `installer-tiny.md`, `installer-netboot.md`, `cloud-init-direct-provisioning.md`, `installation-real-usb.md`, `reproducible-iso-build.md`
- **NFC retail box** — `nfc-box-pairing.md`, `v1-operational-tasks.md § N`, `n-cloud-2-design-discussion.md`
- **CA / maintainers** — `ca-operations.md`, `maintainer-ca-endorsement.md`, `maintainers-checkpoints-spec-v0.1.md`, `maintainers-deployment.md`
- **Marketplace / apps / monetization** — `app-developer-guide.md`, `manifest.md`, `monetization-free-tier-first.md`, `multi-device-monetization.md`, `vibe-code-experience.md`
- **Testing** — `e2e-test-plan.md`
- **Design / ops** — `design-system.md`, `psl-submission-flagship-services.md`, `runbooks/`, `policy/`
