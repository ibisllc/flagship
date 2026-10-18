/**
 * Recommended distro list. This is ADVICE, not a gate — the Builder builds
 * a boot drive from whatever ISO the user supplies. `verify-iso` and
 * `distros` use this list to tell the user whether their image is one we've
 * tested; the burn itself never refuses an unrecognized ISO.
 *
 * Each entry records:
 *   - SHA-256 of the upstream ISO (so `verify-iso` can confirm a match)
 *   - Upstream URL (for the "where to download" hint)
 *   - Size + boot mode (BIOS/UEFI), shown for context
 *
 * We add a release here only after a real end-to-end install on hardware.
 */
export interface PinnedDistro {
  /** Stable internal id (e.g. "ubuntu-22.04-server-amd64"). */
  id: string;
  /** Human-readable name shown in the picker. */
  displayName: string;
  /** Public download URL on the upstream's CDN. */
  upstreamUrl: string;
  /** Hex SHA-256 of the ISO. Lowercased; no separators. */
  sha256: string;
  /** Size in bytes (we sanity-check before reading the whole file). */
  sizeBytes: number;
  /**
   * Which installer family the ISO carries: debian-installer (d-i) preseed.
   */
  family: "debian";
  /** Cloud-init NoCloud datasource layout the bootstrap relies on. */
  cloudInitDatasource: "debian-cloud";
  /** Whether boot is BIOS-legacy, UEFI, or both. */
  boot: "bios" | "uefi" | "hybrid";
  /**
   * The most-compatible / recommended choice shown first on the website + in
   * the picker. Exactly one entry is the recommended default.
   */
  recommended?: boolean;
}

export const PINNED_DISTROS: readonly PinnedDistro[] = [
  {
    // Debian is the recommended default: its installer (debian-installer) can be
    // preseeded to force GRUB to the EFI removable-media path, so it installs
    // and boots on firmware that REJECTS NVRAM boot-entry writes — the exact
    // class of box other installers fatally abort on.
    id: "debian-13-netinst-amd64",
    displayName: "Debian 13 (trixie) netinst (amd64)",
    upstreamUrl:
      "https://cdimage.debian.org/cdimage/archive/13.6.0/amd64/iso-cd/debian-13.6.0-amd64-netinst.iso",
    sha256: "65273beed27b2df543b68b65630ba525cfbad8df2b12035732b2dff87d6664e7",
    sizeBytes: 791_674_880,
    family: "debian",
    cloudInitDatasource: "debian-cloud",
    boot: "hybrid",
    recommended: true,
  },
  {
    // arm64 twin of the Debian default. NOT for burning (real boxes are x86) —
    // it exists so the desktop apps' HOST-a-VM path can run a native-arch
    // guest on arm64 hardware: Apple-silicon Macs (Virtualization.framework
    // boots native-arch only) and arm64 Linux/Chromebook KVM hosts.
    id: "debian-13-netinst-arm64",
    displayName: "Debian 13 (trixie) netinst (arm64)",
    upstreamUrl:
      "https://cdimage.debian.org/cdimage/archive/13.6.0/arm64/iso-cd/debian-13.6.0-arm64-netinst.iso",
    sha256: "ffa590beb3ae9158c354e00ebc4bf45421f4720bb3a8ddf2db3cbfc0374cf480",
    sizeBytes: 735_358_976,
    family: "debian",
    cloudInitDatasource: "debian-cloud",
    // arm64 netinst is UEFI-only — no isolinux/BIOS half. The remaster
    // tolerates that (it patches whichever boot configs exist).
    boot: "uefi",
    recommended: false,
  },
] as const;

export function findDistroById(id: string): PinnedDistro | undefined {
  return PINNED_DISTROS.find((d) => d.id === id);
}

export function findDistroBySha(sha256: string): PinnedDistro | undefined {
  const target = sha256.toLowerCase();
  return PINNED_DISTROS.find((d) => d.sha256.toLowerCase() === target);
}
