# Flagship — orientation for Claude Code

Personal-cloud ecosystem. The phone is the trust root; users run their own server on commodity hardware at home; **TLS terminates on the user's box** so flagship.services literally cannot read user content. Verified end-to-end in production with a real green padlock as of 2026-05-05.

If you have access to agent memory, **read `project_overview.md`** first — it's the canonical briefing. Then `final_architecture_2026_05_05.md` for details. This file is the in-repo abridged version.

## What's where

```
apps/com/                  Cloudflare Worker — flagshipserver.com (identity + state)
apps/web/                  Fly app — flagship.services (stateless data plane)
apps/web/public/           Static assets served by the Worker's [assets] binding
   build/                  /build/ — paste a build code, download a personalized ISO
   dev/create-server       /dev/create-server — phone simulator
   status/                 /status/ — live health dashboard
apps/mobile/               iOS Swift + Android Kotlin scaffolds (deferred)

packages/protocol/         Canonical-bytes + Ed25519 sign/verify for every signed message
packages/storage/          Storage interfaces + InMemory + D1 adapters + SQL migrations
packages/control-plane/    Pure runtime-agnostic handlers (used by Worker AND Fastify)
packages/server-daemon/    Production daemon scaffolding (acme, tunnel client, app runner)
packages/hello-daemon/     Minimal demo daemon — proves the chain end-to-end
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

- **End-to-end live**: real Let's Encrypt cert via TLS-ALPN-01 over SNI passthrough, verified 2026-05-05.
- ~757 tests, ~85 files, all green.
- Workspace deps: `npm install` + `npx tsc -b`.

## Outstanding work (priority order)

1. **Wildcard cert via DNS-01** (next session). One cert per server with `[<server>, *.<server>]` SANs covers all apps with one ACME flow. Replaces per-app TLS-ALPN-01 (which would hit LE's 50-certs-per-week-per-registered-domain limit on `flagship.services` immediately at any real scale). Also: apply for LE's high-volume issuer allowlist before public launch.
2. **Daemon entry point**: merge `hello-daemon`'s tunnel-client + ACME + ALPN-aware TLS server into `packages/server-daemon/src/index.ts`. **No compiled binaries** — `installer/install.sh` already does `git clone` + `npx tsc -b` + OpenRC; just point the OpenRC service at the finished entry. Transparency stays intact.
3. Persistent ACME state on the daemon (currently the demo daemon regenerates the account key on every restart).
4. Phone-server `/api/orders-from-user` endpoint on the daemon (trust model exists; endpoint not yet wired).
5. LUKS unlock-on-boot via phone (architecture clean; endpoints speced but not implemented).
6. Mobile clients (scaffolds exist; real impl needs Xcode/Android Studio).
7. Peer-backup distribution (designed in deep detail; encryption layer built; matchmaking + transport unbuilt).

## When in doubt

Read `project_overview.md` (in agent memory) end-to-end before making changes. The `final_architecture_2026_05_05.md` doc is the canonical reference for the .com/.services/daemon split + RCK + ACME-on-daemon shape.
