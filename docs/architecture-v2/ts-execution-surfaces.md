# Retained execution surfaces: TypeScript, JavaScript and shell (release 0.3, plan G9)

Status: an inventory read from this branch on 2026-10-30, not a claim about what runs on any shipped box.
Where a row says "fallback", the Rust program runs when the box's switch is on and the TypeScript or shell
program runs only if the Rust one fails three starts or the switch is off (`flagship-rust-select`). The point
of the list is to name, for every place the release executes code that is not Rust, who runs it, what it can
touch, and how a fix reaches it. Rows marked **gap** are things this inventory found missing; they are tracked
in the release journal (plan section G), not fixed by writing the list.

## 1. On the box

| Surface | Language / runtime | Runs as | Authority it holds | Secrets it can reach | Patched by |
|---|---|---|---|---|---|
| `flagship-daemon` (`packages/server-daemon`: HTTP API, app proxy, workflows, access store, MCP, AI/provider adapters, gossip, update consumer) | TypeScript compiled to JS, Node (pinned, `release/runtime-lock.json`), unprivileged in arch-v2 | `flagship` (no root, `NoNewPrivileges`, `CAP_NET_BIND_SERVICE` only; `FLAGSHIP_DAEMON_UNPRIVILEGED=1`) | Everything product-level: owner sessions, app lifecycle orders, access decisions, outbound AI calls. Host effects only through the broker (typed ops) | No raw key custody under keyd (it asks keyd to sign); app tokens, provider credentials the owner sealed, database admin URL | The signed box artifact (endorsed release, updater G1) |
| `flagship-privd` (`packages/privd`): the TS broker | TypeScript, Node | root (no `User=`, `NoNewPrivileges`) | Typed host operations: docker/podman argv, systemctl, setup steps, iptables restore, power | The broker's own audit log; no keys | Same artifact. **Fallback only** when Rust broker is selected (`flagship-broker`) |
| `flagship-keyd` (`packages/keyd`) | TypeScript, Node `--jitless` | `flagship-keyd` | Box identity, workload and TLS key custody; signs only fixed shapes | All box private keys | **Fallback only** when Rust `flagship-keyd` is selected |
| `flagship-tlsd` (Go) | Go | `flagship-tlsd` | Terminates TLS using keys held in keyd (`tls.sign` signs handshake input only) | None (asks keyd) | **Fallback only** when Rust `flagship-ingress` is selected |
| `flagship-core` (Rust, shadow) | Rust | `flagship-core` | Reads the TS controller's view; no effects in shadow mode | None | Artifact |
| `flagship-gpud`, `flagship-wasi@` workers | Rust | gpud root-scoped for CDI/devices; wasi per app | Device allocation; WASI sandbox | None | Artifact |
| `update-guard` (`ExecStartPre` on the daemon) | bash, then the Rust updater (G1) when pinned | root (`+`) | Roll back an interrupted apply without Node | Update intent only | Artifact; the guard hands over to a pin-checked `/usr/local/sbin/flagship-recovery` |
| `flagship-health.timer` reporter | shell script | root | Signs a health report with the box key via keyd | via keyd | Artifact (`healthReporter.ts` writes it) |
| Box install and first boot (`userdata.ts`, `appliance.ts`, `installer/*.sh`) | bash (+ `flagship-tsx` for helper scripts) | root, once | Disk, LUKS, registration | Generates the identity; boot key | Written fresh by each builder/Studio; the box never re-runs it after install except `data-services/init.sh` on every boot |
| `flagship-data-services` (`installer/data-services/init.sh`, compose) | bash, container engine | root | Starts Postgres, Forgejo, Chromium containers | Generates random root credentials into `/var/flagship/data-services.env` (0600) | Artifact |
| Boot unlock premount (`unlockPremount.ts` output), Go helper, Rust boot client | shell in initramfs; Go; Rust | root in initramfs | Decides whether the disk key is released | The sealed lease key (TPM when present) | Boot-chain refresh (`boot-chain` setup step) |
| App containers (user apps and AI-built apps) | Whatever the app's runtime names: `node-24`, `python-3.13`, `static`, WASI; pinned by digest | unprivileged image user (10001) under gVisor | Only its own files volume, its own database role, hosts the owner approved | Its own app token and env | The app's own deploy; the runtime digest moves with the artifact (`runtimes/catalog.ts`) |
| App builds (`docker build`/buildah, `npm ci`, lifecycle scripts) | whatever the app's tooling runs | the build bridge, no internet except registries | Build output only | None; staging has placeholder secrets | App deploy; build bridge policy in the artifact |
| Policed app browser (Chromium container) | C++ (upstream image) | container | Browsing for apps the owner granted | Browser profile | Image digest in the artifact |

