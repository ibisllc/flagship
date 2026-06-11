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
npx tsc -b && (cd apps/com && npx wrangler deploy)   # Worker — tsc -b FIRST: it bundles the BUILT control-plane dist/, so a deploy without a rebuild silently ships stale handler logic
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
> trackers are frozen in `docs/archive/`. Last updated **2026-06-10**.

### 2026-06-10 (late) — CERT-MODEL MIGRATION C → A′ EXECUTED IN CODE

**⭐ The entire cert-model migration is implemented on `main` and gated** (15
commits; vitest 4608 · iOS full suite green · Android 669 · burner-mac 109 ·
`npx tsc -b` clean). `docs/cert-model-A-prime-migration.md` header lists what
remains. What landed:
- **Phase 1 (per-box wildcard):** the daemon mints `[<server>.<user>, *.<server>.<user>]`
  (`boxCertSans`, SANs re-derived at startup ⇒ model-C certs auto-discard +
  re-mint on first boot); `.com` registration publishes the per-box A/AAAA pair;
  DNS-01 (`dns01.ts` AND the dns-broker policy) accept a box's challenges ONLY at
  its own subdomain; CAA stays at the user zone (RFC 8659 tree-climb covers
  everything below); CT monitoring (both monitors) flags any cert whose SAN set
  doesn't fit exactly ONE registered box's pair — incl. the retired per-user shape.
- **Phase 2 (`--` revert):** pin operator deleted (hierarchy replaces it);
  tier-1 canonical `https://<label>.<server>.<user>` is the share/copy/open URL on
  iOS + Android + webapp (clients use the daemon-provided AppSummary.url, not
  local derivation); mocks mirror the live shape. Tier-2 `<label>.<user>` kept
  ONLY where genuinely leader-routed. Bonus bug fix: app-backup `resolveSource`
  composed `<creator>--<slug>` and never matched (8a00e3b).
- **Phase 3 (voi.ci):** no change needed — targets already mint from the tier-1
  canonical.
