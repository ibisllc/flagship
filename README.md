# Flagship

> Personal-cloud ecosystem. Phone is the trust root. Servers run on commodity hardware at home. TLS terminates on the user's box; the control plane never sees user content.

## What it is

A user signs up, claims a username, and gets a Flagship server by:

1. Installing Flagship Studio from `flagshipserver.com/studio` on a Mac or Windows computer.
2. Tapping *"Create a new server"* in the phone app and pairing with the QR or short code shown by Studio.
3. Letting Studio download the base image and write the authorized recipe to a USB stick, then booting commodity hardware (old laptop, NUC, …).
4. The server boots Alpine, validates the trailer signature, fetches install scripts from this public repo at the trailer-pinned ref, partitions + LUKS-encrypts the disk, registers itself with `.services`, runs the Flagship daemon.
5. The user's services are reachable at `<service>.<server>.<user>.flagship.services` over real Let's Encrypt HTTPS — TLS terminates on the user's hardware.

## Architecture

- **`flagshipserver.com`** — Cloudflare Worker + D1 + R2. Identity, auth codes, build tickets, server registry, routing-control-keys, CA-signed pubkey bindings, install-event log. All persistent state.
- **`flagship.services`** — single Fly app. Stateless pipe: raw-TCP SNI passthrough on `:443` (peeks the SNI on the TLS ClientHello, splices the connection through to the user's daemon over a tunnel WebSocket) + tunnel-hub WS on `:8443`.
- **The daemon** — runs on the user's hardware. Holds the cert. Runs ACME (TLS-ALPN-01) directly with Let's Encrypt over the same SNI passthrough chain that carries production traffic. Serves services.
- **The phone** — trust root. UMK in Secure Enclave / StrongBox. Derives every other key.

A more detailed walkthrough lives in `CLAUDE.md` at the repo root.

## End-to-end live

The production path uses the phone-held account key to authorize a signed recipe and delivers it directly to Studio over a QR/code pairing session. The webapp can download the same recipe as a file for opening in Studio. The demo daemon in `packages/hello-daemon` exercises the service path without flashing real hardware.

## Workspace

```
apps/com           Cloudflare Worker (flagshipserver.com)
apps/web           Fly app (flagship.services) + static assets
apps/mobile        iOS Swift + Android Kotlin scaffolds (deferred)
packages/protocol  Canonical-bytes + Ed25519 signing primitives
packages/storage   Storage interfaces + InMemory + D1 adapters + SQL migrations
packages/control-plane  Pure runtime-agnostic handlers (used by Worker AND Fastify)
packages/server-daemon  Production daemon (acme, tunnel client, service runner)
packages/hello-daemon   Minimal demo daemon
packages/iso-personalizer  Trailer format
packages/installer-apkovl  Apkovl tarball builder
packages/tunnel-protocol   Tunnel frame format + SNI parser
packages/services-zone     Subdomain validation + DNS publisher
packages/bootkey-builder   Caddyfile helpers
packages/llm-providers     BYOK provider adapters
installer/                 Public install scripts (curl-fetched at first boot)
```

## Build & test

```sh
npm install
npx tsc -b      # typecheck the whole tree
npx vitest run  # ~757 tests, ~30 seconds
```

## Deploy

See `CLAUDE.md` for the full set of commands. TL;DR:

```sh
cd apps/com && npx wrangler deploy                      # Worker
export PATH="$HOME/.fly/bin:$PATH"
flyctl deploy --remote-only --strategy=immediate --yes -a flagship-services
```

## License

[BUSL-1.1](LICENSE). Change Date 2030-05-03 → Apache 2.0. Licensor: Harry Winner.