**Gap 1:** the daemon, the TS broker and the TS keyd all run on the same Node. A Node vulnerability is therefore a
vulnerability of all three on a box that fell back. G2 pins and verifies the binary; G9's unprivileged-runtime and
`--jitless` qualification are still to do (keyd already runs `--jitless`; the daemon does not).

**Gap 2:** `flagship-tsx` (a TypeScript loader) is used by install helper scripts. It is the only runtime TS execution
on a box; plan G9 says "do not introduce a runtime TS loader". It runs once at install under root.

## 2. Hosted services

| Surface | Language / runtime | Authority | Patched by |
|---|---|---|---|
| `.com` (`apps/com`) | TypeScript on Cloudflare Workers (platform-managed engine) + D1 + R2 | Identity, state, issuance (H1 will add the trusted issuance service here), CA lease signing | `npm run deploy` from `main` |
| `webapp.` and `remote.` (`apps/webapp-static`) | Static assets | none server-side | `npm run deploy` |
| `.services` relay | Node (`apps/web`, the TS hub) today; Rust `flagship-relay` (`Dockerfile.relay`) after the canary | Routes tunnels by SNI, never sees plaintext | `flyctl deploy`; the Rust image is deployed to the gym with `GYM_RELAY=rust` first |
| DNS broker (`apps/dns-broker`) | TypeScript (a Node package; `.com` also writes challenge TXT records itself) | Writes challenge TXT records | Its own deploy; to be confirmed against `apps/com` when H1 reshapes issuance |
| Inference shim (`infra/inference/shim`, a Worker) | TypeScript on Cloudflare Workers | Meters and forwards model calls | Its own deploy |

## 3. Clients and tools

| Surface | Language | Notes |
|---|---|---|
| iOS and Android apps, Wear OS | Swift, Kotlin | Store builds; PQ code from vendored C (mldsa-native, mlkem-native) |
| Studio (`apps/builder-mac`, `-windows`, `-linux`, `desktop-shared`) | Swift (Mac), C# (Windows), Python with GTK (Linux), shared Node code in `desktop-shared` | Burns media and hosts VMs; Windows and Linux builds are unsigned |
| Webapp | JavaScript (no build step) | Strict CSP, no inline script |
| Release and gym tooling (`scripts/`, `tools/`, `tools/live-e2e`) | bash, TypeScript via `tsx` | Dev machines and CI only; never ships to a box. The gym holds a throwaway signing key K and, while debugging, a temporary SSH key |

## 4. What a patch of each layer needs

- **Node**: a new `release/runtime-lock.json` entry, verified from the upstream distributor's PGP-signed checksums
  (G2), published in a signed runtime manifest (open: needs the release key), delivered by an artifact update.
- **A box dependency**: `npm ci --ignore-scripts` from the frozen lock; native addons and lifecycle scripts are not
  run on the box. **Gap 3:** the SBOM and provenance exist per artifact (`tools/box-artifact`); the reproducible-build
  comparison and the isolated owner build (G9) are not built.
- **A Rust component**: rebuilt into the artifact; the updater (G1) switches atomically and rolls back.

## 5. Not migrated, on purpose

Per plan G: no broad daemon rewrite and no Rust-to-TypeScript moves. The daemon's product workflows (MCP, provider
adapters, build orchestration, gossip, Activity) stay TypeScript. What moves to Rust is whatever holds authority or
touches the host: keys, TLS, the broker, the updater, the endpoint table and reconciler (G3), the access
verification and enforcement (G5), the relay (G7).
