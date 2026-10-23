# GPU and WASI: what is built, what still needs hardware

Status: 2026-10-23, branch `arch/gpu-wasi`. Covers the software parts of
work packages G01, G02, G04 and G05 (`rust/crates/flagship-gpu`) and P04
(`rust/crates/flagship-wasi`) from `IMPLEMENTATION-PLAN.md` §§8.5, 9 and 10.

**Nothing here has run on a GPU.** It was built and tested on a macOS host
with no accelerator, against checked-in tool fixtures, a fake sysfs tree and
fake providers. Under §9.4 and the G03–G05 gates, mocks never qualify a
profile, so every hardware profile below is **unqualified** until it has a
receipt.

```sh
cd rust
cargo fmt --all --check
cargo clippy -p flagship-gpu -p flagship-wasi --all-targets -- -D warnings
cargo test -p flagship-gpu -p flagship-wasi     # 45 GPU tests, 19 WASI tests
```

## 1. `flagship-gpu`

Only the broker links this crate. Apps never see it, and nothing in it talks
to the network.

### 1.1 The device-provider interface (§9.5)

There are two halves. `provider::DeviceProvider` is the vendor half, one
implementation per backend. `manager::DeviceManager` is the lifecycle half,
and every step it takes goes through the journal.

| §9.5 verb | Where | Notes |
|---|---|---|
| enumerate capabilities | `DeviceProvider::enumerate`, `DeviceManager::refresh_inventory` | joins tool output with sysfs; a backend whose tool fails is reported unavailable, not guessed at |
| validate compatibility | `DeviceProvider::validate_compatibility`, `DeviceManager::validate` | the signed catalog decides; the inventory only says what the driver exposes |
| reserve | `DeviceManager::reserve` → `JournalStore::reserve` | one transaction, all devices or none |
| attach under an approved isolation profile | `DeviceManager::attach` | write-ahead `reserved → attached`, returns an `AttachPlan` |
| observe | `DeviceProvider::observe`, `DeviceManager::observe` | per device or per MIG partition; `Unknown` is never treated as idle |
| drain | `DeviceManager::drain`, `revoke_app` | stops the workload; ownership stays |
| release / quarantine | `DeviceManager::settle`, `reconcile` | release needs proof; anything short of proof quarantines or holds |

`IsolationProfile` has exactly two values: `gvisor-nvproxy` (NVIDIA only) and
`vm-passthrough`. There is no runc or raw-device variant, so no fallback to
one can be written.

### 1.2 Inventory and local IDs

- `sysfs::SysfsRoot::new(root)` reads `<root>/bus/pci/devices/*`: vendor,
  device, class, `driver` and `iommu_group` symlinks, `numa_node`,
  `boot_vga`, and the members of each IOMMU group from
  `kernel/iommu_groups/<n>/devices`. Tests build a fake tree in a temp dir.
  Accelerators are class 0x03 (display) or 0x12 (processing accelerator) from
  vendor 0x10de, 0x1002 or 0x8086.
- `ids::LocalDeviceId` is `gpu-` followed by the first 16 bytes of
  HMAC-SHA256(box key, `flagship/gpu-local-id/v1|<vendor>|<stable id>`). The
  stable id is the vendor UUID, or the PCI address when a card has none. It is
  consumed at enumeration and never stored. Tests check that serialized
  records don't contain the UUIDs. `LocalIdKey` prints as `<redacted>`.
- A device that is boot VGA, or that nvidia-smi reports as an active display,
  is `display_owned` and is never selected, reset or passed through.

### 1.3 Vendor providers

All three read output through `ToolRunner`. `PinnedTools` runs absolute paths
only, with an empty environment, fixed arguments, a 16 MiB output cap and a
deadline. `FixtureTools` serves checked-in files.

| Provider | Tool (fixture) | Reports | Isolation | Observe |
|---|---|---|---|---|
| `NvidiaProvider` | `nvidia-smi -q -x` (`nvidia-smi-q-x.xml`); DTD allowed, never fetched, node limit | model, PCI id, memory, driver, CUDA version, MIG mode and partitions (GI/CI, memory, CDI name `gpu:mig`), display | gVisor/nvproxy, VM | process list, split by MIG GI/CI |
| `AmdProvider` | `rocm-smi … --json` (`rocm-smi.json`), several key spellings | model, PCI id, VRAM, driver; ROCm version from the host install | VM only | `Unknown` until a pinned observer is qualified |
| `IntelProvider` | `xpu-smi discovery -j` and `-d N -j` (`xpu-smi-*.json`); falls back to `i915`/`xe`-bound PCI functions | model, PCI id, memory, driver; Level Zero version from the host | VM only | `Unknown` |

