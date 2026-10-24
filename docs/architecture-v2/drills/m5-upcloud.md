# Milestone 5 drill on UpCloud (2026-10-23/24)

One throwaway Debian 13 amd64 VM, `arch-drill-m5-a` (UpCloud `de-fra1`, plan `4xCPU-8GB`, 60 GB
MaxIOPS, label `flagship-env=arch-drill`), created from the plain Debian 13 template through the
UpCloud API with the token the gym tooling reads (`~/.config/flagship/upcloud-token`). No gym
Worker, no `.com`, no account: the drill drives the daemon's own modules directly
(`tools/arch-drills/m5/drill.ts`) on a tree laid out as an installed release by
`tools/arch-drills/m5/setup-box.sh` (pinned Node, Rust built `--locked` on the box, PINS.json as
the artifact builder writes it). Tree: `feat/architecture` at `812ee793b`, plus the fixes the
drill found (committed after it, listed below).

Versions on the box: kernel 6.12.101+deb13, Podman 5.4.2, netavark 1.14.0, gVisor
release-20260921.0, nftables 1.1.3, cryptsetup 2.7.5, rustc 1.99.1, Docker 26 (migration source).

## Result: 57 of 57 checks pass

Every phase was re-run after its fixes; the list is the final run.

- **migrate**: boot chose podman
- **migrate**: marker
- **migrate**: image moved
- **migrate**: files volume rebound to the same loop image
- **migrate**: files volume data readable under podman
- **migrate**: plain volume copied
- **migrate**: docker stopped and disabled
- **migrate**: docker data kept
- **migrate**: second boot does not migrate again
- **apps**: gvisor registered with podman and its test container ran
- **apps**: egress gateway enforced
- **apps**: bridge isolation table installed
- **apps**: deployed under runsc
- **apps**: the app's kernel is gVisor
- **apps**: hardening: read-only root, no effective capabilities, no-new-privileges, pids limit
- **apps**: migrated files volume mounted at /data
- **apps**: per-app quota: writing past the files limit fails with ENOSPC
- **apps**: egress: an allowed host is reached through the gateway
- **apps**: egress: a host not on the list is refused
- **apps**: egress: a bare IP is refused
- **apps**: egress: an app with an empty list reaches nothing
- **apps**: icc: app to app on the bridge is dropped
- **apps**: icc: without the table the same request goes through (the table is what isolates)
- **apps**: icc: dropped again once the table is back
- **apps**: image save then load round trip (app copy path)
- **rust**: TS keyd installed and serving
- **rust**: all three components on their Rust binaries under systemd
- **rust**: Rust keyd serves the same box key from the same state (wire v1)
- **rust**: keyd's process is the Rust binary
- **rust**: core runs unprivileged and fenced
- **rust**: broker v1 runs the engine op under podman
- **rust**: broker v1 still refuses a privileged container
- **rust**: core shadow agrees with the TS controller
- **rust**: core shadow notices a stopped app
- **broken**: a binary that is not the pinned one is not run (broker idles in fallback)
- **broken**: the update gate sees the regression
- **broken**: a boot does not restart-loop the fallback
- **broken**: the right binary comes back
- **broken**: a crashing keyd binary falls back to the TS keyd after three tries
- **broken**: the box keeps its keys: the TS keyd answers
- **broken**: the update gate fails that release
- **broken**: restored release: keyd back on Rust
- **rollback**: bad release: keyd falls back, the box keeps running
- **rollback**: boot gate: the bad release is not healthy
- **rollback**: boot gate: rolled back to the last good release
- **rollback**: after the rollback keyd runs the good release's Rust binary
- **rollback**: and the gate is healthy again
- **luks**: clean: specializer finishes
- **luks**: clean: the volume key changed
- **luks**: clean: the owner's data is intact after re-encryption
- **luks**: clean: exactly one key slot
- **luks-resume**: powercut: the first run never claimed success
- **luks-resume**: powercut: the header records an unfinished re-encryption
- **luks-resume**: powercut: specializer finishes (resumed)
- **luks-resume**: powercut: the volume key changed
- **luks-resume**: powercut: the owner's data is intact after re-encryption
- **luks-resume**: powercut: exactly one key slot

## What the drill found and fixed

1. **netavark creates a bridge only when the first container joins** (and removes it with the
   last), and gives an `--internal` network no gateway address. The egress gateway could not bind
   at boot (`EADDRNOTAVAIL`), so apps had no DNS. Fixed: networks are `mode=unmanaged` and the
   daemon makes each bridge with its address; `--internal` becomes a label (the firewall's forward
   chain fences the build bridge). (`d4c2ba560`)
2. **The TS keyd unit could never start on a real box.** Its `MemoryDenyWriteExecute=yes` kills
   Node at startup (V8 JIT). This predates milestone 5; nothing had run the unit. Fixed with
   `node --jitless`, keeping the sandbox. The Rust keyd needs no change.
3. **The selector counted deliberate restarts as failures** and let an earlier binary's good run
   excuse a new binary's crashes. Fixed: failures come from systemd's `SERVICE_RESULT` in
   ExecStopPost; a new binary starts with no history.
4. **A broker test wrote to a socket the broker had closed** (EPIPE on Linux only). Fixed.
5. **cargo deny**: new advisory RUSTSEC-2026-0387 (crypto-bigint). 0.7 moved to 0.7.6; 0.5.5 is
   test-only and ignored with a reason.
6. **Killing cryptsetup mid re-encryption is not a power cut**: SIGKILL leaves the dm overlay
   suspended and the root's I/O hangs until reboot. A real power cut (sysrq `b`, no sync) was then
   drilled: the next open recovered the hotzone and the specializer resumed and finished with the
   data intact. If the specializer's cryptsetup is killed on a live box, the box needs a reboot;
   that is acceptable (it is mid first boot) but is now a known behaviour.

## Gates run on the box

- `packages/keyd/tests/rustBackend.test.ts` against the release-built Rust keyd: 20/20 (the first
  Linux run of the cross-check).
- `cargo fmt --check`, `clippy --all-targets -D warnings`, `cargo test --workspace --locked`:
  336 passed, 0 failed. `cargo deny check`: ok.
- Linux-only ignored tests (`-- --ignored linux_`): 4 passed, 1 failed:
  `linux_docker_reports_gvisor_and_lists_only_platform_workloads` expects runsc registered with
  Docker; on this box Docker had been migrated off and runsc is registered with Podman only. Not
  re-run on a Docker box.

## Not covered

- arm64; bare metal; a real appliance or ISO install with Podman (none built); a box registered
  with a `.com` (gym or production); the daemon process itself end to end (the drill composes its
  modules; the full daemon needs an account and the gym, which this milestone did not use).
- Data services (Postgres) through `podman compose` were not brought up.
- Core in effects mode (not built), broker typed ops with a capability authority (none pinned).

## Teardown and spend

The server was stopped and deleted with its storage (`DELETE /server/<uuid>?storages=1`, HTTP 204)
on 2026-10-24 04:45 UTC. Afterwards the account lists one server, `flagship-demo-playstore-test-0725-…`
(never touched), and no private storage named `arch-drill`. About 1.1 hours of `4xCPU-8GB`:
roughly €0.10.
