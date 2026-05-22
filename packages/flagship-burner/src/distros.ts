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
  /** Cloud-init NoCloud datasource layout the bootstrap relies on. */
  cloudInitDatasource: "subiquity" | "debian-cloud";
  /** Whether boot is BIOS-legacy, UEFI, or both. */
  boot: "bios" | "uefi" | "hybrid";
}

export const PINNED_DISTROS: readonly PinnedDistro[] = [
  {
    id: "ubuntu-22.04-server-amd64",
    displayName: "Ubuntu Server 22.04.5 LTS (amd64)",
    upstreamUrl:
      "https://releases.ubuntu.com/22.04.5/ubuntu-22.04.5-live-server-amd64.iso",
    sha256: "9bc6028870aef3f74f4e16b900008179e78b130e6b0b9a140635434a46aa98b0",
    sizeBytes: 2_136_926_208,
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
