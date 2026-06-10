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
- **Unlaunched features live entirely on their own branch; `main` ships clean.**
  Every not-yet-launched feature — site literature, app code (iOS/Android/
  webapp), backend logic, AND tests — lives ONLY on its feature branch, so
  `main` "doesn't think of" it at all. Current branches: **`feat/marketplace`**
  (the marketplace) and **`feat/retail`** (getting the app working with
  retail / NFC boxes). **No marketplace/retail code may sit on `main` until
  that feature launches** — branching IS the gate, there is NO gating/flag code
  in `main`.
  - **`alpine` is a *parked* branch, not a feature-to-launch.** It holds the
    full Alpine bare-metal installer path (ISO builder + apkovl + installer-tiny
    + the burner Quick/trailer flow + `/api/personalize-iso`) that `main` shed
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
> trackers are frozen in `docs/archive/`. Last updated **2026-06-08**.

### Live in production
- **Per-user TLS** — one Let's Encrypt cert per user, SANs `[<user>, *.<user>]`, real green padlock (per-box → per-user cutover verified live 2026-06-02). ACME runs on the user's daemon over SNI passthrough; `.services` stays content-blind. Wildcard SANs via DNS-01.
- Auto-unlock-lease (one-shot + long-lived) with silent renewer; WebAuthn-PRF cloud recovery; Web Push (RFC 8291 encrypted payloads); `/consume` → push.
- **Cert model** (iOS + web + Android): creation is a binary — *managed* (your devices renew it, default) vs *autonomous* (the box self-renews); renewal window is an account-wide "Certificate validity" setting (presets 7/30/90, default 30).
- **Recovery Phase B backend** deployed — single-device re-pair grace 7d→3d; the wrapped-UMK fetch returns `registeredIrkPubHex` for rotation detection.
- Brand/teal migration complete (rounded-square-containing-a-circle mark; the flag-on-mast pennant is **retired — do not reintroduce**). `/og` social card, `/ready` page, webapp no-server empty states, iOS Apps→Services rename + persistent pending servers.
- **All prod users wiped 2026-06-02** for a clean pre-release slate (`marketplace_listings` preserved).

Gates (2026-06-03): web 978 · com+control-plane 1108 · iOS 755 XCTests · `npx tsc -b` clean. `npx vitest run` ~30s. Workspace deps: `npm install` + `npx tsc -b`.

### Open work

**Hardware / boot — Debian-only now; getting a box to boot is the gate:**
> **Decision (2026-06-08): Debian is the sole shipping path; Alpine is parked on the `alpine` branch.** Alpine's initramfs wouldn't enumerate USB on real metal ("mounting boot media failed"), and the fix was hardware-iteration-gated + speculative; Debian-installer already solves the hard UEFI-NVRAM-rejection problem and its whole downstream (bootstrap, boot-stage, LUKS, systemd, register) is shared + Debian-ready. `main` is Alpine-free + green.
>
> **DONE (agent, 2026-06-08) — the Debian-quick + manifest + phone-home plan all landed on `main`:**
> - ✅ **`POST /api/iso-manifest`** — server-driven base-ISO manifest (dumb-executor burner; `{download:{url,sha256,version,sizeBytes,attestation}}` or `{download:null}`; blessed manifest in Worker env `FLAGSHIP_ISO_MANIFEST` = the hold/fast-track lever). Spec: `docs/iso-manifest.md`.
> - ✅ **Burner Simple mode** (mac/linux/windows) — manifest-driven Debian base cache: downloads + sha-verifies when ordered, shows the URL under the progress bar, logs path+sha on every launch + after each download; remasters via the shared preseed path. Advanced (user ISO) stays. (mac swift 90 · linux pytest 88 · windows via its own CI.)
> - ✅ **Website simplified** — one story: mint recipe → copy/download on `/ready` → get the burner → it fetches the OS itself. All user-facing Alpine/ISO-pick/Advanced-mode framing gone.
> - ✅ **Earliest phone-home** — best-effort beacons in the burner preseed (TS + Swift, byte-identical, injection-sanitized): Beacon A in `preseed/early_command` (`d-i-started`, busybox-wget, pre-network `|| true`) + Beacon B at top of `late_command` (`installer-running`) → existing `POST /api/install-events/<serial>` (the channel the phone watches).
> - ✅ **Wipe script re-audited** through migration 0046 (`scripts/wipe-all-users-prerelease-2026-06-02.sql`): dropped stale `build_tickets`, added `acme_account_key_delivery` + `nfc_rendezvous`.
>
> Gates on `main`: `tsc -b` clean · vitest **4379** · iOS **728** + App build · Android · burner-mac swift **90** · burner-linux pytest **88**.

