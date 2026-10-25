# Accelerators (G01–G05): what is built, how it is tested, what needs hardware

Status: 2026-10-24, milestone 7, worktree `integrate/0.3-arch`. Supersedes the GPU half of
`gpu-and-wasi.md` (§1, §3 GPU bullets, §4 H-rows, §5 GPU gaps), which stays as the milestone-6
snapshot. Plan: `IMPLEMENTATION-PLAN.md` §9, §10, §13.1 rows G01–G05.

**Owner decision (2026-10-24):** everything ships in 0.3; the software is complete and tested
against faithful simulated devices; hardware the owner hasn't bought (AMD, Intel, MIG, multi-GPU)
is tested after the release. **Nothing here has run on a GPU yet.** Under §9.4 a profile is
qualified only by a hardware receipt; the catalog refuses an entry without one, so the box treats
every real device as unqualified (no GPU app starts on it) until the owner signs a catalog built
from receipts. That is the intended state at release: CPU apps unaffected, GPU apps honest.

```sh
cd rust
cargo fmt --all --check
cargo clippy -p flagship-gpu --all-targets -- -D warnings
cargo test -p flagship-gpu                      # 86 tests; one runs the 86-check simulated matrix
./target/debug/flagship-gpud self-test           # the matrix as JSON (exit 1 on any failure)
npx vitest run packages/server-daemon/tests/gpu.test.ts scripts/gpu-catalog.test.ts
npx tsx tools/live-e2e/gpu-group-cli.ts gpu-sim  # the same on a throwaway UpCloud Debian 13 VM
```

## 1. The pieces

```
app manifest v2 `accelerator` ─┐                     ┌─ AI tool broker (AI01): claim/attach/release
  (admin-approved digest)      ▼                     ▼
  server-daemon gpu/broker.ts  AcceleratorBroker ── gpud socket (/run/flagship-gpu/gpu.sock)
  AppRunner hook (serviceRunner.ts)                    │  privd framing, peer uid allowlist
                                                       ▼
  flagship-gpud (root) ── GpuService (service.rs) ── DeviceManager + SqliteJournal
        │  catalog (signed, release trust) · CDI write path · VFIO · MIG · coop ledger · maintenance
        ▼
  providers: NVIDIA (nvidia-smi, nvidia-ctk) · AMD (amd-smi/rocm-smi, KFD, DRM fdinfo) · Intel (xpu-smi, DRM fdinfo)
```