`DeviceRecord::check` refuses a record whose backend doesn't belong to its
vendor, so an AMD or Intel device can never be reported, selected or
approved as `nvidia-cuda`. AMD and Intel offer only VM passthrough because
gVisor documents no mediation for `/dev/kfd` or the Level Zero ioctls.

`topology::Topology::from_nvidia_topo` parses `nvidia-smi topo -m`
(`nvidia-topo-m.txt`). The AMD (`rocm-smi --showtopo`) and Intel (Xe Link)
matrices are not parsed yet; the broker can still fill `Topology` by hand.

### 1.4 CDI validation (`cdi.rs`)

`validate(spec, origin, policy, claim)` returns every violation, or a
`ValidatedCdi` holding only the claimed devices' qualified names and a
digest of the spec it checked. It refuses:

- `SpecOrigin::AppSupplied`, and a `HostTooling` generator not in the
  policy's pinned list;
- any device named `all` in the spec, and a claim for `all` or a wildcard.
  The broker's write path calls `CdiSpec::without_all()` on the generator's
  output before writing it to the root-owned spec directory;
- hooks that don't match a pinned `(hookName, path, args)` exactly, and any
  hook `env`;
- mounts that aren't read-only binds from an allowed host prefix, mounts
  with `..`, mounts onto `/`, `/proc`, `/sys`, `/dev`, `/data`, `/run` or
  `/var/run`;
- device nodes that are not in the claim's own nodes or the backend's
  shared control nodes, that remap a host path, or that are management or
  display nodes (`nvidia-cap1/2`, `nvidia-modeset`, `nvidia-uvm-tools`,
  `/dev/dri/card*`, `/dev/mem`, `/dev/vfio/*`);
- env keys outside the allowlist, any `LD_*`, `NVIDIA_VISIBLE_DEVICES`
  other than `void`, and `NVIDIA_DRIVER_CAPABILITIES` words the claim's
  capabilities don't grant (compute gives `compute,utility`; graphics and
  video are separate);
- extra GIDs, unknown CDI fields (serde `deny_unknown_fields`), and unknown
  CDI versions.

`check_spec_file` and `check_spec_metadata` require the spec file and its
directory to be root-owned, not writable by group or others, and not
symlinks. JSON specs only: generate with `--format=json`.

### 1.5 Signed compatibility catalog (`catalog.rs`)

`CatalogEnvelope { schema, keyId, serial, payload, signature }` carries the
payload as the exact signed text. The signed bytes are
`flagship/gpu-compat-catalog/v1|<keyId>|<serial>|sha256:<payload hex>`.
`VerifiedCatalog::open` checks them first, through the `CatalogVerifier`
trait, and only then parses. It refuses a serial below the box's last
accepted serial (rollback) and any entry that:

- has an image reference that isn't `name@sha256:<64 hex>`; any tag,
  `:latest` included, is refused, even when a digest follows it;
- lists `gvisor-nvproxy` for a non-NVIDIA backend, or without pinned runsc
  releases;
- claims hardware partitioning for anything but NVIDIA;
- leaves kernels, drivers, toolkits, CDI generators, isolation,
  capabilities or images empty.

`qualify` needs exact matches on the PCI device id (no carry-over across
models), the kernel, module signing when required, the driver, the
toolkit, the CDI generator, the profile, runsc (gVisor only) and every
requested capability. Graphics and video are separate from compute.

The production verifier (hybrid Ed25519 + ML-DSA per the PQ plan) belongs to
`flagship-crypto`. Tests use a SHA-256 stand-in.

### 1.6 Journal (`journal.rs`, `sqlite.rs`)

States: `requested → admitted → reserved → attached → running → draining →
released`, with `failed` and `quarantined` as outcomes:

```
requested → admitted | failed
admitted  → reserved | failed
reserved  → attached | draining | failed
attached  → running  | draining | failed
running   → draining | failed
draining  → released | quarantined | failed
failed    → released | quarantined
```

`JournalStore` is the trait and `SqliteJournal` the implementation
(rusqlite with bundled SQLite, WAL, `synchronous=FULL`, every mutation one
`BEGIN IMMEDIATE`). Device ownership lives in a `holdings` table written in
the same transaction as `admitted → reserved`, and is removed only by
`finish` (`released`, or `quarantined` plus rows in `quarantined_devices`).
A failed allocation keeps its devices until a settle proves them clean.
Clearing a quarantine takes a maintenance order reference. The `topology`
row keeps the inventory fingerprint, its generation and the last reconciled
generation. While they differ, `reserve` returns `ReconcileRequired`.

