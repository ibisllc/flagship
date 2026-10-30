# Retained TypeScript and JavaScript: execution surfaces

Release plan G9 (owner direction 2026-10-30): no broad daemon rewrite and no Rust-to-TypeScript move. This lists every
place TypeScript or JavaScript still runs, with what each is allowed to do, what it may read, who owns its runtime and how
it is patched. A surface that moves to Rust (release plan section G) is removed from here when the TypeScript is deleted.
Facts marked *verify* were read from code but not proven on a box.

| Surface | Runs as | Authority | Secrets it can read | Runtime owner | Patch mechanism |
|---|---|---|---|---|---|
| Box daemon (`packages/server-daemon`): API, product workflows, access journal, gossip, backups, builds orchestration | systemd unit, user `flagship` (`FLAGSHIP_DAEMON_UNPRIVILEGED=1`), umask 0077 | No root. Host effects only through the broker's typed ops (privd socket), keys only through keyd's socket | None of the raw keys (identity, SWK, CGK, TLS key live in keyd). Sealed app tokens and AI provider keys in its own data dir | The release's Node (`/opt/flagship/.runtime/node`, locked by `release/runtime-lock.json`) | Signed artifact, installed and rolled back by `flagship-updater` |
| TS keyd and privd (`packages/keyd`, `packages/privd`) | keyd: user `flagship-keyd`; privd: root | The Rust twins' contract, same vectors | keyd: the keys. privd: none of its own | The release's Node, `--jitless` for keyd (V8's JIT conflicts with `MemoryDenyWriteExecute`) | Same artifact. Fallback only; deleted after the Rust path has soaked (plan G8) |
| AI, MCP and provider integrations (`packages/llm-providers`, daemon `buildmodes/`, `chat/`, `llm/`) | Inside the daemon process | Outbound HTTPS only, through the egress filter and the hub relay (provider calls); builds only on a staging copy with sample data | Provider API keys the owner sealed for the account; the model redactor keeps identity out of prompts | Daemon runtime | Signed artifact |
| App builds and live apps | Containers under gVisor (Podman), runtime bases pinned by digest (`runtimes/catalog.ts`) | A private network, no host mounts beyond the app's own data, quotas | The app's own database role and files volume | The pinned runtime image, not the host's Node | New image digest through a release; the owner's AI or import produces the app code |
| Artifact build and gym tooling (`tools/box-artifact`, `tools/live-e2e`, `scripts/*.mjs`) | CI and the maintainers' machines | Build the artifact, drive the gym fleet, sign with a hardware key (`yubikey-sign.mjs`) | Gym secrets (`.gym-secrets.env`, UpCloud token, gym key); the release YubiKeys at ceremony time | The maintainer's or CI's Node (pinned in `.github/workflows`) | Repository changes on `main`; never runs on a user's box |
| Cloudflare Workers (`apps/com`, `apps/boot`, `apps/webapp-static`) | Cloudflare's V8 isolates | Everything `.com` does: identity, state, mailbox. Cannot read a box's content (TLS ends on the box) | Worker secrets and D1/R2/Durable Objects of the account | Cloudflare (platform managed: cannot be pinned like the box's Node) | `npm run deploy` from `main` |
| Fly relay (`apps/web` server, `packages/tunnel-protocol`) | Node on Fly | Opaque stream routing by SNI, tunnel hub, outbound relay for provider calls; no TLS keys | The hub credential and the relay secrets | The Fly image's Node | `flyctl deploy` from `main`. Replaced by the Rust relay (plan G7) |
| Browser webapp (`apps/web/public/webapp`) | The user's browser | Whatever the signed-in device holds | Device keys in the browser's key storage | The browser (platform managed) | Static deploy; CSP `script-src 'self'`, no inline script (tested) |
| Studio and builder engines (`preseed-engine.js` embedded in the native apps) | Inside the native apps' script engines | Produces the installer; writes the USB stick as the user | The install recipe | The native app's engine | The engine is built from `packages/flagship-builder` and pinned by byte tests |

## Rules that hold for every row

- No TypeScript executes as root on a user's box except the TS privd fallback, which is a fixed set of typed operations
  behind a validated schema shared with the Rust broker (`packages/privd/tests/vectors/v1-policy.json`).
- No Bun, Deno or runtime TypeScript loader is used to run box code. TypeScript is compiled to JavaScript in the artifact build
  (`tsc -b`, compiler pinned by `package-lock.json`) and Node runs the JavaScript.
- Installs are frozen: `npm ci --ignore-scripts` from the lockfile, every package with an integrity hash
  (`tools/box-artifact/build.ts` refuses otherwise), no fallback to re-resolution.
- The runtime is locked, downloaded from its official distributor and verified three ways before it is unpacked
  (`release/runtime-lock.json`, `flagship-updater runtime`).

## Open

- The daemon runs with V8's JIT on. `--jitless` is qualified for keyd; for the daemon it is not measured (cost) and not required
  by its unit's hardening. A decision needs a benchmark (plan G10).
- Node permission switches (`--permission`) would narrow the daemon's filesystem reach further but supplement, not replace, the
  OS isolation; not enabled.
- The TS twins of keyd and privd stay until the Rust path has soaked on both architectures (plan G8).