| Module | Work package | What it does |
|---|---|---|
| `catalog.rs` | G01 | The signed catalog: entries pin model (PCI ids), kernel, module signing, driver, toolkit, CDI generator, runsc or Kata, isolation, capabilities, graphics APIs, video codecs, images by digest, **driver packages by SHA-256**, the **cleanup procedure**, and **hardware receipts** (an entry without one is refused). Driver advisories withdraw a driver (admission pauses, CPU apps keep running). |
| `catalog_trust.rs` | G01 | Who signs and how the box checks: the box-artifact release-key model (`release/box-artifact-trust.json`): a threshold of the release signers' Ed25519 keys (YubiKey) over `flagship/gpu-compat-catalog/v1|<key>|<serial>|sha256:<payload>`, and once `pq.keyIds` is filled, each counted signer's hybrid companion over `flagship/gpu-compat-catalog/v2|…|<keyId>` under a `release-key` binding for `flagship-gpu-catalog`, through `flagship-crypto`'s strict critical-signature gate. Serial floor kept in gpud's state (no rollback). |
| `scripts/gpu-catalog.mjs` | G01 | `build` (matrix → payload, only receipted, exact profiles, receipt SHA-256 pinned), `sign` (one signer per run, k-of-n; `--pq` opens the YubiKey-encrypted release ML-DSA key like `pq-release-key.mjs`), `verify` (the box's rules). Cross-checked: a catalog it signs verifies in Rust (`tests/trust.rs`). |
| `release/gpu-catalog/matrix.json` | G01 | The exact qualification matrix (5 profiles), every one `unqualified` until its receipts exist. |
| `cdi.rs`, `cdi_gen.rs` | G01 | Validation (milestone 6) plus the write path: pinned `nvidia-ctk cdi generate`, `sanitized()` drops `all` and every display/management node (`/dev/dri/card*`, `nvidia-modeset`, `nvidia-uvm-tools`) and their symlink hooks, atomic root-owned write, re-read and digest check before each validation. The hook allowlist is built from the inventory (one `create-symlinks` per render node, `update-ldcache` for the driver's library dir). Regenerated on every inventory refresh. |
| `maintenance.rs` | G01 | The driver pipeline: proposed → staged (SHA-256 of every `.deb`) → draining (admission paused) → installed (previous versions recorded, reboot) → verifying (driver, module signer under Secure Boot, catalog qualification, numerical smoke report) → committed, or rolled back (and `failed` with admission paused if the rollback doesn't verify). SQLite, survives the reboot. gpud ops `gpu.maintenance.*`. |
| `journal.rs`, `sqlite.rs`, `manager.rs`, `policy.rs`, `queue.rs` | G02 | Milestone 6's exclusive claim journal and fair queue, plus: admission pause, `cancel`, `drain_all`, provider topology, queue snapshot, and a cooperative sharer leaving a device its domain still uses (only its holding goes; the last one out settles the device in full). |
| `attach.rs` | G02 | Engine arguments for Docker (CDI feature) and Podman alike: `--runtime=runsc-nvproxy --device nvidia.com/gpu=<n>` or `--runtime=kata-vfio --device flagship.vfio/group=<g>` (gpud writes a CDI spec for the VFIO groups it bound, so no argv ever carries a `/dev` path), the allocation label, share budgets; `check_gpu_args` is the closed shape (no `--gpus`, `--privileged`, raw `/dev`, mounts, other env, second runtime). Runtime registrations for `daemon.json`, `containers.conf` and the runsc `--nvproxy` wrapper. |
| `scrub.rs`, `host.rs` | G02 | Residue between tenants: the catalog's procedure (`flagship-scrub-v1`, optional FLR or MIG recreate) runs the pinned scrub image; `judge` requires ≥95 % coverage, the pattern read back and zero canaries after. Anything less quarantines. Real adapters: the engine as runtime and pid owner, the scrub image under the device's qualified profile, apt/dpkg/modinfo/systemd. |
| `numerics.rs`, `tools/gpu/` | G02–G04 | Fixtures and check workloads: vector add (CUDA, HIP, SYCL; bit-exact), PyTorch MLP (1e-4), scrub/canary (CUDA), headless EGL render, NVENC/VAAPI/QSV round trip, DDP training. |
| `vendor/amd.rs`, `vendor/intel.rs`, `observe.rs` | G03 | amd-smi (list/static/process) preferred over rocm-smi; rocm-smi `--showtopo` (XGMI); xpu-smi ps and topology (Xe Link); kernel observers from documented formats: KFD `/sys/class/kfd/kfd/proc/<pid>/vram_<gpu_id>` mapped through topology `location_id`, and DRM fdinfo (`drm-driver`, `drm-pdev`, `drm-client-id`). Nothing readable is `Unknown` (the device stays held). |
| `vfio.rs` | G03 | Passthrough qualification (IOMMU on, group in DMA translation not identity, group = this card's functions only, FLR/PM reset on every function, no display) and binding: `driver_override` → unbind → `drivers_probe`, `/dev/vfio/<g>` checked; release resets each function and returns it to its host driver. |
| `mig.rs` | G04 | `nvidia-smi mig -lgip` parsing, layout planning (held devices, counts, memory), broker-only apply; the inventory change moves the generation and forces reconcile. Partition claims use `/proc/driver/nvidia-caps/mig-minors` for their device nodes. |
| `coop.rs` | G04 | Cooperative time slicing with limits: share limits (compute %, memory) checked to fit the device; `pmon` + `compute-apps` attributed to allocations through the runtime's pid owner; memory over budget twice or time over share three windows → revoked. Budgets are admission plus revocation, not hardware isolation, and say so. |
| `media.rs` | G04 | Render and transcode jobs: graphics, encode and decode are separate permissions; output verified against `flagship-test-scene/v1` (PPM, per-channel tolerance) and `flagship-test-clip/v1` (YUV 4:2:0, PSNR ≥ 30 dB). |
| `jobs.rs` | G04/G05 | One supervisor for inference, render, transcode and training jobs on the one allocator: max runtime, disk budget, cancellation, revocation with the app, verification failures fail the job. |
| `safetensors.rs`, `training.rs` | G05 | Checkpoints are safetensors only (pickle/zip refused, header and offsets bounded and contiguous). Checkpoint manifests carry an HMAC over job, app installation and generation, dataset digest, step and every file digest; resume takes the newest one that verifies for exactly that binding. Disk budget enforced before a write. A deterministic data-parallel synthetic trainer proves cancel-and-resume ends bit-identical to an uninterrupted run. Gang admission is atomic in the journal; `peer-fabric` needs real NVLink/xGMI/Xe Link links. |
| `sim.rs`, `testkit.rs`, `selftest.rs`, `podman_check.rs` | all | The simulated host (below), test signers and catalogs, the 86-check matrix, and a real Podman CDI injection. |
| `service.rs`, `bin/flagship-gpud.rs` | all | The broker process: JSON ops on a Unix socket (privd framing, `hello` first, kernel peer uid allowlist, 1 MiB frames), a 2 s ticker (fair-queue pump, max runtime, held settles, cooperative sampling); CLI `serve`, `probe`, `self-test`, `verify-catalog`, `verify-report`, `reference-clip`, `verify-render`, `verify-transcode`. |

## 2. The allocator API (for apps, the AI tool broker and the screens)

gpud ops (`service.rs`), all JSON, unknown fields refused:

| op | args | answer |
|---|---|---|
| `gpu.inventory` | | devices (local id, vendor, backend, model, memory, capabilities, display, partitions, qualified profiles or reasons, passthrough verdict, quarantine, holders), unavailable backends, topology links, generation, admission pause, catalog status, CDI status |
| `gpu.status` | | open allocations, the fair queue per app, admission pause |
| `gpu.claim` | `allocationId, app{appId,installationId,generation}, operationId, container` (the one container it may run in), `requirement` (manifest `accelerator`), `approval` (owner-resolved), optional `maxRuntimeMs, share{computePercent,memoryMib}, userspace` | `state` (`reserved` or `admitted` = queued), queue position |
| `gpu.attach` | `allocationId, engine` | `{allocation, args, cdiSpecDigest, image}` |
| `gpu.started` / `gpu.heartbeat` | `allocationId, nowMs` | |
| `gpu.release` | `allocationId[, reason]` | settle: `released`, `quarantined: …`, `held: …` |
| `gpu.settle`, `gpu.revokeApp`, `gpu.reconcile` | | |
| `gpu.quarantine.clear`, `gpu.mig.profiles`, `gpu.mig.apply` | maintenance only (`maintenanceRef`) | |
| `gpu.maintenance.status/propose/advance` | owner's order; `advance` takes the smoke report after the reboot | |
| `gpu.selftest` | | the simulated matrix |

Daemon side (`packages/server-daemon/src/gpu/`):

- `AcceleratorBroker` (`broker.ts`): `inventory()` (honest `available:false, reason:"no-gpu-service"`
  without gpud), `status()`, `claim()`, `waitReserved()`, `attach()` (re-checks the argument
  shape), `started()`, `release()`, `revokeApp()`, `selfTest()`. **This is what AI01 uses** for
  local inference, training, render and transcode jobs.
- `requirementFromManifest`, `approvalForApp` (secrecy, trust domain and consent from the owner,
  never the manifest; AMD/Intel under `sandbox` refused, not weakened), `gpuIsolationFor`,
  `checkGpuArgs`.
- `AppAccelerators`: the AppRunner hook. `AppSpec.accelerator` (an admin-approved request) is claimed
  at deploy, waits fairly in the queue, attaches, and the container runs under the GPU runtime with
  exactly its devices (the egress fence check still runs); released at stop; the held allocation is
  remembered durably so a restarted daemon releases it first. No GPU (or no gpud): runs on CPU only
  when the manifest says `cpu-if-supported`, otherwise refused with a sentence.
- Owner screen API: `GET /api/screens/accelerators` (devices with state free/in-use/quarantined/
  unqualified/display and holder app ids, the queue per app, admission pause, catalog status),
  `POST /api/screens/accelerators/stop {allocationId}`, `POST /api/screens/accelerators/self-test`
  (companions refused for both POSTs).
- `installGpud`: on a box with an NVIDIA/AMD/Intel display or accelerator function, copies the
  release's `installer/rust/flagship-gpud` when its SHA-256 equals PINS.json's, writes
  `flagship-gpud.service` with the host's tool paths and measured versions, enables it. The box
  artifact builds `flagship-gpud` with the other Rust binaries.

## 2a. The privileged brokers (privd and the Rust broker)

Since 0.3 the daemon runs unprivileged: every `docker`/`podman run` goes through privd
(`packages/privd/src/policy.ts`) or the Rust broker (`flagship-broker` `policy.rs`), which parse
the argv like the CLI and require `--runtime runsc` and refuse `--device`/`--gpus` on an ordinary
run. A GPU run is the one narrow exception, verdict-identical in both:

- it carries exactly one `--label flagship.gpu.allocation=<id>`, and `<id>` must be an
  allocation gpud **attached**, read from gpud's root-owned `/run/flagship-gpu/run-claims.json`
  (`{schema: "flagship/gpu-run-claims/v1", claims: [{allocationId, appId, container, runtime,
  devices}]}`; a file not root-owned, or writable by group/others, counts as no claim);
- `--name` is the container that claim was attached for, the subcommand is `run`;
- `--runtime` is exactly the claim's runtime (`runsc-nvproxy` or `kata-vfio`, nothing else);
- `--device` values are exactly the claim's CDI devices (`nvidia.com/gpu=<n>[:<k>]` or
  `flagship.vfio/group=<g>`), each once, all of them; never a `/dev` path;
- everything else is the ordinary run's rules (no host paths, no capabilities, not root, a named
  network, no `--gpus`, no `--privileged`).

Shared corpus: `packages/privd/tests/corpus.ts` (3 allowed shapes, 24 hostile ones: a device the
allocation doesn't hold, another app's claim, a raw `/dev/nvidia0` or `/dev/vfio/12`, unlisted
runtimes `runc`/`runsc`/`kata`/the other GPU runtime, unknown or malformed allocation ids, two
labels, `--gpus`, `--privileged`, host mounts, root, host network, `create`, and a claim-less
box), each under Docker and Podman; `vectors/v1-policy.json`, `conformance.test.ts`,
`privd_conformance.rs`. A daemon test runs the AppRunner's real GPU argv through privd with and
without the claim.

gpud is the only writer of the claims file and of the CDI specs (`/var/run/cdi`), and does driver
maintenance itself as root. The daemon's one root need, installing gpud, is the release's root
setup step `gpu-broker` (`setup.ts`, allowed in both brokers' `SETUP_STEPS`); an unprivileged
daemon reaches gpud's socket by its kernel uid (`--allow-uid` of the `flagship` user).

## 3. Simulated devices

`sim.rs` renders, from one mutable state, everything the real path reads:

- sysfs: `bus/pci/devices/<addr>/{vendor,device,class,numa_node,boot_vga,reset_method,reset,driver_override,driver→,iommu_group→,drm/renderD*}`,
  `kernel/iommu_groups/<g>/{type,devices/*}`, KFD topology nodes (`gpu_id`, `properties` with
  `location_id`/`domain`) and `class/kfd/kfd/proc/<pid>/vram_<gpu_id>`;
- `/proc/<pid>/fdinfo/*` DRM client records, `/proc/driver/nvidia-caps/mig-minors`, `/dev/nvidia*`,
  `/dev/vfio/<g>` while a group is on vfio-pci;
- tool output in the vendors' formats: `nvidia-smi -q -x` (with MIG devices and per-process GI/CI),
  `topo -m`, `--query-compute-apps` CSV, `pmon`, `mig -lgip`, the `nvidia-ctk` CDI spec (with the
  `all` device, card nodes and management nodes a real one has); `rocm-smi` JSON and `--showtopo`;
  `amd-smi list/static/process`; `xpu-smi discovery/-d/ps/topology`;
- actions that change the state like the real tools: MIG mode/create/destroy (refused while busy),
  GPU reset, sysfs `driver_override`/`unbind`/`drivers_probe`/`reset` writes;
- a memory model of residue canaries per device and partition, a scrub runner that clears it (or
  doesn't, on a device marked broken), workloads that crash and leave processes until reaped,
  an unknown runtime, failing tools, unplugged devices, apt/dpkg with tamperable packages, Secure
  Boot signers and reboots.

Presets: RTX 4090 (with its audio function), H100 (NVLink islands, NUMA), A100 MIG, MI210 (xGMI),
RX 7900 driving a display, Flex 170, Arc A770 (Xe Link).

The self-test (86 checks, 11 groups: catalog, inventory, exclusive, residue, crash, mig,
cooperative, passthrough, media, training, driver-maintenance) runs through gpud's own JSON ops.
With `--podman` it also writes a validated spec for a simulated kind (`flagship.sim/gpu`) and has
real Podman inject it into a container (default runtime: gVisor mediates only real NVIDIA devices).

## 4. Hardware receipts (all open)

Runbooks: `gpu-runbooks/` (one per vendor and topic). Executable steps: `tools/arch-drills/m7/gpu-real.sh`;
gym group `gpu-real` runs them over SSH on a GPU host (`GYM_GPU_SSH`) or an UpCloud GPU plan
(`GYM_UPCLOUD_GPU_PLAN`) and skips with the reason otherwise.

| # | Receipt | Hardware | Runbook |
|---|---|---|---|
| H1 | CUDA under gVisor/nvproxy: vector add, PyTorch, exclusion and queueing, non-GPU app denied, restart, crash, revocation, full disk, OOM, CPU fallback | owner's PC (NVIDIA), USB boot | nvidia-cuda.md |
| H2 | residue scrub between tenants (enables `cleanup: flagship-scrub-v1`) | same | nvidia-cuda.md |
| H3 | AMD ROCm numerics, observer | AMD (not procured) | amd-rocm.md |
| H4 | Intel Level Zero numerics, observer | Intel (not procured) | intel-level-zero.md |
| H5 | MIG partitions, fault isolation, re-partition, accounting | A100/H100 (not procured) | nvidia-mig.md |
| H6 | cooperative sharing under quotas | NVIDIA | nvidia-mig.md |
| H7 | multi-GPU gang, train/resume, cancel, exhaustion, fair competition | 2+ GPUs, NVLink (not procured) | multi-gpu-training.md |
| H8 | VFIO passthrough, group safety, reset, recovery | IOMMU host with AMD/Intel | vm-passthrough.md |
| H9 | headless render, encode/decode | owner's PC (NVIDIA) | nvidia-cuda.md |
| H10 | cross-app access attempts, revocation mid-job | each backend | nvidia-cuda.md, vendor runbooks |
| H11 | driver update, reboot, rollback, Secure Boot signing | owner's PC | driver-maintenance.md |
| H12 | honest unavailability | any non-GPU VM (done in the `gpu-sim` group), Studio guests, unsupported cards | — |

## 5. What is still open (software)

- **Approvals:** gpud trusts the daemon's resolved `GpuApproval` (peer-authenticated, like privd v1).
  When the core's capability issuer exists (R02), a signed GPU capability should replace it.
- **Owner UI:** the screen API exists; no client renders it yet (the AI02 job UI is the natural
  home). Strings will need `tr()` / `String(localized:)` / `i18n/android` like every screen.
- **Cooperative sharing state** (share limits, started times) is in gpud's memory: after a gpud
  restart a running sharer keeps its device but its budgets are not enforced until it is claimed
  again.
- **VM jobs** run through Kata's VFIO support; the Kata release itself is not pinned or installed by
  the box yet (the catalog's `vmRuntimes` and `--vm-runtime-version` carry it once chosen).
- The NVIDIA hook allowlist is per generator version; the first H1 receipt fixes the exact hook set
  `nvidia-ctk 1.18` emits (a hook the policy doesn't pin is refused, never run).
