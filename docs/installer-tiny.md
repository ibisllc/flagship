# Tiny live installer — base evaluation, design, QEMU validation, build plan

Status: **design + QEMU-validated skeleton** (2026-05-25). Not yet wired into
the burner; the d-i path (`packages/flagship-burner/src/userdata.ts` /
`preseed.ts`) is untouched and remains the shipping path until this is live.

## 0. Why move off Debian-netinst (d-i)

The d-i preseed is an **opaque chroot**: every failure happens inside
curtin/`in-target` with no live shell, no granular progress, and a wrong guess
costs a full USB reflash + reboot cycle (~10 min on real hardware). The
provisioning sequence itself is proven — we ran it live over SSH on a real box
(install toolchain → `git clone` → `npm install` + `tsc -b` → `gen-identity` →
`mint-entitlements` → register → seal LUKS key). The problem is purely the
**delivery vehicle**, not the sequence.

The replacement: a **tiny live Linux on the USB** that drives every step from a
real root shell, reports a granular phase at each step
(`POST /api/order/<serial>/status`), and lays down the encrypted OS + a
first-boot provisioning unit. Failures are debuggable live; progress is visible
on the phone.

### The Alpine→Debian switch was a CLOUD quirk, not bare metal

`docs/SESSION-HANDOFF.md §0`: the switch to Debian happened because **Alpine's
`-virt` flavor on a Hetzner cx23 CLOUD VM did not mount its modloop squashfs**
(`/lib/modules` empty → `af_packet` can't load → DHCP never fires). That is a
cloud-VM + virt-kernel-flavor issue. On bare metal we use the **`-lts` flavor**
(broad built-in + modular driver set) and the standard ISO's full init, which
mounts modloop from the boot media. So **live-Alpine is the right base for bare
metal** — we just revive `installer/install.sh` + `packages/installer-apkovl/`.

## 1. Base recommendation (the open-minded "smaller than Alpine?" evaluation)

**Recommendation: Alpine Linux `-lts` (netboot kernel+initramfs, or the standard
ISO), with a CURATED firmware subset installed via apk.** Not a custom
Buildroot/initramfs.

### The decisive trade-off, quantified

The live installer's **tooling is genuinely tiny** — but **firmware dominates**,
and firmware is what lets the product boot on diverse commodity hardware
(especially Wi-Fi). Measured numbers (2026-05, x86_64):

| Component | Size | Notes |
|---|---|---|
| busybox (full applet set) | ~1 MB | 304 applets incl. `wget`, `udhcpc`, `ip`, `mount`, `dd`, `mkfs.ext4` (verified in QEMU) |
| cryptsetup + lvm2 + sgdisk + dosfstools + e2fsprogs + curl | **25.3 MiB in 58 pkgs** | the entire live-installer tool set, via `apk add` (verified in QEMU) |
| full `linux-firmware` | **~500 MB – 1 GB** | dominates everything; this is the real cost of "broad hardware" |
| `linux-firmware-intel` (one Alpine subpkg) | ~12.8 MB | Alpine splits firmware per /lib/firmware/* folder |
| curated Wi-Fi+GPU subset (intel/iwlwifi/rtw88/rtw89/rtl_nic/ath10k/ath11k/amdgpu/i915/other) | **~50–150 MB** | the sweet spot: covers the vast majority of commodity NICs/Wi-Fi without the full 1 GB |
| Alpine `vmlinuz-lts` + `initramfs-lts` | 13.7 MB + 25.6 MB = **~40 MB** | kernel + bootstrap initramfs (no modloop) |
| Alpine `modloop-lts` (modules + firmware squashfs) | **281 MB** | broad hardware support lives here |
| Alpine standard ISO (3.23.4) | **347 MB** | full init + modloop + broad firmware, boots broadly out of the box |
| Alpine virt ISO | 67 MB | VM-only; **the flavor that broke on Hetzner**; no Wi-Fi firmware — do NOT use for bare metal |

**Conclusion:** the "tiny" you can win is bounded by firmware, not tooling. A
custom Buildroot image with cryptsetup+lvm+curl is ~10–30 MB — but it boots on
almost nothing real until you bolt on hundreds of MB of firmware + the matching
kernel modules, at which point you have re-implemented Alpine's modloop, badly,
and own a kernel/driver maintenance treadmill. **Alpine already curates exactly
this**, splits firmware into per-vendor apk subpackages, and is reproducible.

### Smaller-than-Alpine options weighed

| Option | Size (tools only) | Driver/firmware coverage | Build complexity | Maintainability | Verdict |
|---|---|---|---|---|---|
| **Alpine -lts + curated fw** (recommended) | ~40 MB base + ~25 MB tools + ~50–150 MB fw | Broad (lts kernel + modloop + apk firmware subpkgs) | Low (revive existing apkovl builder) | High (apk, reproducible ISO already in repo) | ✅ ship this |
| Custom Buildroot initramfs | ~10–30 MB | **Poor** until you add ~hundreds-MB firmware + modules yourself | High (Kconfig, cross-toolchain, per-driver curation) | Low (you own kernel+driver updates) | ❌ false economy: firmware erases the size win, adds a treadmill |
| Debian-live-minimal | ~400–600 MB | Broad | Medium | Medium (live-build) | ❌ bigger than Alpine, no benefit here |
| Netboot tiny initrd (iPXE) | tiny | Depends on baked drivers | Medium | Medium | ❌ needs a netboot server; we're USB-first |
| mkosi / LinuxKit | varies | Distro/container-oriented | Medium–High | Medium | ❌ container/VM-shaped, not a bare-metal USB installer |

Alpine is also already a first-class citizen of this repo:
`packages/installer-apkovl/` builds the overlay, `installer/install.sh` is the
proven Alpine installer, and `scripts/build-flagship-iso.sh` builds it
reproducibly with `SOURCE_DATE_EPOCH` + a pinned ISO/sha256.

## 2. Installer design

```
USB (burner output)
 ├─ Alpine -lts kernel + initramfs (+ modloop)        ← the tiny live OS
 ├─ /flagship/install-blob.json  (signed recipe)      ← baked by the burner
 ├─ /flagship/install-blob.sig                         ← Ed25519 over canonical bytes
 ├─ /flagship/installer.env       (CONTROL_PLANE_BASE, GIT_REF, FW set, Wi-Fi)
 └─ flagship.apkovl.tar.gz        (drops installer.sh into /etc/local.d)
```

Boot flow (each step `report_phase`s to `/api/order/<serial>/status`):

1. **booting** — live OS up; verify tools; **verify the recipe signature** with
   the baked genesis pubkey before trusting any field (port
   `packages/installer-netboot/parse-trailer.sh`, openssl Ed25519). Refuse on
   failure.
2. **downloading** — bring up network (wired DHCP, else baked Wi-Fi via
   `wpa_supplicant`); `setup-apkrepos -1` + enable community; `apk add` the
   live-installer tools + the curated firmware subset (~50–150 MB). This is the
   only network-heavy step and it is bounded (no node here).
3. **partitioning** — select first fixed disk ≥ 8 GiB (not the USB). Lay down the
   **proven layout**, now LVM-backed:
   - p1 `bios_grub` 1 MiB (`ef02`) — BIOS GRUB stage-1.5, no fs
   - p2 ESP 256 MiB (`ef00`, FAT32) — UEFI
   - p3 `/boot` 512 MiB (ext4, label **FLAGSHIP_BOOT**)
   - p4 LUKS2 (rest, `8309`) → PV → vg **flagship** → lv **root** (ext4, label
     **FLAGSHIP_ROOT**)
   - **Critical (QEMU-found):** after `sgdisk`, `partprobe` ALONE does not create
     the `/dev/<disk>N` nodes — `partx -u` + a bounded device-wait loop are
     required. (See §3.)
4. **installing** — random 64-byte LUKS key → `luksFormat --type luks2` →
   `cryptsetup open` → `pvcreate`/`vgcreate flagship`/`lvcreate -n root` →
   `mkfs.ext4`. Mount; lay down the base OS with **`apk --root /mnt add`**
   (Option A — gives the installed OS a package manager for the first-boot heavy
   work). Persist the recipe + the LUKS key handoff material.
5. **drop first-boot unit** — `/etc/local.d/10-flagship-provision.start` (OpenRC)
   carries the **proven heavy sequence verbatim** (`packages/flagship-burner/src/userdata.ts`):
   `git clone` → `npm install` → `tsc -b` → `gen-identity` → `mint-entitlements`
   → register (`POST /api/server/register`) → `seal-for-bak` → push sealed LUKS
   key (`POST /api/server/<domain>/sealed-luks-key`). It `report_phase`s
   **registering / sealing / pairing / live** itself once the installed OS has
   network. None of this runs in the live shell — that is what keeps the
   installer tiny.
6. **bootloader** — GRUB on bios_grub (`i386-pc`) + ESP (`x86_64-efi
   --removable`) so the box boots BIOS or UEFI. `grub-mkconfig` wires
   `root=/dev/flagship/root` + the LUKS/LVM unlock chain (boot-stage.sh / the
   relay hook do the actual per-boot unlock — `boot.flagshipserver.com`).
7. **reboot** into the encrypted OS.

### Burner integration (how the USB is produced)

The burner already produces a USB and bakes the recipe (`packages/flagship-burner`,
`apps/burner-mac`). For this path it:

- writes the Alpine -lts kernel/initramfs/modloop (the burner already remasters
  ISOs — `remasterIso.ts`),
- drops `flagship.apkovl.tar.gz` built with the existing
  `packages/installer-apkovl` `buildApkovl()` (the same pure tar builder this
  PoC reuses for its QEMU gate), containing `installer.sh` in
  `/etc/local.d/10-flagship.start`,
- writes `/flagship/install-blob.json` + `.sig` + `installer.env` (with
  `CONTROL_PLANE_BASE`, `GIT_REF`, the curated `FW_PACKAGES`, and the burn-time
  Wi-Fi SSID/PSK — Wi-Fi is **never** part of the signed blob).

This reuses the burner's existing remaster + the repo's existing apkovl builder;
no new heavy machinery.

## 3. QEMU validation log (what was actually proven)

Host: Apple-Silicon Mac, `qemu-system-x86_64` 11.0.0, **TCG** (no HW accel —
slow but representative). Machine `q35`, SeaBIOS (BIOS) — edk2 OVMF is also
present for UEFI runs.

Proven (all green):

- **Base boots on emulated x86.** Alpine `vmlinuz-lts` + `initramfs-lts` boots to
  a shell under TCG. Alpine **standard ISO boots to `localhost login:`**.
  `uname` in-guest: `Linux 6.18.22-0-lts x86_64`.
- **PoC installer skeleton runs end-to-end.** A custom `/init` (appended cpio
  overlay) walks every phase with `report_phase` and prints the sentinel
  `FLAGSHIP_POC_OK`, then powers off cleanly. busybox exposes **304 applets**
  (incl. `wget`/`udhcpc`/`ip`/`mount`/`dd`/`mkfs.ext4`). Reproduce:
  `npm run -w @flagship/installer-tiny poc:fetch && poc:build && poc:boot`.
- **The netboot initramfs alone has NO storage drivers** — `ata/ahci/sd-mod/
  virtio_blk` are modular and live in `modloop`. Only ram disks appear until
  modloop is loaded. **This is the same class of issue as the Hetzner bug** and
  is the single most important design constraint: the live installer must use
  the full Alpine init (which mounts modloop from boot media) OR `apk add` the
  modules. The standard ISO does the former — disks appear (`/dev/vda`).
- **All live-installer tools install + resolve** on the standard ISO base:
  `cryptsetup`, `pvcreate`, `vgcreate`, `lvcreate` (lvm2), `sgdisk`,
  `mkfs.ext4`, `mkfs.vfat`, `curl` — `25.3 MiB in 58 packages` via apk
  (`27580 distinct packages available`). Requires `setup-apkrepos -1` (a working
  mirror) + community enabled; `apk update` succeeding is NOT sufficient for
  `apk add` if only the cdrom repo is present.
- **Full real partition → encrypted LVM on a virtual target disk** (one QEMU
  session, non-dry-run):
  - `ISLUKS2=yes`, `LUKS_VER=2`, `cipher: aes-xts-plain64`
  - `MAPPER_ACTIVE=1` (LUKS device opened)
  - `LV= root flagship -wi-a-----` (lv root in vg flagship, active)
  - `ROOT_LABEL=FLAGSHIP_ROOT TYPE=ext4`, `BOOT_LABEL=FLAGSHIP_BOOT TYPE=ext4`
  - Required fix found here: `partx -u <disk>` + a device-wait loop after
    `sgdisk`; `partprobe` alone left `/dev/vda4` non-existent
    (`Device /dev/vda4 does not exist`). This fix is in `installer.sh`.

Bug the test suite caught: `exec > >(tee ...)` (process substitution) is a
bash-ism and fails `sh -n` under busybox ash; replaced with a POSIX FIFO + bg
`tee`.

NOT yet exercised in QEMU (build-plan items): the `apk --root /mnt` base
lay-down, the GRUB BIOS+UEFI install, a full reboot into the encrypted root, the
first-boot provisioning unit (needs node + live `.com`), and the recipe
signature verification.

## 4. Build plan (remaining work)

1. **Recipe signature verify** (security-critical, do first). Port
   `packages/installer-netboot/parse-trailer.sh`'s openssl Ed25519 verify into
   `phase_boot`; fail closed. Add a vitest that feeds a tampered blob.
2. **apk --root base lay-down + GRUB**. Exercise `apk --root /mnt --initdb add
   alpine-base linux-lts ...` + `grub-install` (BIOS+UEFI) in QEMU; boot the
   resulting disk (detach the ISO) to confirm it reaches the installed OS.
   Decide Option A (`apk --root`, package manager on-box) vs Option B (`dd` a
   prebuilt base image — faster, fixed size, but no on-box pkg mgr → first-boot
   must bootstrap node differently). Recommendation stands at A.
3. **First-boot provisioning unit, live.** Wire the heredoc to call the real
   `scripts/install-helper.ts` subcommands (don't re-spell args — `source` the
   proven block from userdata.ts or factor a shared `installer/provision.sh`).
   Exercise against a real `.com` order end-to-end; confirm the phone timeline
   shows registering→sealing→pairing→live.
4. **Boot UEFI in QEMU** with edk2 OVMF (`edk2-x86_64-code.fd`) to validate the
   ESP/`--removable` GRUB path, not just BIOS/SeaBIOS.
5. **Curated firmware tuning.** Validate the `FW_PACKAGES` subset on real
   diverse hardware (the test box needed iwlwifi); measure actual size; decide
   whether to bake the subset into the ISO (offline-capable) or `apk add` it at
   the downloading phase (smaller USB, needs network early). Wi-Fi-needed-for-
   network is a chicken/egg: bake the Wi-Fi firmware + driver into the
   initramfs/modloop, OR require Ethernet for the install and bring Wi-Fi up
   only on the installed OS.
6. **Burner integration.** Teach the burner to emit the Alpine -lts media +
   apkovl + `installer.env` (reuse `remasterIso.ts` + `buildApkovl()`). Add the
   `report_phase booting/downloading/partitioning` early calls (the d-i path can
   only report from clone onward; this path reports the full timeline).
7. **Reproducible ISO.** Fold into `scripts/build-flagship-iso.sh`
   (`SOURCE_DATE_EPOCH` + pinned Alpine ISO/sha256 + the deterministic
   `buildApkovl` mtime). Pin the Alpine release + sha256 in `fetch-base.sh`.
8. **Real-hardware E2E.** Burn → boot a commodity box (BIOS + UEFI) → observe
   the full phase timeline on the phone → encrypted root → first unlock via
   `boot.flagshipserver.com`. This is the only step the agent cannot do.

## 5. Files

- `packages/installer-tiny/src/installer.sh` — the live installer (POSIX sh,
  dry-run-guarded; QEMU-validated partition/LUKS/LVM path).
- `packages/installer-tiny/src/index.ts` — phase vocabulary + proven-layout
  constants + curated firmware/tool lists (single source of truth).
- `packages/installer-tiny/scripts/{fetch-base,build-poc-initramfs,qemu-boot}.sh`
  — reproduce the QEMU PoC.
- `packages/installer-tiny/scripts/build-gate-apkovl.mjs` — builds the apkovl gate
  used to validate tools+disks on the real standard ISO (reuses
  `@flagship/installer-apkovl`'s `buildApkovl`).
- `packages/installer-tiny/tests/installer.test.ts` — 11 tests: shell syntax,
  phase lock-step with the control plane, proven-layout invariants, tiny-by-
  design guards, dry-run safety.
- `installer/install.sh`, `packages/installer-apkovl/` — the revived Alpine
  assets this design builds on.