**Wi-Fi unlock + no-LUKS escape hatch — DONE (agent, 2026-06-08):**
> A Wi-Fi-only box installed + sealed fine but **hung at the early-boot LUKS
> unlock on every reboot**: the initramfs unlock premount curls the boot relay
> assuming the network is up (true on Ethernet's auto-DHCP, false on Wi-Fi where
> the early-boot env brings up no radio). Two landed fixes, both with byte-identical
> TS↔Swift generators (sha-pinned) + green gates (vitest 4406 · iOS 728→738 ·
> Android 583 · burner swift 104 · tsc clean):
> - ✅ **Wi-Fi in the initramfs** (`b1dd738`): a build-time hook stages the box's
>   actual `wl*` driver + firmware + `wpa_supplicant`; a boot-time `init-premount`
>   (runs strictly before `local-top/flagship-unlock`) associates + DHCPs, fully
>   best-effort + wall-clock bounded so it can never hang boot. Only on the
>   encrypted Wi-Fi path; wired burns byte-identical. **Also keeps the burn-time
>   LUKS passphrase as a bring-up recovery slot** (`luksRemoveKey` guarded off, not
>   deleted) — a KNOWN CONSTANT; flip the guard back on before GA.
> - ✅ **No-LUKS server option** (`dad6bf0`+`f4231a2`): phone-signed
>   `InstallBlob.diskEncryption` ("luks"|"none"), appended last in canonical bytes
>   as `de=<mode>` (absent ⇒ encrypted; a relay can't downgrade luks→none without
>   breaking the sig). Toggle in every create-server flow (iOS/Android/webapp +
>   demo/dev mint), default ON; OFF provisions an unencrypted box that boots
>   without needing network at unlock. Help entry added for "stuck at installed".
> - ✅ **Install checklist** (`d92e1ea`): dropped the redundant `installed` rung
>   (it spun while the box was powered off); Installing now goes green + carries
>   "unplug the USB" detail. `installed` stays a wire phase + push milestone.
>
> Owner-side next: rebuild+re-sign the Mac burner (below), then a live Wi-Fi
> reburn to confirm the initramfs radio actually associates + DHCPs before the
> unlock relay (the static tests prove the script text, not the kernel/net path).

**Remaining to a live box (owner + hardware):**
1. **Deploy to activate the manifest.** `FLAGSHIP_ISO_MANIFEST` is already seeded in `apps/com/wrangler.toml` [vars] (Debian 13.5.0 netinst, version-pinned cdimage url, official signed sha, size 791 674 880; verified live 2026-06-08) — so just `cd apps/com && npx wrangler deploy` turns Simple-mode downloads on. (To serve from our own R2 instead of Debian's CDN, upload the same bytes and change only the `url` field — sha is unchanged. Re-pin all three on a new Debian point release.)
2. **Rebuild + re-sign the Mac burner** (it now ships Simple-as-default + the manifest client).
3. **Run the wipe** — `bash scripts/wipe-all-users.sh` (NOT the raw `--file` .sql: prod D1 drifts from the repo's migrations, and a one-transaction `--file` run aborts on the first table prod lacks; the runner deletes each table independently and skips absent ones).
4. **Verify Debian-preseed reliability + live e2e** — cmdline injection (`Remaster.swift`/`remasterIso.ts` grub+isolinux patch) was per-ISO flaky earlier; add real-Debian-ISO tests, then create-account → recipe → burn → boot → watch the phone-home timeline → registers → green padlock.

**Install / provisioning polish (agent-doable, off the critical path):**
- **Beacon the partitioning→installing transition.** During the Debian
  base-system install (the multi-minute `debootstrap`/apt phase) the phone
  checklist sits on "partitioning" with no ping — d-i has no *command*-level
  preseed hook in that window (`partman/early_command` is before partitioning,
  `preseed/late_command` is after the base install). The fix: from
  `partman/early_command` (which already runs + already sends the "partitioning"
  beacon, so network + the auth-code serial are in scope), drop a small
  executable into **`/usr/lib/base-installer.d/`** that POSTs `phase:"installing"`
  to `/api/order/<serial>/status`. base-installer runs it right after
  partitioning, filling the gap. MUST be bulletproof — backgrounded, `wget -T`
  timeout, `|| true`, `exit 0` — so it can NEVER block or fail base-installer.
  Add to BOTH generators (`packages/flagship-burner/src/preseed.ts` +
  `apps/burner-mac/.../UserData.swift`), byte-identical. NOT locally testable
  (no d-i dry-run) → validate on a real burn, NOT bundled into a critical
  encrypted-unlock test burn. (Cosmetic: the install completes fine without it;
  the metal screen shows real progress — it is a lag, not a hang.)

**App / recovery:**
5. **Recovery Phase B re-pair branch (iOS, on-device validation).** Wire `recoveredKeyMatchesRegistered` into post-recovery completion: recovered IRK == registered → instant pair (Phase A); != → re-pair with `oldIrkPub = registeredIrkPubHex` + 3d grace; `KeyfileImportViewModel` instant skip-grace. Backend already deployed.
6. **iOS owner-device confirmations** (from 2026-06-02, never confirmed on device): cross-device-QR recovery fix (`f4593a3`); Passwords-app icon flips to the teal ring; a real burn → box registers → green padlock.
7. **iOS diagnostics:** jetsam memory crash after ~14 min (use the Memory Graph Debugger; note which screen grows); input-field delay on "I already have an account" (confirm with a Release/Profile build).

**Ship / launch (owner-side, mostly):**
8. **Stores.** iOS TestFlight (Associated Domains capability, Xcode Archive + ASC upload, metadata, 5 external testers); Android Play (signed AAB via `./gradlew :app:bundleRelease`, internal track, 5 testers). Neither app is on a store yet, so push / Live-Activity timelines can't be received on a real device.
9. **Marketplace security scanner** — `marketplace_listings.scan_grade` ships NULL; needs the Trivy + custom-checks service that posts grade + R2 report. MVP gate before public marketplace.
10. **v1-alpha live exercises** (multi-day, observational): recovery / rotation / update-pack over 7 days × 2 pods; peer-backup at scale; marketplace MVP; public disclosure + bounty path.
11. **Disarm the mass-wipe before real users.** `scripts/wipe-all-users-prerelease-2026-06-02.sql` is a single idempotent file that deletes every user + server. Fine for the pre-release slate, a footgun once we serve real accounts. Before GA: gate it (per-env confirmation token, prod row-count safety/dry-run, audit-logged admin-only path) or remove the blanket script from the deployable surface so no one can nuke prod in one command. Keep the wipe script's table list in sync with new migrations until then.

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
