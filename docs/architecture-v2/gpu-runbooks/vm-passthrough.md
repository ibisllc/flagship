# VM passthrough qualification (H8)

What `flagship-gpu`'s `vfio.rs` checks, and how to prove each on a real host.

| Check (refused otherwise) | How to see it on the host |
|---|---|
| the IOMMU is on | `ls /sys/kernel/iommu_groups` is not empty; `dmesg | grep -i -e DMAR -e AMD-Vi` |
| the group translates DMA (`DMA` or `DMA-FQ`, not `identity`) | `cat /sys/kernel/iommu_groups/<g>/type` |
| the group holds only this card's functions | `ls /sys/kernel/iommu_groups/<g>/devices` (no other slot; otherwise ACS is missing upstream) |
| every function has FLR or PM reset | `cat /sys/bus/pci/devices/<f>/reset_method` |
| the card drives no display (`boot_vga`, active display) | `cat /sys/bus/pci/devices/<f>/boot_vga` |

## Steps

1. `gpu-real.sh qualify-passthrough /root/gpu-receipt <pci>`: the probe's `passthrough` verdict per
   device, plus `reset_method` and the group type, into the receipt.
2. Claim with `isolation: vm-passthrough` and attach: every function of the group moves to
   `vfio-pci` (`readlink /sys/bus/pci/devices/<f>/driver`), `/dev/vfio/<g>` appears, the engine
   arguments are `--runtime=kata-vfio --device /dev/vfio/<g>`.
3. Start the Kata workload; inside, the vendor's numerical check passes (AMD/Intel runbooks).
4. Release: each function is reset, returned to its host driver, `/dev/vfio/<g>` is gone.
5. Recovery: kill the VM's process mid-job: the allocation stays held while the runtime reports the
   workload, then settles; a reset that fails leaves the device quarantined.
6. Negative: a card whose group includes another device (a consumer board without ACS), the
   display card, and a function without FLR are each refused with that sentence, and no device node
   is ever handed to a plain container.

Receipt material goes into the vendor's H8 receipt.
