# Milestone 7 (GPU) drill on UpCloud, 2026-10-24

The `gpu-sim` live group (`tools/live-e2e/groups/release03/gpuSim.ts`, run alone with
`npx tsx tools/live-e2e/gpu-group-cli.ts gpu-sim`) on a throwaway Debian 13 amd64 VM (`de-fra1`,
`4xCPU-8GB`, label `flagship-env=gym`, deleted at the end). No GPU, no gym Worker, no account: it
proves the accelerator software on Linux, never a device. Tree: worktree `integrate/0.3-arch` at
`ced988cfe` plus this milestone's uncommitted changes.

## Result: 95 of 95 checks pass

- a throwaway Debian 13 VM is up
- `flagship-gpu` builds `--locked` with the pinned toolchain and its whole test suite passes on
  Linux (13 test binaries, 86 tests)
- `flagship-gpud self-test --podman /usr/bin/podman`: 91 of 91 (the 86-check simulated matrix:
  catalog 10, inventory 9, exclusive 10, residue 4, crash 4, MIG 8, cooperative 5, passthrough 6,
  media 8, training 13, driver maintenance 9; plus 5 real-Podman CDI checks: the raw spec with
  `all` refused, the sanitised spec validates, Podman injects exactly the claimed device node and
  the spec's env into a container, an unknown CDI name and `all` don't start)
- an ordinary hosted VM reports no accelerators (`available: false`, `no-accelerators`, catalog
  missing): H12 for UpCloud VMs

## Found and fixed by the runs

1. `tests/trust.rs` read `release/box-artifact-trust.json` the drill tarball didn't carry: the
   tarball now includes the release trust file and `release/gpu-catalog/`.
2. The Podman check ran `podman run … --rootfs / --device …`: `--rootfs` is a flag whose path is
   the image argument, and `/` as a rootfs fails `pivot_root`. It now builds a static-busybox root
   (`busybox-static`) and passes the flags before `--rootfs <dir>`. Reproduced and confirmed on a
   second throwaway VM (deleted).

Run 1: 1 of 2 (the trust-file test). Run 2: 94 of 95 (the Podman check). Runs 3 and 4 (after the
broker GPU run shape and the VFIO CDI kind): 95 of 95.
