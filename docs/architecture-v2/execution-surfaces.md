# Execution surfaces: where non-Rust code runs, and what it may do (release 0.3, plan G9)

Status: read from `release/0.3` on 2026-11-01 and checked against the code named in each row; measured where it says
so. Not a claim about what runs on any shipped box. Replaces `ts-execution-surfaces.md` and `retained-typescript.md`
(2026-10-30), which said two things the code does not do: that no TypeScript runs as root except the TS privd fallback
(the root setup steps run TypeScript as root through either broker, section 1.2), and that the health reporter signs
through keyd (it signs with a key file, row below).

"Fallback" means the Rust program runs when the box's switch is on and the TypeScript or Go program runs only if the
Rust one fails three starts or the switch is off (`flagship-rust-select`, `rustStack/units.ts`). No Rust-to-TypeScript
moves; no broad daemon rewrite (owner, 2026-10-30).

## 1. On the box

### 1.1 Long-running processes

| Surface | Code / runtime | Runs as | Authority | Secrets it can reach | Runtime owner | Patched by |
|---|---|---|---|---|---|---|
| `flagship-daemon` (`packages/server-daemon`): HTTP API and screens, app proxy, product workflows, access journal, gossip, backups, build orchestration, MCP, AI/provider adapters (`packages/llm-providers`, `llm/`, `chat/`, `buildmodes/`) | TS compiled to JS (`tsc -b`, compiler pinned to 5.9.3), Node 24.22.1 from the release (`/usr/local/bin/node`, section 3) | `flagship` once privd/broker answers (`40-privd.conf`: `CAP_NET_BIND_SERVICE` only, `NoNewPrivileges`); **root before that** (first boot until keyd and the helper are in) | Product decisions; host effects only through the broker's typed ops; keys only through keyd's socket; outbound AI through the egress filter and the hub relay | No raw box keys (keyd holds them). The owner's sealed provider keys and app tokens in its data dir; the data-services admin URL (`data-services.env`, root-owned, group-readable) | The release's Node; its sandbox drop-in `45-hardening.conf` (section 2) | Signed artifact, installed and rolled back by `flagship-updater` |
| `flagship-privd` (`packages/privd`) | TS, Node | root (no `User=`; `NoNewPrivileges`) | A closed set of typed host ops (`policy.ts`, vectors shared with the Rust broker) | Its audit log | Release Node | Artifact. Fallback only when the Rust broker is selected |
| `flagship-broker` (Rust) | Rust | root | The same ops plus core's typed v2 socket | Its audit log | Artifact pins (`installer/rust/PINS.json`) | Artifact |
| `flagship-keyd` (Rust; TS `packages/keyd` fallback) | Rust; TS fallback on Node `--jitless` | `flagship-keyd` | Box identity, workload and TLS key custody; signs fixed shapes | All box private keys | Release Node for the fallback (`MemoryDenyWriteExecute` needs `--jitless`) | Artifact |
| `flagship-ingress` (Rust; Go `flagship-tlsd` fallback) | Rust / Go | `flagship-tlsd` | Terminates TLS with keys held in keyd | None (asks keyd) | Artifact | Artifact |
| `flagship-core`, `flagship-access` | Rust | `flagship-core`; access: root with only `CAP_DAC_READ_SEARCH` | Reconciler (shadow); access decisions | None | Artifact | Artifact |
| `flagship-gpud`, `flagship-wasi@` | Rust | gpud root (devices, CDI); wasi `DynamicUser` per app | Device allocation; WASI sandbox | None | Artifact | Artifact |
| `flagship-data-services` (`installer/data-services/init.sh`, compose) | bash + container engine | root | Starts Postgres, Forgejo, Chromium containers | Generates their root credentials into `/var/flagship/data-services.env` | Distro bash | Artifact |
| `flagship-health.timer` (`healthReporter.ts` writes the script) | bash + `openssl pkeyutl` | root (no `User=`) | Signs a fixed-field health report | Reads the boot key or STK file directly (`/boot/flagship-boot-key.pem` or the identity key), not through keyd | Distro tools | Artifact (rewritten by the `health-reporter` step) |
| App containers and staging copies | The app's runtime image (`node-24`, `python-3.13`, `static`, pinned by digest in `runtimes/catalog.ts`), or WASI | image user 10001 under gVisor, read-only, `--cap-drop=ALL` | Its own files volume, database role, owner-approved hosts | Its own token and env | The pinned image, never the host's Node | The app's deploy; image digests move with the artifact |
| App image builds (`npm ci`, lifecycle scripts inside the build) | whatever the app's tooling runs | the engine's build (root dockerd/podman; not rootless, not gVisor: `release/build-isolation-profile.json`) | Build output only; registries only | None (staging has placeholder secrets) | Build image | App deploy |

