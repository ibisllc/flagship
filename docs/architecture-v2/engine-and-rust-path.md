# The Rust path and the Podman engine on the box (milestone 5)

Status: on `feat/architecture`, drilled on a throwaway Debian 13 VM
(`drills/m5-upcloud.md`). Not on `main`, not in any published artifact or appliance.

## 1. The box switch

`/var/lib/flagship/arch-v2.json`: `{"version":1,"rust":"on"|"off","engine":"podman"|"docker"}`.

- New boxes: the installer (`packages/flagship-builder/src/engineSetup.ts`, USB/ISO and the
  appliance factory) writes `rust: on, engine: podman` and installs Podman instead of docker.io.
- Existing boxes have no file and keep exactly what they had (TS keyd, Docker).
- A missing or damaged file reads as `off`/`docker`. The daemon reads it at every start
  (`archV2Boot.ts`).

## 2. keyd, broker and core under systemd

| Unit | Runs as | Rust binary | Fallback |
|---|---|---|---|
| `flagship-keyd` (drop-in `30-rust.conf`) | `flagship-keyd` | `flagship-keyd serve` (wire v1, same state dir) | the TS keyd (`node --jitless`) |
| `flagship-broker` | root | `flagship-broker serve`: privd v1 socket (root only) and typed v2 socket | idles; the daemon (still root) does those operations itself |
| `flagship-core` | `flagship-core`, fully sandboxed | `flagship-core shadow` | idles; the TS controller is the only controller |

Each unit's ExecStart is `/usr/local/sbin/flagship-rust-exec`. Root steps around it
(`rustStack/units.ts`):

- `select` (ExecStartPre): Rust only when the switch is on, the release carries the binary, its
  SHA-256 equals the one in the release's `installer/rust/PINS.json`, and this binary has not
  failed three runs in a row.
- `confirm` (ExecStartPost): waits for the component's socket; if it never appears the unit
  fails and systemd restarts it.
- `stopped` (ExecStopPost): counts a run systemd reports as failed (`SERVICE_RESULT`); a clean
  stop counts nothing, and a run that lasted over 120 s starts the count again.

The choice is written to `/run/flagship-rust/<component>.status`. A choice is remade only under
new pins or a new switch position, so a bad binary cannot restart-loop the box.

**Update gate.** `rustPathHealthy` (`updateHealthGate` awaitHealthy): a component that ran Rust
before (`/var/lib/flagship-rust/<c>.good`) and now runs its fallback makes the boot unhealthy, so
the release rolls back to the last good one; the next boot re-selects on that release's binary.

What the daemon uses the broker for today: host power (dead-man and lock). Engine calls and the
rest of the host effects still run in the daemon. B01's criterion (no engine or root access in
Node) is not met. Core's handover needs the capability issuer (`broker-runtime-core.md` §9).

## 3. Engine: Podman

Chosen over containerd because Podman takes the docker argv the daemon and `oci_cli.rs` already
generate, builds images itself (containerd needs BuildKit and nerdctl), has no root daemon, runs
runsc as an ordinary OCI runtime, and Debian 13 ships it at 5.4 with `host-gateway`. The plan's
two-week scorecard on both arches has **not** been run; this is a reasoned choice, not R03's
evidence.

`engine/engine.ts` maps every `docker …` the daemon writes to Podman from a closed list and refuses
the rest. Differences handled:

- gVisor: a `containers.conf.d` drop-in registers runsc; the same test container proves it.
- Networks: `--interface-name`, `mode=unmanaged` and the daemon creates each bridge with its
  gateway address before anything joins (netavark otherwise creates the bridge only with the
  first container, and gives an internal network no gateway). Docker's `--internal` becomes a
  label: the egress firewall's forward chain is what fences the build bridge. aardvark-dns is off.
