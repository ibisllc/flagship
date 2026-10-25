# GPU hardware runbooks

What to run on each kind of hardware, and what proves it. Every runbook ends in a receipt
(`../gpu-receipts/`), and only a receipt lets `scripts/gpu-catalog.mjs build` put a profile into
the signed catalog the box loads. Mocks and the simulated host never qualify anything (plan §9.4).

| Runbook | Receipts | Hardware | Status |
|---|---|---|---|
| [nvidia-cuda.md](nvidia-cuda.md) | H1 CUDA, H2 residue scrub, H9 render/video, H10 isolation attempts, H11 driver lifecycle, H12 honesty | the owner's Windows PC (NVIDIA), booted natively from USB | ready to run |
| [nvidia-mig.md](nvidia-mig.md) | H5 MIG, H6 cooperative sharing | A100/H100-class MIG card | hardware not procured |
| [multi-gpu-training.md](multi-gpu-training.md) | H7 multi-GPU gang, train/resume | 2+ NVIDIA GPUs with NVLink on one host | hardware not procured |
| [amd-rocm.md](amd-rocm.md) | H3 ROCm, H8 passthrough (AMD) | ROCm-listed AMD GPU on an IOMMU host | hardware not procured |
| [intel-level-zero.md](intel-level-zero.md) | H4 Level Zero, H8 passthrough (Intel) | Intel Flex/Max/Arc on an IOMMU host | hardware not procured |
| [vm-passthrough.md](vm-passthrough.md) | H8 for any vendor | IOMMU host with ACS and FLR | with AMD/Intel |
| [driver-maintenance.md](driver-maintenance.md) | H11 | any qualified host with Secure Boot | with nvidia-cuda |

## The common flow

1. **Boot** the target as a Flagship box from this release (USB on metal; never a Studio VM: Studio
   can't pass a GPU through), or as a plain Debian 13 for the drill scripts. Disposable gym
   account; never `playstore-test-0725`.
2. **Build and test** on the device: `tools/arch-drills/m7/setup-box.sh <src.tar.gz>` (flagship-gpu
   `--locked` with the pinned toolchain, its whole test suite on Linux, flagship-gpud installed).
   The `gpu-real` gym group does this over SSH: `GYM_GPU_SSH=root@<host> CUDA_DEVEL_BASE=… TORCH_BASE=…
   npx tsx tools/live-e2e/gpu-group-cli.ts gpu-real`.
3. **Pin the check images' bases** by digest (`podman pull <image>`, then
   `podman image inspect --format '{{.Digest}}'`; record `name@sha256:<digest>`). Never a tag.
4. **Run** the vendor's `tools/arch-drills/m7/gpu-real.sh` steps. Each writes raw output and a
   `summary.json` row per check into the receipt directory.
5. **Write the receipt** `docs/architecture-v2/gpu-receipts/<id>.md`: commit, host facts, the
   summary table, and the raw files (attach or inline). Fill the matrix profile's exact fields
   from what the receipt measured (`pciDeviceIds`, kernel, driver, toolkit, generator versions,
   image digests, driver package digests).
6. **Sign the catalog** (owner, on the Mac, real YubiKeys):
   ```sh
   node scripts/gpu-catalog.mjs build --matrix release/gpu-catalog/matrix.json \
     --receipts docs/architecture-v2/gpu-receipts --serial <previous + 1> --out /tmp/payload.json
   node scripts/gpu-catalog.mjs sign --payload /tmp/payload.json --out release/gpu-catalog/catalog.json   # each signer, k-of-n
   node scripts/gpu-catalog.mjs sign --payload /tmp/payload.json --out release/gpu-catalog/catalog.json --pq   # once release/box-artifact-trust.json pq.keyIds names the release key
   node scripts/gpu-catalog.mjs verify --catalog release/gpu-catalog/catalog.json
   ```
   The box reads `release/gpu-catalog/catalog.json` with `release/box-artifact-trust.json` from its
   own endorsed release and refuses a serial older than the newest it accepted.

## What proves what

- A device is **enumerated** when flagship-gpud's inventory lists it with the exact PCI id, driver
  and toolkit; `nvidia-smi` answering is not acceptance.
- **Compute** is proven by the vector-add report matching bit for bit and the PyTorch MLP matching
  within 1e-4, run under the qualified isolation profile with exactly the claimed CDI device.
- **Residue** is proven by the scrub report: the scan must see a previous tenant's canaries before
  the scrub (or the scan proves nothing), cover ≥95 % of the memory, read the pattern back, and
  find zero canaries after. Until H2 exists the catalog entry says `cleanup: none` and every used
  device is quarantined for maintenance.
- **Graphics/video** are proven only by their own outputs (render PPM vs the reference scene,
  decoded clip PSNR ≥ 30 dB), never inferred from compute.
- **Isolation**: a container without the CDI device gets no GPU; a second app is refused while the
  first holds the device; revocation mid-job drains and settles; a crash leaves the device held
  until the driver reaps the process.
