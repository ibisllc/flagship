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

/** The live-installer tool set installed via apk in the "downloading" phase. */
export const LIVE_INSTALLER_TOOLS = [
  "cryptsetup",
  "lvm2",
  "sgdisk",
  "partx",
  "dosfstools",
  "e2fsprogs",
  "curl",
  "ca-certificates",
] as const;
