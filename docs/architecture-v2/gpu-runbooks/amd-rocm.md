# AMD ROCm in a dedicated VM (H3, H8 for AMD)

**Hardware (not procured):** an AMD GPU on AMD's ROCm support matrix (Instinct MI210, or a
listed Radeon) in a host with an IOMMU, ACS and function-level reset. AMD runs only in a dedicated
VM (Kata Containers over VFIO): gVisor documents no mediation for `/dev/kfd`. It is never reported
or approved as CUDA.

## Host

```sh
apt-get install -y amdgpu-dkms rocm-smi-lib amd-smi-lib      # from AMD's repo for the pinned ROCm
cat /opt/rocm/.info/version                                     # the toolkit version the entry pins
# Kata Containers, the pinned release, registered with Podman as kata-vfio
```

Boot with `intel_iommu=on`/`amd_iommu=on iommu=pt` is **not** enough: flagship-gpud refuses a group
in identity mode; use the default DMA translation (`/sys/kernel/iommu_groups/<g>/type` = `DMA` or
`DMA-FQ`).

## Steps

1. `flagship-gpud probe --amd-smi /opt/rocm/bin/amd-smi --rocm-smi /opt/rocm/bin/rocm-smi --rocm-version <v> --vm-runtime-version "kata <v>"`:
   the device is `amd-rocm`, with memory, driver and the passthrough verdict.
2. `gpu-real.sh qualify-passthrough /root/gpu-receipt <pci>` (see `vm-passthrough.md`).
3. Claim with `isolation: vm-passthrough`: the attach binds the whole IOMMU group to `vfio-pci`
   and returns `--runtime=kata-vfio --device /dev/vfio/<g>`.
4. In that VM run `tools/gpu/vector-add/vector_add.hip.cpp` (built with `hipcc` on the pinned ROCm
   image) and the PyTorch-ROCm `torch_check.py rocm`; verify with
   `flagship-gpud verify-report --kind vector-add --api hip` and `--kind mlp --api rocm`.
5. Observer: while the VM holds the device the host sees no process (the device is on vfio-pci);
   with the host driver back, run a ROCm process on the host: `amd-smi process` and, with amd-smi
   stopped, the KFD and DRM-fdinfo observers report it busy; with neither readable the state is
   unknown (the device stays held).
6. Release: the group is reset (FLR) and returned to `amdgpu`; a scrub run (HIP port of
   `scrub.cu`) after a canary tenant finds no residue, or the device is quarantined.
7. A device whose IOMMU group holds another device, or with no FLR, is refused for passthrough.

Receipts `H3-amd-rocm`, `H8-amd-passthrough`; fill `amd-mi210-vm-debian13`.