### 1.7 Policies, gangs and the queue

- `policy::admissible` is the one rule, and the journal runs it inside the
  reservation transaction:
  - **Exclusive**: nobody else on the device. This is the default.
  - **Partition**: one MIG partition. It conflicts with any whole-device
    holder and with the same partition. A MIG-enabled device can't be
    claimed whole.
  - **Cooperative**: needs the owner's trust domain and consent id, both
    taken from the approval and never from the app. All holders must be in
    that one domain. Two different apps never share when either one
    requires secrecy. At most 4 sharers, and the memory budgets may not
    exceed the device's memory. Memory is checked at admission only; it is
    not a hard partition.
- Gangs: one allocation means one app generation, so every GPU in a job
  belongs to the same generation. `topology::check_gang` checks `any`,
  `same-numa` or `peer-fabric`, and unknown links fail anything stricter
  than `any`. Selection searches combinations of free devices, and the
  journal re-checks all of them atomically. Multi-GPU jobs are
  exclusive-only.
- `queue::FairQueue`: bounded per app and in total, served round-robin, one
  head per app. `DeviceManager::pump` reserves in that order.
- Admission skips a device (or partition) that shows processes no
  allocation accounts for. `Unknown` doesn't block admission, but it always
  blocks release.

### 1.8 Reconciliation (`DeviceManager::reconcile`)

After a restart or a topology change:

| Journal says | Runtime says | Result |
|---|---|---|
| requested | any | closed (failed → released, nothing held); resubmit |
| admitted | any | re-queued |
| running | present | adopted, keeps running |
| any held state | unknown | held, device stays owned |
| reserved / attached / running | absent or present | drain (stop), then settle |
| draining / failed | any | settle |
| claim on a vanished device or changed partition | any | stop, quarantine every device of the allocation |

`settle` releases only when the runtime reports `Absent`, every claimed
device or partition observes `Idle`, and every provider's cleanup returns
`Proven`. The default `NoQualifiedCleanup` never proves anything, so until a
reset or scrub procedure has a hardware receipt, a device that ran a
workload is quarantined for maintenance. The heartbeat is stored but never
read as evidence.

### 1.9 Tests (`rust/crates/flagship-gpu/tests/`)

- `allocation.rs`:
  - double allocation, through the manager and straight at the journal;
  - a non-GPU app denied, as is an approval for another generation,
    backend or profile;
  - cross-app sharing refused (secrecy, trust domain, exclusive next to
    cooperative, memory oversubscription, no consent);
  - all-or-nothing gangs, including a journal-level mixed claim and a
    duplicate device;
  - revocation mid-job, held through slow stop, busy and unknown, then
    released;
  - unproven cleanup quarantines until maintenance clears it;
  - a crash after each of the 8 lifecycle steps, reconciled on a reopened
    SQLite file, never leaves a live workload on a free device;
  - a stale heartbeat never frees a device;
  - a MIG re-partition forces reconciliation, quarantines the moved
    partition's card and adopts the untouched one;
  - fair queue order;
  - attach injects exactly the reservation;
  - AMD is never CUDA, and passthrough is refused for a shared IOMMU group;
  - display-owned devices are never handed out;
  - the real nvidia-smi fixture picks the idle MIG partition.
- `inventory.rs`: the fake sysfs tree, all three vendor fixtures, UUIDs
  never serialized, per-partition observation, a failing tool observes
  `Unknown`, malformed output, pinned-tool path rules, the topology matrix.
- `cdi.rs`, `catalog.rs`: every rule in §1.4 and §1.5.

## 2. `flagship-wasi`

### 2.1 Engine

**wasmtime 49.0.2** (`default-features = false`, features `cranelift`,
`runtime`, `std`). wasmtime-wasi 49.0.2 has `default-features = false`,
feature `p1`, which pulls in wasmtime's `component-model` and `async`. The
`wat` crate 1.258.3 parses WAT, and tokio 1.53.2 (`rt`, `time`) runs it.
There is no `cache`, `pooling-allocator`, `threads`, `gc`, `wat`,
`profiling` or `parallel-compilation` feature. The engine turns off the
component model, memory64, multi-memory and stack switching, caps the
native stack at 512 KiB and turns on fuel and epochs.