- **Phase 4 (pinning):** `/pods` relays the VERBATIM STK-signed daemon-status
  (`signedStatus`, migration **0048**); `verifyDaemonStatusReport` in
  @flagship/protocol + byte-identical Swift/Kotlin mirrors (pinned cross-platform
  vector). iOS (URLSession delegate) + Android (hostname-verifier + interceptor —
  the verifier stage covers WebSockets, which OkHttp interceptors skip) HARD-FAIL
  when a verified pin mismatches; fail-open only when no pin exists. STK pubs
  derive LOCALLY (.com's echo is not a trust input); demo/mock can't install pins.
- **Phase 5 (tier-2 shared service certs):** ServiceCertAuthority (IRK, ≤1h) +
  mint/export/install envelopes; the authorized box mints `[<service>.<user>]`
  via its own ACME with the authority forwarded on DNS-01; key distribution is
  phone-driven over each box's pinned canonical pipe (`POST /api/service-certs/
  {mint,export,install}` on the daemon); certManager serves it on exact SNI;
  rehydrates on restart. Renewal = phone re-mints (deliberate v1).
- **Hub hardening (came out of the routing audit):** routing never used wildcard
  claims (the one-label SNI strip IS the per-box wildcard, and the old `*.<user>`
  claim was inert) — but nothing REFUSED foreign wildcards; now the hub nacks any
  wildcard claim except a box's own `*.<podCanonical>`, the allocator drops `*`
  canonicals, findBySni refuses `*` SNIs.

**Deploy set for this migration (owner, do together):** `npx tsc -b && cd apps/com
&& npx wrangler deploy` · apply migrations **0047_ct_alerts.sql + 0048_daemon_
status_signed.sql** to prod D1 (0048 BEFORE the Worker deploy — the new D1 write
path needs the columns) · wire `CloudflareDnsClient` as the CAA client · rebuild
+ re-sign the Mac burner · rebuild the iOS app · wipe + fresh burn → the full
post-cert-rebuild hardware test list in the migration doc.

**Open follow-ups from the migration:** tier-2 mint/install client UX (phone
orchestration of the new daemon endpoints — protocol + endpoints are done);
phone-side reminder before a shared service cert expires; custom-domain CNAME
target says `<user>.flagship.services` whose A record per-box DNS no longer
publishes (weigh with tier-2/custom-domain work); webapp cannot pin (browser
constraint — CAA + CT are its backstop).

### 2026-06-10 session — ENCRYPTED BOX e2e PROVEN ON METAL + cert-model plan

**⭐ MILESTONE: the encrypted-box end-to-end works on real hardware.** After a long
debug chain, a real encrypted box (`abc5.harry1.flagship.services`) reached a genuine
**Let's Encrypt green padlock** (issuer CN=YR1, per-user cert `[harry1, *.harry1]`),
serving content, `.services` content-blind. The #27 saga's entire downstream is
validated. (The unlock was MANUAL via the `manual` keyword + recovery passphrase — the
PHONE-approval unlock still needs a fresh end-to-end run, see TODO.)

**~~NEXT SESSION = EXECUTE THE CERT-MODEL MIGRATION~~ — DONE, see the block
above.** Full detailed plan in
`docs/cert-model-A-prime-migration.md` (all decisions LOCKED). Headline: move off the
current model **C** (per-box key + per-user wildcard `*.<user>`, each box re-mints →
hits LE's duplicate-cert limit at >5 boxes + forced the `--` name hack) to **A′**:
- **A′ = per-box wildcard** `[<server>.<user>, *.<server>.<user>]` — box-local key,
  never shared, distinct per box (no duplicate-limit), covers `<service>.<server>.<user>`.
- **Revert `--`** flattening → hierarchical `<service>.<server>.<user>`.
- **Three trust tiers** (the share-URL encodes the assurance): canonical
  `<service>.<server>.<user>` (security+hardware, pinned) · `<service>.<user>` (security,
  hardware-agnostic, leader-routed — the EXISTING multi-server mechanism, KEPT) ·
  `voi.ci/<blurb>` (convenience redirector, visible 302, trust-us).
- **Canonical long-form HTTPS = the root primitive** — incl. delivering a tier-2
  `<service>.<user>` key to a box over its own pinned pipe (phone→box direct, NOT `.com`).
- **voi.ci stays a path redirector** (no per-service certs, no voi.ci LE exposure).
- **Cert-fingerprint pinning** (hard-fail) off the STK-signed daemon-status fingerprint
  — the real defense against a `.com` rogue cert.
- **PSL** for flagship.services: file once there are real users (per LE).
- The post-cert-rebuild **test TODO** lives at the bottom of that doc (the rebuild
  touches names/certs/DNS/routing/all clients → full validation pass follows).

**What landed this session (all committed + pushed; `main` green, tree clean):**
- **Boot-unlock brought up on metal** — initramfs Wi-Fi (op-mode module staging, DNS
  resolv.conf+NSS, CA bundle, wired DHCP) `7db385a`/`de10869`/`c2617a9`/`8101e6b`;
  Beacon E `installing`; **wait-forever for phone + `manual` keyword override + mailbox
  heartbeat** `964cd88`; boot worker fixes — **service binding to the identity plane**
  `d17ae01` (same-zone Worker→Worker fetch was returning HTML), **fetch `this`-binding
  1101 fix** `242ab68`, no-store directory reads `76aa05e`.
- **#52 sign-out gate** `8f9c9c0` · **/pods serial→orderRef** `aa78e2b` · **iOS
  install-progress** `48a4b9e` · **decommission failed servers (free the name)**
  `240ac3e` + dead-server status `e4b38e5` · **3-state liveness (waiting/coming-online/
  dead)** `56910d1` · **monotonic install checklist (phase order)** `97f63c5` ·
  **liveness bridge (live box reads online) + daemon-status heartbeat** `41a039a` ·
  Dock progress contrast `73cf35f`.
- **Cert-security (committed, NOT deployed — deploy WITH the cert rebuild):** CAA
  CA-restriction publishing `ca29a0b`; CT-log rogue-cert monitor (6h cron, owner
  push) `1f8086e`.
- **Notify pipe FIXED (root cause of "no phone permission ever"):** the boot→`.com`
  notify shared secret was mismatched (silent 401) → re-synced `NOTIFY_SHARED_SECRET`
  (boot) and `BOOT_NOTIFY_SECRET` (.com) to one value. (No commit — secret rotation.)
- Security tracking added to the pre-GA list `b52762f` (/pods enumeration; CAA+CT;
  daemon reporting).

**OWNER-SIDE (carry into next session):** rebuild the iOS app (push token + all the
UX); deploy `.com` + apply migration `0047_ct_alerts.sql` + wire `CloudflareDnsClient`
as the CAA client (do this WITH the cert rebuild); rebuild+re-sign the Mac burner after
the A′ daemon change; then the phone-approval unlock e2e.

Gates (2026-06-10): `npx vitest run` 4517 (351 files) · iOS 824 · Android 620 · burner
175 TS + 105 swift · webapp green · `npx tsc -b` clean.

### 2026-06-09 session — what landed + the live encrypted-unlock failure

**NEXT SESSION — FIRST MOVES (in order):**
1. **Deploy the Worker** — `npx tsc -b && cd apps/com && npx wrangler deploy`. One deploy ships three things: the `/pods` orderRef hardening (`aa78e2b`), and (already-seeded) `FLAGSHIP_ISO_MANIFEST` Simple-mode downloads.
2. `bash scripts/wipe-all-users.sh` (clean slate).
3. Rebuild the iOS app in Xcode — `main` has the consolidated server list (#56), orderRef reconciliation, the #52 sign-out gate, the three-tier session model (#46), and the keychain self-heal.
4. **Rebuild + re-sign the Mac burner** — it is NO LONGER current: `main` now carries the 2026-06-09 initramfs Wi-Fi hardening + the `installing` beacon (`7db385a`); a reburn from the old binary would re-test the broken hook.
5. **Encrypted Wi-Fi e2e (#27) — the ONE piece the project still has to prove.** Create a fresh account → **enroll Cloud Recovery FIRST** (sign-out is now BLOCKED without it, #52) → create a server with **Encrypt disk ON** (default) → burn with the rebuilt burner → boot → unplug USB → power on → watch LUKS-unlock-over-Wi-Fi. If it still fails: console-login as `debug` / `flagship`, read **`/boot/flagship-wifi-build.log`** (NEW — stage-by-stage build-time staging log: interface/driver/firmware/binaries, each OK or MISSING) + `/boot/flagship-wifi.log` (an empty one now means "premount never ran", nothing else).

**2026-06-09 evening sweep (agent) — four task closures on `main`:**
- `7db385a` **#27 hardening + Beacon E** — see the updated LIVE FAILURE note below.
- `8f9c9c0` **#52 DONE** — Tier-2 sign-out is blocked without cloud recovery on iOS + Android + webapp (shared `SignOutPolicy`, enforced at the action layer that calls `Keystore.wipe()`, not just dialog copy; blocked dialog routes into recovery enrollment; demo/mock sessions exempt). The re-pair audit answered the open question: single-device re-pair-by-grace with a brand-new self-signed IRK is the **designed** takeover path (no credential to initiate, old key has no veto, only T+0/+1d/+3d alerts) — so blocking the no-recovery wipe is the correct fix. One loose end: the observed live rotation completed same-day, which the 3d grace shouldn't permit — check whether a stale pending re-pair row predated it.
- `aa78e2b` **/pods serial → orderRef** (details in the SECURITY list below).
- **Android #56 parity was already DONE** (`f0acd5d`, complete port + 6 pending-state tests) — the "in flight" note below was stale.
- **Recovery Phase B iOS re-pair branch (open-work item 5) is already fully wired + tested** — `registeredIrkPubHex` captured (RecoveryViewModel:184), `recoveredKeyMatchesRegistered` (:239), Phase A/B branch in `RealAccountLoginViewModel.startSingleDeviceTakeover()` (:250) calling `initiateRotatedRePair` with `oldIrkPub = registeredIrkPubHex`, KeyfileImportViewModel instant skip-grace. Only on-device validation remains.
- `48a4b9e` **iOS install-progress fixes from the live burn** (deploy+wipe+burner-rebuild had been run; a real encrypted Wi-Fi install was in flight and the backend phases were advancing — Beacon E `installing` CONFIRMED firing on metal): (1) the delivered page's hardcoded "Status: pending" → live ladder polling the per-order status; (2) the pod now upserts onto Home the moment the delivered page appears (was: only on "Done" — a watcher of that page never saw the server until pull-down); (3) a serial-less pod (surfaced from `/pods`, which ships only opaque orderRefs) sat forever on the empty "Booting up" ladder → the timeline VM gained a directory fallback (poll `/pods`, project `pending[].phase`, flip live on registration) and `upsertPendingPod` re-attaches the local serial to a serial-less twin. iOS 801 XCTests. **Parity follow-up (agent-doable): check Android for the same three behaviors** (instant surface at delivery; serial-less pending detail riding `pending[].phase`); webapp is unaffected (home renders pending straight from `/pods` and shows phase on the card). **Owner: rebuild the iOS app in Xcode to pick this up.**

**#27 LIVE FAILURE (2026-06-09):** an encrypted Wi-Fi-only box installed/sealed/registered fine but **failed to auto-unlock** — stuck at `Please unlock disk`, `curl (6) could not resolve host boot.flagshipserver.com` (NO network in the initramfs), Wi-Fi beacon empty (DHCP never succeeded). After a hand-unlock with the burn-time recovery passphrase the **full-OS daemon also didn't check in** (daemons=0) — so Wi-Fi isn't engaging on this box in EITHER context, despite #45. Everything downstream of unlock is PROVEN — the no-LUKS box reached a real Let's Encrypt green padlock (`*.harry.flagship.services`) on hardware.
**→ HARDENED (`7db385a`, agent audit, awaits a real reburn):** the build-time hook was confirmed able to silently no-op exactly as suspected — driver detection unvalidated (empty `wl*` lookup fed `manual_add_modules ""` behind `|| true`), Debian-13 `.xz`/`.zst` firmware variants never matched, and `wpa_cli` + `ip` (both used by the premount) never staged. Hook now validates every step + logs to `/boot/flagship-wifi-build.log`, stages firmware variants + dependency-module firmware + `cfg80211`/`mac80211`, copies `wpa_cli`/`ip`, falls back to `copy_modules_dir kernel/drivers/net/wireless`; premount logs before mounting, waits (bounded) for FLAGSHIP_BOOT, records the mount result; iface wait 15s→30s; the full-OS Wi-Fi safety-net unit dropped its `After=network.target` chicken-and-egg. TS↔Swift byte-identical, sha pins updated. The static tests prove the script text — the kernel/net path needs the live reburn (FIRST MOVES above).

**DEPLOY GOTCHA (cost real time this session):** `wrangler deploy` bundles apps/com's import of the BUILT `@flagship/control-plane` `dist/` — a control-plane change that isn't compiled silently ships stale. ALWAYS `npx tsc -b && cd apps/com && npx wrangler deploy`. (This is why the outstanding-orders endpoint "deployed" yet never worked.)

**App server-list — CONSOLIDATED (#56, LIVE):** one unauthenticated `GET /api/users/:u/pods` now returns registered `pods` (`state:"online"`) + active `pending` orders (`state:"pending"`, with `serial`/fqdn/phase) — **no more biometric Face ID on a list refresh**, and a just-created server appears instantly. Server `bae3537` (deployed via tsc -b + wrangler, verified `pending` key live), webapp `792a620`. Replaces the split-brain (registered `/pods` + biometric-signed `outstanding-orders` whose silent per-order `provision_status` failure swallowed the whole list) that caused the entire "server doesn't appear / Face ID on refresh" saga. iOS done; webapp done; Android done (`f0acd5d`). Wire note: `pending[].serial` was replaced by `orderRef` in `aa78e2b` (see SECURITY below) — deploy before judging client pending behavior against prod.

**SECURITY — pre-production cleanup (track to GA):**
- **Remove the `debug` user.** The burner now installs a sudo `debug` / `flagship` console user (a deliberate backdoor for bring-up — `flagship` is SSH-key-only, so on-box log reading was impossible; `/etc/issue` warns loudly). REMOVE before production.
- **#52 — DONE (`8f9c9c0`).** Tier-2 sign-out is blocked on all three surfaces when `hasCloudRecovery` is false (action-layer `SignOutPolicy` gate; blocked dialog routes to recovery enrollment; demo exempt). Audit verdict: the rotation rode the DESIGNED single-device re-pair-by-grace path (no credential to initiate, no old-key veto) — see the evening-sweep note above. Possible follow-up: require a credential on the single-device re-pair initiate, and check why the live rotation beat the 3d grace.
- **/pods serial exposure — HARDENED (`aa78e2b`, not yet deployed).** The unauthenticated `/pods` `pending[]` no longer carries the auth-code `serial` (a provision-status write capability); it ships an opaque `orderRef = hex(sha256("flagship/order-ref/v1|" + serial))` (`orderRefForSerial`, control-plane `podInventory.ts`; byte-identical mirrors in iOS `FlagshipCore.OrderRef` + Android `core.OrderRef`, pinned cross-platform vector). The creating device reconciles by hashing its locally-stored serial; a non-creating device reconciles by fqdn and shows list-level phase only (it never learns the serial, so no deep-progress poll / cancel-revoke there). All surfaces + tests updated in lockstep. Deploy needs the usual `npx tsc -b && cd apps/com && npx wrangler deploy`.
- Remove the **burn-time LUKS recovery passphrase** (`flagship-burn-time-luks-rekey-me-immediately`, a kept known constant) + disarm the mass-wipe (#35) — before GA.
- **/pods unauthenticated server-list enumeration (track to GA).** `GET /api/users/:u/pods` is unauthenticated (a deliberate #56 tradeoff to avoid a biometric Face ID on every list refresh, and because the boot worker's directory client reads it). It leaks METADATA to any knower-of-a-username: the user's server domains, identity pubkeys, registered timestamps, apps-served (NO secrets/keys/content; the serial is already opaque-`orderRef`'d). Pre-GA decision needed: require auth (re-introduces the refresh-biometric problem #56 solved), OR rate-limit + make usernames non-guessable, OR accept-with-rationale. Currently UNTRACKED-until-now.
- **CAA pinning + CT monitoring — SPEC'd, NOT deployed (track to GA).** Because `.com` controls the `flagship.services` DNS zone, it could in principle satisfy a DNS-01 challenge and mint a ROGUE per-user cert (it never sees the box's cert private key — that's generated + held box-local and never transmitted — but it controls the name). Defenses are designed in `docs/per-user-cert-and-addressing.md` (CAA pinned to the user's ACME account so LE refuses out-of-account issuance; CT monitoring on the phone to alert on any cert the owner didn't mint) but NOT implemented. Mitigating factor today: a cert is NOT the access-control primitive — routing authority (RCK/STK, phone-held) is, so a rogue cert can't redirect traffic. Deploy CAA+CT before GA.
- **Daemon liveness/cert reporting — DONE (2026-06-10 late).** The daemon sends the 5-minutely STK-signed daemon-status heartbeat (wired in server-daemon index); `/pods` now relays the VERBATIM signed report (`signedStatus`, migration 0048) so phones verify the cert fingerprint against the locally-derived STK and hard-fail-pin on it. The provision-status liveness bridge remains as the fallback for boxes that haven't reported yet.

Gates (2026-06-09 evening): `npx vitest run` 4465 (348 files) · iOS 793 XCTests · Android 611 · burner 175 (TS) + 105 (swift) · webapp 1012 · `npx tsc -b` clean.

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

**Install / provisioning polish:**
- ✅ **Beacon the partitioning→installing transition — DONE (`7db385a`).**
  `partman/early_command` now drops a backgrounded best-effort
  `/usr/lib/base-installer.d/05flagship-beacon` that POSTs `phase:"installing"`
  via the shared `debianBeaconCommand` idiom; byte-identical in both generators,
  pinned by tests. NOT locally testable (no d-i dry-run) → observe on the next
  real burn's checklist (cosmetic if it doesn't fire: lag, not hang).

**App / recovery:**
5. **Recovery Phase B re-pair branch — CODE DONE, on-device validation only.** The full Phase A/B branch is already wired + tested (see the 2026-06-09 evening-sweep note): validate on a real device that a rotated-key recovery lands in re-pair-with-grace and an unrotated one pairs instantly. Backend already deployed.
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
