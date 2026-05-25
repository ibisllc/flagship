/**
 * @flagship/installer-tiny — the tiny live-OS installer.
 *
 * Replaces the Debian-netinst (d-i) preseed with a tiny live Linux (Alpine LTS)
 * that lays down the real encrypted OS and reports granular progress. See
 * docs/installer-tiny.md for the base evaluation, the installer design, and the
 * QEMU validation log.
 *
 * This TS surface is intentionally thin: the installer itself is a POSIX shell
 * script (src/installer.sh) that runs inside the live OS. We export the phase
 * vocabulary + the proven-layout constants so the burner (which produces the
 * USB) and any TS test can refer to a single source of truth.
 */

/**
 * The phases the live installer reports to /api/order/:serial/status. Kept in
 * exact lock-step with PROVISION_STATUS_PHASES in
 * packages/control-plane/src/provisionStatus.ts — the phone timeline renders
 * these. (Re-declared here, not imported, to avoid a control-plane dep in the
 * burner's build graph; the test asserts they match.)
 *
 * `booting` is the EARLIEST signal: the live installer fires it the moment the
 * network link is up (phase_network), before the apk download or any disk work,
 * so the owner's phone lights up immediately. downloading/partitioning/
 * installing follow; registering/sealing/pairing/live are reported by the
 * first-boot provisioning unit on the INSTALLED OS; `error` is the terminal
 * failure state (USB left intact for retry).
 */
export const INSTALLER_PHASES = [
  "booting",
  "downloading",
  "partitioning",
  "installing",
  "registering",
  "sealing",
  "pairing",
  "live",
  "error",
] as const;

export type InstallerPhase = (typeof INSTALLER_PHASES)[number];

/** The encrypted-LVM layout the installer lays down (the proven layout). */
export const PROVEN_LAYOUT = {
  /** Partition 1: BIOS GRUB stage-1.5 (no filesystem). */
  biosGrub: { typeCode: "ef02", sizeMiB: 1 },
  /** Partition 2: EFI System Partition (FAT32) for UEFI boot. */
  esp: { typeCode: "ef00", sizeMiB: 256 },
  /** Partition 3: unencrypted /boot (ext4). */
  boot: { typeCode: "8300", sizeMiB: 512, label: "FLAGSHIP_BOOT" },
  /** Partition 4: LUKS2 container -> LVM PV -> vg "flagship" -> lv "root". */
  luks: { typeCode: "8309", vgName: "flagship", lvName: "root", rootLabel: "FLAGSHIP_ROOT" },
} as const;

/** Curated firmware subset (Alpine subpackages) for commodity x86 hardware. */
export const CURATED_FIRMWARE_PACKAGES = [
  "linux-firmware-intel",
  "linux-firmware-rtw88",
  "linux-firmware-rtw89",
  "linux-firmware-iwlwifi",
  "linux-firmware-rtl_nic",
  "linux-firmware-ath10k",
  "linux-firmware-ath11k",
  "linux-firmware-amdgpu",
  "linux-firmware-i915",
  "linux-firmware-other",
] as const;

/** The live-installer tool set installed via apk in the "downloading" phase.
 * `efibootmgr` is here for the success self-wipe (point firmware at the
 * internal disk). node is deliberately NOT here — it runs first-boot on the
 * installed OS. */
export const LIVE_INSTALLER_TOOLS = [
  "cryptsetup",
  "lvm2",
  "sgdisk",
  "partx",
  "dosfstools",
  "e2fsprogs",
  "curl",
  "ca-certificates",
  "efibootmgr",
] as const;

/**
 * The base-OS package set laid down onto the encrypted root via `apk --root`
 * (the "installing" phase). It must make the box come up HEADLESS on the
 * encrypted disk on its own — so it includes the LUKS+LVM-aware initramfs
 * builder (mkinitfs), the unlock tooling (cryptsetup, lvm2), GRUB for BOTH
 * firmwares (grub-bios + grub-efi + efibootmgr), and the daemon runtime deps
 * (nodejs, npm, git) that the first-boot provisioning unit needs. Mirrors the
 * apt set in installer/install.sh, adapted to Alpine apk names.
 */
export const INSTALLED_OS_PACKAGES = [
  // base system + init
  "alpine-base",
  "alpine-conf",
  "linux-lts",
  "openrc",
  "busybox",
  "busybox-suid",
  // LUKS+LVM-aware initramfs + filesystem tools
  "mkinitfs",
  "cryptsetup",
  "lvm2",
  "e2fsprogs",
  "dosfstools",
  // bootloader: BIOS + UEFI + NVRAM editor
  "grub",
  "grub-bios",
  "grub-efi",
  "efibootmgr",
  // daemon runtime deps (heavy first-boot sequence: clone/npm/tsc/helper)
  "nodejs",
  "npm",
  "git",
  "curl",
  "jq",
  "openssl",
  "ca-certificates",
  // headless services
  "chrony",
  "openssh",
  "util-linux",
] as const;

/**
 * The success-only finalize ordering (the agreed one-shot UX). Every step is
 * gated on `verify_installed_bootable` returning 0 FIRST; on a failed gate the
 * installer reports `error` and leaves the USB intact for retry — none of the
 * wipe/repoint steps fire. Encoded here so the sequencing is testable against
 * the shell.
 */
export const SUCCESS_FINALIZE_ORDER = [
  "verify_installed_bootable", // the gate — must pass before anything destructive
  "efibootmgr_internal_first", // (a) point firmware at the internal disk
  "wipe_usb_boot_signature", // (b) clobber the USB so no installer reboot loop
  "reboot", // into the clean encrypted internal disk
] as const;