### 1.2 Short-lived TypeScript that runs as root (stays root in 0.3)

| Surface | Why it is root | What keeps it narrow |
|---|---|---|
| **Root setup steps**: `/usr/local/bin/node /opt/flagship/packages/server-daemon/dist/setup.js <step>`, launched by either broker (`policy.ts setupExec`, `flagship-broker policy.rs`) for 17 named steps: gvisor, health-reporter, update-guard, container-links, data-unit, debug-access(-close), system-repair, server-code, rust-stack, wasi-runtime, gpu-broker, arch-v2-switch/settle, engine-migrate/rollback, boot-chain | Each writes host configuration only root may: systemd units and drop-ins, `/usr/local/sbin` scripts, gVisor into `/usr/local/lib` and `daemon.json`, dpkg repair, initramfs and boot entries, the container engine's data | The daemon can name a step, never supply code or arguments; the step's JS is in the root-owned release tree it cannot write; the broker's environment is sanitized (`UnsetEnvironment`), so the child inherits no loader or `NODE_OPTIONS`. Moving these into the Rust broker is G8 work, step by step, after the upgrade and recovery paths are proven |
| The daemon itself before its first switch | It installs keyd and privd/broker, then hands its state to `flagship` and restarts unprivileged (`privdInstall.ts`) | Happens once per box; until the helper answers, it logs "running as root" every boot |
| `scripts/install-helper.ts` via `flagship-tsx` (tsx loader) | Box install and artifact install (`install-box-artifact.sh`, `flagship-updater` release step) | The only runtime TS loader on a box; runs the release's own pinned Node and tsx from the verified tree; never with network fetches of code. Compiling it to JS ahead of time would remove the loader: open |
| `flagship-update-guard.sh`, `flagship-rust-select` | bash, `ExecStartPre=+` | Hands over to the pin-checked Rust updater when present |

### 1.3 Boot and install

Initramfs unlock (shell premount, Go `flagship-unseal`, Rust boot client) runs as root before the system starts and
decides whether the disk key is released; refreshed by the `boot-chain` step. Install (`userdata.ts`, `appliance.ts`,
`installer/*.sh`) is bash as root once, written fresh by each Studio/builder.

## 2. The unprivileged daemon's sandbox (G9, `privd/src/unit.ts daemonHardeningDropIn`)

