# Flagship — orientation for Claude Code

Personal-cloud ecosystem. The phone is the trust root; users run their own server on commodity hardware at home; **TLS terminates on the user's box** so flagship.services literally cannot read user content. Verified end-to-end in production with a real green padlock as of 2026-05-05.

If you have access to agent memory, **read `project_overview.md`** first — it's the canonical briefing. Then `final_architecture_2026_05_05.md` for details. This file is the in-repo abridged version.

## What's where

```
apps/com/                  Cloudflare Worker — flagshipserver.com (identity + state) + web.flagshipserver.com (webapp host-rewrite)
apps/web/                  Fly app — flagship.services (stateless data plane) + the webapp static surface
apps/web/public/           Static assets served by the Worker's [assets] binding
   build/                  /build/ — paste a build code, download a personalized ISO
   dev/create-server       /dev/create-server — phone simulator
   status/                 /status/ — live health dashboard
   security/               disclosure.html, report.html
   webapp/                 PWA source (served at root on web.flagshipserver.com)
apps/mobile/               iOS Swift + Android Kotlin clients — substantial code; not yet on TestFlight/Play

packages/protocol/         Canonical-bytes + Ed25519 sign/verify for every signed message
packages/storage/          Storage interfaces + InMemory + D1 adapters + SQL migrations
packages/control-plane/    Pure runtime-agnostic handlers (used by Worker AND Fastify)
packages/server-daemon/    PRODUCTION daemon entry (acme, tunnel client, app runner, lease store, browser bundle)
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

**`.com` (Worker + D1 + R2)** owns identity & persistent state. **`.services` (single Fly app)** is a stateless pipe: SNI passthrough on :443 + tunnel-hub WebSocket on :8443. **The user's daemon** runs ACME locally (TLS-ALPN-01 over the same passthrough chain), holds the Let's Encrypt cert, and serves apps. **Routing-Control-Key (RCK)** is a phone-held primitive that decouples "who can claim a subdomain's traffic" from "which server is currently handling it" — enables failover/migration/delegation.

## Live URLs

- `https://flagshipserver.com/` — landing
- `https://flagshipserver.com/build/` — paste a build code, get a personalized ISO
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
# 2. Mint a code, then paste it into https://flagshipserver.com/build/
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

## Status

- **End-to-end live**: real Let's Encrypt cert via TLS-ALPN-01 over SNI passthrough, verified 2026-05-05; wildcard SANs via DNS-01 since 2026-05-06; webapp at `web.flagshipserver.com`; auto-unlock-lease (one-shot + long-lived) live with silent renewer; WebAuthn-PRF cloud recovery; Web Push w/ RFC 8291 encrypted payloads; /consume → push auto-trigger.
- 1500+ tests across 144+ files, all green. `npx vitest run` ~30s, `npx tsc -b` clean.
- Workspace deps: `npm install` + `npx tsc -b`.

## Outstanding work (verified 2026-05-11; reconciled with the v1-alpha checklist in `docs/build-tasks.md`)

**Confirmed done despite older notes:** wildcard cert via DNS-01 (RemoteDnsChallengeWriter wired, `wildcard:true` default); daemon entry merge (server-daemon/src/index.ts is the production entry; hello-daemon stays as the explicit demo); persistent ACME on the production daemon; phone-server `/api/orders-from-user` endpoint; LUKS unlock-on-boot end-to-end (smoke-luks-unlock.ts and smoke-lease-unlock.ts both pass live); peer-backup matchmaker + BackupLoop wired (apps/web Fastify + server-daemon).

**v1-launch blockers still open:**
1. **E2E test rig + scenarios** (`docs/e2e-test-plan.md`). Playwright + pod-sim, chromium-only first. 13 scenarios covering signup → unlock-approve → lease + renewal → webauthn recovery → push subscribe + deliver. Largest single piece of work remaining.
2. **iOS app real impl** (TestFlight-ready). Substantial Swift code under `apps/mobile/ios/Sources/` already; needs Xcode build + signing + TestFlight upload + 5 external testers.
3. **Android app real impl** (Play internal track). 17 Kotlin files under `apps/mobile/android/`; same shape — Gradle build, FCM setup, signing, internal-track upload + 5 testers.
4. **Marketplace security scan service**. `marketplace_listings.scan_grade` column ships NULL today; scanner service that pulls a docker image, runs Trivy + custom checks, posts back grade + R2 report. MVP requirement before public marketplace launch.
5. **Recovery J.3 + J.4** — re-pair envelope (new IRK refs old; .com confirms in 24h grace; daemon swaps PSK + paired-session) + membership re-attach (walk apps, re-issue stable-ids, alert per app). Without these, a recovered UMK can't actually take over the user's existing servers.
6. **Reproducible-build CI for the Alpine ISO**. Today the base ISO is built ad-hoc; for a "trust the bytes you boot" claim we need bit-for-bit reproducible builds in GitHub Actions with deterministic timestamps.
7. **Peer-backup distribution at scale** — primitives all built (peerLink, transport, shardStore, registry, repairDaemon, matchmaker, BackupLoop); needs operational tuning + a 7-day exercise across multiple pods to validate.
8. Update-pack + lineage-break + STK rotation + recovery-from-lost-phone — each needs a live exercise per the v1-alpha done-when checklist.

## When in doubt

Read `project_overview.md` (in agent memory) end-to-end before making changes. `docs/build-tasks.md` (section S "v1 alpha done-when checklist") is the most current ground-truth for the launch list. `docs/e2e-test-plan.md` covers the test rig design.