### 2.2 The worker (`Worker::run`)

1. Bounded concurrency. `max_concurrent_runs`; a run makes at most one host
   call at a time, so this also bounds host calls. Past the bound the
   answer is `Busy`, not a queue.
2. The module's `sha256:` must equal the approved digest in the grant.
3. Compile in the worker, from `.wasm` (core-module magic and version) or
   WAT only, within `max_module_bytes`. `Engine::detect_precompiled` input
   is refused. `Module::deserialize` is `unsafe` and the crate is
   `unsafe_code = forbid`, so no precompiled artifact can be loaded.
   Components are refused.
4. Every import must be a `wasi_snapshot_preview1` function that the linker
   actually provides. Anything else, a socket-opening extension included,
   is `ImportNotGranted`.
5. WASI context: argv is `app` plus the granted args, the env is the
   granted vars only (nothing inherited), and preopens are only the
   broker-opened directories whose guest path and permissions the grant
   names. TCP, UDP and name lookup are off and every socket address check
   says no; p1 has no socket-creating call and no socket is preopened.
   stdin is an in-memory pipe; stdout and stderr are bounded memory pipes.
6. Limits: `StoreLimiter` (a `ResourceLimiter`) caps linear memory, table
   elements, instances (1), memories (1) and tables (4), and reports which
   limit stopped the run. Fuel is the CPU budget and yields every 50k units.
   An epoch ticker gives a wall-clock trap in guest code, and
   `tokio::time::timeout` cancels the run even while it is blocked in a
   host call (tested with a 60 s `poll_oneoff`).

### 2.3 Capability manifest (`WasiCapabilityManifest`)

The schema is `flagship/wasi-capabilities/v1`. It has the OCI manifest's
shape: `data.stores.files` (preopened RW at `/data`, `FLAGSHIP_FILES_DIR`
set), `data.stores.postgres`, `network.egress` (`host` or `{host, why}`),
plus `module.digest`, `args`, `env`, `data.scratch` (`/scratch`) and
`limits` (`memoryMiB`, `tableElements`, `fuel`, `wallTimeMs`,
`stdoutBytes`, `stderrBytes`). `WasiGrant::admit` checks the manifest
against the approved digest and the platform `Ceilings`. It refuses rather
than drops: unknown fields, `FLAGSHIP_*` env, bad env names, limits above
ceilings, Postgres (a WASI app has no sockets) and egress (brokered egress
isn't built).

### 2.4 Tests (`rust/crates/flagship-wasi/tests/worker.rs`, WAT fixtures)

- a normal program writes `out.txt` in `/data` and prints, from WAT and
  from binary;
- an infinite loop is stopped by fuel, and by the wall clock;
- a blocking host call is cancelled at the deadline;
- a memory bomb and an oversized initial memory are denied;
- table growth is denied;
- `../secret.txt` and `/etc/hosts` are denied through the preopen;
- an ungranted preopen, and no preopen at all, fail;
- network: `sock_accept` fails, `sock_open` and an `env` import are refused;
- the env and args are exactly the grant;
- a precompiled artifact is refused, even when its own digest is approved;
- garbage input, components and oversized modules are refused;
- a digest mismatch is refused;
- the concurrency bound returns `Busy`.

## 3. Integration with broker and runtime

Another agent is building `flagship-broker` and `flagship-runtime` now.
These are the seams; neither crate here edits them.

- **Broker owns `DeviceManager<SqliteJournal>`.**
  - Inputs:
    - the box `LocalIdKey` (from `flagship-keyd`);
    - the `VerifiedCatalog` opened with the `flagship-crypto` verifier and
      the last accepted serial;
    - `HostFacts` it measures: `uname -r`, module-signing state, runsc and
      CDI generator versions;
    - the providers built over `PinnedTools` with the endorsed release's
      tool paths;
    - `SysfsRoot::system()`, read-only.
  - It turns the owner's signed approval into a `GpuApproval`. Secrecy,
    trust domain and consent come from the approval, never the app. It
    builds `GpuRequest::from_manifest` from the manifest's `accelerator`
    field; `AcceleratorRequirement` has `deny_unknown_fields`.
  - CDI path: run the pinned generator into a root-owned directory, apply
    `without_all()`, write JSON, `check_spec_file`, then
    `cdi::validate(..., SpecOrigin::HostTooling, policy, claim)` with the
    claim built from the reservation's `DeviceClaim`s. Only then call
    `attach`.
  - Driver, MIG or device changes: `refresh_inventory`, then `reconcile`
    before admitting new work.
- **Runtime implements `manager::WorkloadRuntime`.**
  - `presence(allocation)` answers `Present`, `Absent` or `Unknown`, from
    the real container or VM state, never a cache.
  - `stop(allocation)` stops that workload.
  - It receives an `AttachPlan`:
    - CDI names and the spec digest for gVisor (refuse if the file's digest
      changed);
    - the VFIO function list for VM passthrough;
    - the catalog's digest-pinned image.
  - It records `attached` before creating anything (write-ahead) and calls
    `started` once the workload runs.
- **Host maintenance implements `provider::DeviceCleanup`** per backend
  once a reset or scrub procedure is qualified, and is the only caller of
  `clear_quarantine`.
- **WASI**: the runtime spawns the worker as its own process under the
  app's sandbox profile (no network namespace, only the app's directories
  bind-mounted, cgroup limits). The broker opens the preopen directories,
  builds `WasiGrant::admit` from the manifest and approval, and passes
  module bytes, never a path to a cached artifact. Worker errors are
  host-path free, but they still pass through `buildModelRedactor` before
  any model reads them (§10).