Written as `flagship-daemon.service.d/45-hardening.conf` when the daemon gives up root, and kept current by the root
`update-guard` step on every boot (present exactly while `40-privd.conf` says `User=flagship`; removed otherwise, because
a root daemon still writes `/etc` and `/usr`). It adds `UnsetEnvironment` (the loader, Node and OpenSSL variables:
`NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `OPENSSL_CONF`, ...),
`ProtectSystem=full`, `ReadOnlyPaths=/opt/flagship-releases /opt/flagship`, `ProtectHome`, kernel tunables/logs/cgroups
read-only, `ProtectHostname`, `RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality`, native
syscalls only with the mount/module/raw-io/debug/reboot/swap/clock/obsolete groups refused (`EPERM`), address families
UNIX/INET/INET6/NETLINK, `LimitNOFILE=65536`, `TasksMax=4096`, `MemoryMax=75%`, no core dumps. The broker, core, access,
privd and keyd units carry the same `UnsetEnvironment` line. Tests: `packages/server-daemon/tests/retainedRuntime.test.ts`.

Left out on purpose (the daemon needs them):

- `MemoryDenyWriteExecute`: V8's JIT needs writable+executable pages; see `--jitless` below.
- `PrivateTmp`: files pass through `/tmp` and `/var/tmp` to broker operations in another unit.
- `ProtectSystem=strict`: the daemon's writable state is spread over `/var/flagship`, `/var/lib/flagship-files`,
  `/var/tmp` and run dirs; listing them all is a box-qualified change, not a guess. `full` plus ownership already
  keeps it off `/usr`, `/etc`, `/boot` and the release tree.
- `PrivateDevices`, `ProtectClock` (which closes the device list), `ProtectKernelModules` (hides `/usr/lib/modules`):
  GPU and hardware probes run as the daemon's children.

**It can never keep a box down.** Every rollback path removes the drop-ins this release line adds and an older
release does not know (`RELEASE_DROPINS`: today only `45-hardening.conf`), then reloads systemd in the background:
`installer/rollback-box-artifact.sh` (the update guard's and the broker's fallback rollback) and `flagship-updater
restore` (the Rust guard's and the broker's rollback). And the drop-in limits itself: the bash update guard, which runs
as root before every daemon start (`ExecStartPre=-+`, before it hands over to the Rust updater), counts starts made
while the drop-in is present; after 5 in a row, each within 120 s of the one before, it removes the drop-in, writes
`/var/lib/flagship-hardening/disabled.json` (root's, world-readable) and a journal line, and the daemon notes
`server.sandbox.removed` in Activity once. The root setup step does not write the drop-in back for the same release;
the next release tries again. A hardening mistake therefore degrades the box to "unhardened", not "down". Tests:
`retainedRuntime.test.ts` (the real bash guard and rollback script), `rust/crates/flagship-updater/tests/install.rs`.

**Not yet run on a box.** The first box that applies the drop-in is the next gym artifact; the gym should run the
daemon under it before release. A sandbox that breaks only part of the daemon (it starts, then one feature fails) is
not detected by the crash-loop count. The Activity kind has no label in the apps yet (they show it humanized).

### `--jitless` for the daemon: measured, not adopted

`node scripts/jitless-bench.mjs --node <node> --rounds 5`, Node v24.22.1 (official darwin-arm64 build, same version as
the lock), Apple M4, 2026-11-01, medians of 5 runs, a busy machine (other agents building):

| | JIT | `--jitless` |
|---|---|---|
| global `fetch` to a local HTTP server | works | **fails**: `WebAssembly is not defined` (undici's HTTP parser is WebAssembly) |
| `WebAssembly` | present | absent (also pdf.js decoders in `unpdf`) |
| Fastify requests/s (in-process inject) | 24,905 | 12,888 (-48 %) |
| dependency graph import (fastify, pg, x509, acme-client, ws, tar-stream) | 153 ms | 199 ms |
| @noble/ed25519 verifies/s | 817 | 786 |
| node:crypto Ed25519 verifies/s | 20,879 | 24,534 (native, unaffected) |
| RSS after the run | 290 MiB | 274 MiB |

The daemon makes every outbound call (`.com`, ACME, providers) with Node's `fetch`, so under `--jitless` it cannot
work at all; the throughput cost would matter second. keyd keeps `--jitless` (no network, needs
`MemoryDenyWriteExecute`). Not measured on Linux or amd64; the fetch failure is a property of Node's bundled undici,
not of the platform.

## 3. One qualified Node

- The lock: `release/runtime-lock.json` (Node 24.22.1, both Linux archives and executables by SHA-256, signer key by
  fingerprint, support end 2028-04-30) and `tools/box-artifact/node-pins.json` (same version and archive digests). The
  build takes Node only from the official archive, checked against the pinned digest and the PGP-signed SHASUMS256.
- The launch: every unit names `/usr/local/bin/node` (absolute; checked by test for every Flagship unit). That path is
  a root-owned symlink the installers point at the running release's `.runtime/node/bin/node`
  (`install-box-artifact.sh`, `rollback-box-artifact.sh`, `flagship-updater`), which refuse a release without it. No
  unit or the broker looks Node up on `PATH`.
- The daemon cannot change its runtime or code: the release tree is unpacked as root (`--no-same-owner`) under
  `/opt/flagship-releases`, `/usr/local/bin` is root's, and the sandbox makes both read-only on top of ownership.
- Gap: a box that never received an artifact (a legacy git-clone install) still runs whatever `/usr/local/bin/node`
  its install put there; such boxes are replaced, not patched (`docs/architecture-v2/owner-builds.md`).

## 4. Hosted services

| Surface | Runtime | Authority | Runtime owner | Patched by |
|---|---|---|---|---|
| `.com` (`apps/com`), boot (`apps/boot`) | TS on Cloudflare Workers | Identity, state, CA lease signing, (H1) issuance | Cloudflare (platform managed; cannot be pinned) | `npm run deploy` from `main` |
| `webapp.` / `remote.` (`apps/webapp-static`) | static assets | none server-side | Cloudflare | same deploy |
| `.services` relay (`apps/web` TS hub; Rust `flagship-relay` after G7) | Node on Fly (the image's Node) | SNI routing, tunnel hub, outbound relay for provider calls; no TLS keys | The Fly image | `flyctl deploy` from `main` |
| DNS broker (`apps/dns-broker`) | TS, Node package | Challenge TXT records | its deploy | its deploy |
| Inference shim (`infra/inference/shim`) | TS on Workers | Meters and forwards model calls | Cloudflare | its deploy |

## 5. Clients, builders, tools

| Surface | Runtime | Notes |
|---|---|---|
| Webapp (`apps/web/public/webapp`) | the user's browser | No build step; CSP `script-src 'self'` |
| Studio (`apps/builder-*`, `desktop-shared`), builder engine (`preseed-engine.js`) | Swift / C# / Python+GTK; the engine inside each app's script engine | Built from `packages/flagship-builder`, pinned by byte tests |
| Artifact build (`tools/box-artifact`), release and gym tooling (`scripts/`, `tools/live-e2e`, `tools/gym`) | Node + `tsx` on CI and maintainers' machines | Never ships to a box. CI pins Node 24.22.1 and Go 1.26.3; gym secrets and release YubiKeys only on the maintainer's machine |

## 6. Dependencies and lifecycle scripts

- `npm ci --ignore-scripts` from the committed lock, every package with an integrity hash (the build refuses one
  without); `npm ci` fails rather than re-resolving when `package.json` and the lock disagree. Platform packages are
  chosen with `--os=linux --cpu=<arch>` and checked (`assertTargetBinaries`).
- Packages with install scripts in the lock: `esbuild` (0.27.7 and vite's 0.21.5) and `fsevents` (twice), all dev
  tooling, allowlisted with reasons in `release/dependency-policy.json` and tested (`scripts/dependency-policy.test.ts`).
  On the box build none runs: esbuild's binary arrives as the `@esbuild/linux-<cpu>` optional dependency. Lifecycle
  scripts run nowhere in the release build; app builds run their own inside the app build sandbox (section 1.1).
- The TypeScript compiler is pinned on its own (root `package.json` `typescript: 5.9.3`, exact) and the build runs it by
  path from the lock (`assertCompilerPinned`), never `npx` resolution.
- The SBOM (CycloneDX 1.5) lists every npm package with `scope` required/excluded by what the artifact really carries,
  every Cargo crate with its checksum, every Go module, and the Node archive (`docs/architecture-v2/owner-builds.md`).
