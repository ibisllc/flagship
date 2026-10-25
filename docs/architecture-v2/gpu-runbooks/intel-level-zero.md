# Intel Level Zero / oneAPI in a dedicated VM (H4, H8 for Intel)

**Hardware (not procured):** an Intel Data Center GPU Flex 170 (or Max, or Arc A770) in an IOMMU
host. Intel runs only in a dedicated VM (Kata over VFIO), like AMD, and is never CUDA.

## Host

```sh
apt-get install -y intel-opencl-icd libze1 xpu-smi    # the pinned compute-runtime release
dpkg-query -W -f='${Version}\n' libze1                  # the Level Zero version the entry pins
```

## Steps

1. `flagship-gpud probe --xpu-smi /usr/bin/xpu-smi --level-zero-version <v> --vm-runtime-version "kata <v>"`:
   `intel-level-zero`, model and memory from `xpu-smi discovery`; without xpu-smi the `i915`/`xe`
   sysfs fallback still lists the device (less detail, never a guess).
2. `gpu-real.sh qualify-passthrough /root/gpu-receipt <pci>` (`vm-passthrough.md`).
3. Claim with `isolation: vm-passthrough`; in the VM run `vector_add.sycl.cpp` built with `icpx -fsycl`
   (`ONEAPI_DEVICE_SELECTOR=level_zero:gpu`, so it can't fall back to the CPU) and
   `torch_check.py xpu` (intel-extension-for-pytorch); verify `--api sycl` / `--api xpu`.
4. Video (Flex/Arc): `transcode.sh 320 240 hevc vaapi` and `av1 qsv`; `verify-transcode`.
5. Observer: `xpu-smi ps` reports a host process; with xpu-smi stopped, DRM fdinfo (`i915`/`xe`)
   still does.
6. Release resets the group and returns it to `i915`/`xe`; residue via a SYCL scrub, or quarantine.

Receipts `H4-intel-level-zero`, `H8-intel-passthrough`; fill `intel-flex170-vm-debian13`.