## 4. Outstanding hardware receipts

Every row is **open**. No GPU profile is qualified, and the catalog ships no
entries until these exist.

| # | Receipt | Needs |
|---|---|---|
| H1 | NVIDIA CUDA under gVisor/nvproxy | a supported NVIDIA card plus driver, runsc and toolkit from the catalog; vector-add numerics, PyTorch inference against expected outputs, OOM, two-job exclusion and queueing, a denied non-GPU app, broker restart, worker crash, revocation, full disk, CPU fallback (§9.4) |
| H2 | NVIDIA reset and scrub | a qualified `DeviceCleanup` proving no residue between security contexts; until then, quarantine after every job |
| H3 | AMD ROCm | a real ROCm device: numerical workload, `rocm-smi` output on the pinned ROCm, a qualified process observer, VM passthrough with reset |
| H4 | Intel Level Zero / oneAPI | a real Intel device: numerical workload, `xpu-smi` output, a qualified observer, VM passthrough with reset |
| H5 | MIG | a MIG-capable NVIDIA card: two concurrent jobs in separate partitions, fault isolation, re-partition, reconcile and quarantine on the real device, per-partition process accounting |
| H6 | Cooperative sharing / MPS | owner-selected sharing under quota on real hardware; disclose that the memory budget is admission only |
| H7 | Multi-GPU | a host with at least 2 GPUs and a peer fabric: `topo -m` on the real host, atomic gang admission, synthetic train, checkpoint and resume, cancellation, VRAM and disk exhaustion, fair competition with inference |
| H8 | VM passthrough | IOMMU and ACS on real hardware: VFIO bind, group safety, reset and recovery, refusal on shared groups, never a display-owned device |
| H9 | Headless graphics and video | EGL/OpenGL/Vulkan render and hardware encode and decode, verified against known output fixtures, with compute, graphics and video permissions kept separate |
| H10 | Cross-app isolation attempts | buffer, cache and descriptor access attempts across apps, and revocation during an active job, on each backend |
| H11 | Driver lifecycle | driver update as host maintenance: reboot and rollback, Secure Boot module signing and measurement |
| H12 | Honest unavailability | Apple Studio guests, ordinary hosted VMs and unsupported cards report unavailable hardware, checked on each |
| W1 | WASI on the box | the worker as a confined process on Debian 13 amd64 and arm64 under the runtime's sandbox profile, plus a WASI SDK language fixture (Rust `wasm32-wasip1`, built by the release, not WAT) |

## 5. Software gaps on this branch

- WASI:
  - no component model or WASI p2/p3; core p1 modules only. The pinned
    WASI version is preview1.
  - no brokered egress or secret capability yet (refused);
  - no backup, update or health integration (the runtime's lifecycle
    integration point in P04).
- GPU:
  - `amd-smi` is not parsed;
  - AMD and Intel topology are not parsed;
  - the AMD and Intel observers return `Unknown`;
  - graphics and video are modeled as capabilities and CDI permissions
    only;
  - training checkpoint integrity, dataset binding and max runtime belong
    to the AI/runtime jobs layer and are not in this crate;
  - the GPU driver maintenance pipeline (G01) is not started.
- Transitive dependencies in `Cargo.lock` were downgraded with
  `cargo update --precise` so that every registry crate is at least two
  weeks old (as of 2026-10-23). Direct dependencies are pinned with `=`.
