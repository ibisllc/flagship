/**
 * Recommended distro list. This is ADVICE, not a gate — the Burner builds
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
   * Which installer family the ISO carries. "debian" → debian-installer (d-i)
   * preseed; "ubuntu" → subiquity autoinstall. Selects the unattended-install
   * mechanism the remaster bakes in (preseed vs NoCloud) and the generator
   * (preseed.cfg vs cloud-init user-data). This is the discriminator, not
   * cloudInitDatasource (kept for back-compat).
   */
  family: "debian" | "ubuntu";
  /** Cloud-init NoCloud datasource layout the bootstrap relies on. */
  cloudInitDatasource: "subiquity" | "debian-cloud";
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
    // class of box Ubuntu's subiquity fatally aborts on.
    id: "debian-13-netinst-amd64",
    displayName: "Debian 13 (trixie) netinst (amd64)",
    upstreamUrl:
      "https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-13.5.0-amd64-netinst.iso",
    sha256: "95838884f5ea6c82421dfe6baaa5a639dbbe6756c1e380f9fe7a7cb0c1949d2a",
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
      "https://cdimage.debian.org/debian-cd/current/arm64/iso-cd/debian-13.5.0-arm64-netinst.iso",
    sha256: "3f8211e759d19370d50e1d853859b66ecba62700d712214a8a65ed26c6d08ecc",
    sizeBytes: 735_358_976,
    family: "debian",
    cloudInitDatasource: "debian-cloud",
    // arm64 netinst is UEFI-only — no isolinux/BIOS half. The remaster
    // tolerates that (it patches whichever boot configs exist).
    boot: "uefi",
    recommended: false,
  },
  {
    id: "ubuntu-22.04-server-amd64",
    displayName: "Ubuntu Server 22.04.5 LTS (amd64)",
    upstreamUrl:
      "https://releases.ubuntu.com/22.04.5/ubuntu-22.04.5-live-server-amd64.iso",
    sha256: "9bc6028870aef3f74f4e16b900008179e78b130e6b0b9a140635434a46aa98b0",
    sizeBytes: 2_136_926_208,
    family: "ubuntu",
    cloudInitDatasource: "subiquity",
    boot: "hybrid",
  },
] as const;

export function findDistroById(id: string): PinnedDistro | undefined {
  return PINNED_DISTROS.find((d) => d.id === id);
}

export function findDistroBySha(sha256: string): PinnedDistro | undefined {
  const target = sha256.toLowerCase();
  return PINNED_DISTROS.find((d) => d.sha256.toLowerCase() === target);
}