- `enable_icc=false`: an nft `bridge` table drops port-to-port frames on each sandbox bridge.
- The firewall's forward chain hooks `FORWARD` (no `DOCKER-USER`).
- `info`/`version` formats, network inspect shape, compose (`podman compose` drives docker-compose
  over Podman's root-only socket).

## 4. Moving an existing box off Docker

`engine/migrate.ts`, once, at boot, before any app is restored: stop app containers and the data
services, move tagged images one at a time (`docker save` → `podman load`), redefine bind volumes
(the per-app files images) and copy other volumes, disable dockerd. Docker's data is never
deleted; a failure leaves the box on Docker; switching the engine back re-enables Docker on its
own data (data written under Podman in copied volumes is not copied back). Untagged images are
skipped and pulled again by digest.

## 5. Building and pinning the binaries

`tools/box-artifact/build.ts` builds keyd, broker and core with the toolchain in
`rust/rust-toolchain.toml`, `--locked`, paths remapped, `SOURCE_DATE_EPOCH` = commit time and no
build id, and writes their SHA-256s, rustc version and Cargo.lock digest into
`installer/rust/PINS.json` and `BUILD-INFO.json`, both inside the signed tarball (so the release
signature covers them). Reproducibility across two clean builders is not yet shown.

## 6. Known gaps

- Engine: R03 scorecard (both arches, two weeks), arm64 run, rootless, Podman's own CVE cadence.
- Broker: v1 `docker` op still on; most host ops still in the daemon; no capability issuer.
- Core: shadow only; the checkpoint lists the TS desired set, not image or generation.
- Appliances/ISOs with Podman not built or published; no gym run (the gym was not used).
- The owner's stack switch (§7) has run only in unit tests with fakes: no real box, no gym, and no
  app sends the order yet.

## 7. Moving an existing box on the owner's order

`server-daemon/src/archV2Switch.ts`. An existing (classic) box has no switch file and no Podman;
§4's move needs both. The owner's order provides them, and can also take the box back:

- **Order.** `flagship/arch-v2-switch/v1|<serverDomain>|<arch-v2|classic>|<nonce>|<issuedAt>`
  (`protocol/src/archV2Switch.ts`), signed with the sensitive-order key: the admin root on a pinned
  box (the IRK is refused there), with the hybrid signature under strict. `POST /api/stack/switch
  {order, signature, pqSignature?, dryRun?}`; `GET /api/stack` (owner sessions) shows the stack,
  the switch's record and the plan. A dry run answers with the plan and changes nothing.
- **Plan and refusals.** Steps, images and volumes to move, and the room needed (all image bytes,
  the largest again for the spool, 2 GiB spare). Refused, with a sentence, when the box is already
  there, a switch is under way, an update is pending, the release carries no Rust pins, Docker does
  not answer, the disk is too small, or (going back) there is no Docker.
- **Root.** The daemon writes the order to `/var/flagship/arch-v2-order.json`; root (setup step
  `arch-v2-switch` through privd or the broker, or the daemon itself while it still runs as root)
  checks it again against its own copy of the owner's keys (the admin root along its rotation
  chain), refuses a stale (10 min), used or second order, installs `podman netavark aardvark-dns
  crun conmon catatonit docker-compose nftables zstd` with apt (Debian's signed archive), writes the
  compose drop-in, enables `podman.socket`, and writes the switch file last. Its record,
  `/var/lib/flagship/arch-v2-switch.json`, is where the daemon can't write.
- **Move.** The daemon restarts; the next start runs §4's move and puts the Rust units on (§2).
- **Trial.** Kept once the boot is healthy (tunnel and heartbeat, no Rust component on its
  fallback) and every app container that ran when the order came runs again within 20 minutes.
  Otherwise put back (setup step `arch-v2-settle`) with the reason in Activity: a failed move at
  once, three starts that never got healthy, an app that doesn't come back. Going back restores the
  switch file as it was, and §4's rollback brings Docker up on its own data. A revert is refused
  once the switch was kept or after 24 hours, so the daemon alone can't undo the owner's choice.
- **Resume.** A restart during the install finishes it from the same order at the next start; an
  install that fails leaves the switch file untouched and records why.

Not yet: the apps' screen and its order (iOS, Android, webapp), the Activity labels
(`server.stack.switch-started`, `server.stack.switched`, `server.stack.switch-reverted`), a run on a
real classic box (apt on an appliance without its lists; data written under Podman in copied
volumes does not go back to Docker), and a gym group.
