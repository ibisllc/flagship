# NVIDIA CUDA under gVisor/nvproxy (H1, H2, H9, H10, H11, H12)

**Hardware:** the owner's Windows PC with its NVIDIA card, booted natively from a USB stick as a
Debian 13 Flagship box (a Studio VM can't reach the GPU). Record `lspci -nn | grep -i nvidia`
first: the matrix entry `nvidia-owner-pc-debian13` needs the exact PCI device id.

**Software under test:** this release's flagship-gpud, `nvidia-driver` from Debian non-free (the
version the receipt records), nvidia-container-toolkit (`nvidia-ctk`), gVisor runsc
`20260921.0` with `--nvproxy`, Podman with the `runsc-nvproxy` runtime and CDI from
`/var/run/cdi`.

## Steps

```sh
# on the box, as root (debug access), with this tree unpacked by setup-box.sh
bash /opt/flagship-m7/tools/arch-drills/m7/gpu-real.sh prepare-nvidia     # driver, toolkit, runsc-nvproxy
reboot
# The four bases are pinned by digest in tools/gpu/bases.env, which gpu-real.sh reads (CUDA 12.4 images: Debian 13's
# own nvidia-driver is 550.163.01, which serves CUDA up to 12.4, and a CUDA 13 image refuses to start on it).
# Export CUDA_DEVEL_BASE, TORCH_BASE, RENDER_BASE or FFMPEG_NVIDIA_BASE as name@sha256:<digest> only to override.
bash /opt/flagship-m7/tools/arch-drills/m7/gpu-real.sh qualify-nvidia /root/gpu-receipt
```

The Secure Boot case: with Secure Boot on, DKMS signs the module with the box's MOK; enroll it
(`mokutil --import /var/lib/dkms/mok.pub`, confirm at the next boot) before `prepare-nvidia`'s
reboot. `module-signer.txt` must name that key (H11).

## What must pass (summary.json)

| Check | Proves |
|---|---|
| flagship-gpud enumerates the device | inventory: PCI id, driver, CUDA version; UUID never printed |
| the CDI spec was generated, sanitised and written | `nvidia-ctk cdi generate`, `all` and display/management nodes removed, root-owned file |
| H1 CUDA vector add matches bit for bit under gVisor/nvproxy | compute works under the qualified profile with only the claimed device |
| H1 PyTorch inference matches the fixture | a real framework workload, within 1e-4 |
| H2 the scan sees a previous tenant's canaries | the scrub's scan is not blind |
| H2 no canary survives the scrub; coverage and pattern hold | residue handling between tenants (enables `cleanup: flagship-scrub-v1`) |
| H9 headless EGL render matches flagship-test-scene/v1 | graphics, from its own output |
| H9 NVENC/NVDEC round trip is within the PSNR floor | video, from its own output |
| a container without the CDI device gets no GPU | no implicit device access (H10) |
| cargo test --test hardware on the device | the Rust acceptance tests ran, not skipped |

Then, through the box itself (owner's phone, or `/api/screens/accelerators` with a paired session):

- install a GPU test app twice: the second waits in the queue (no double allocation), the first's
  stop releases the device and the second starts (fair queue);
- revoke the first app's approval while it runs: its workload stops, the device settles
  (`released` once H2 qualifies the scrub, `quarantined` before);
- `kill -9` the workload's runsc sandbox: the allocation stays held until the driver has no process
  left on the device, then settles; restart flagship-gpud mid-job: the running allocation is adopted;
- fill the disk to the app's quota during a job, and run a job that allocates past VRAM: both fail
  the job, not the box;
- H12: on the same box with the card removed or the driver unloaded, `/api/screens/accelerators`
  answers `available: false` with the reason, and CPU apps keep running.

## The receipt

`gpu-receipts/H1-nvidia-cuda-owner-pc.md` (and H2, H9, H11 for their parts): commit, `lspci`,
kernel, driver, CUDA, nvidia-ctk, runsc, Secure Boot state and module signer, the summary table,
the raw files. Then fill `nvidia-owner-pc-debian13` in `release/gpu-catalog/matrix.json` (PCI id,
image digests including `scrub`, the driver `.deb` names, versions and SHA-256s from
`apt-get download`), and sign the catalog (README step 6).
