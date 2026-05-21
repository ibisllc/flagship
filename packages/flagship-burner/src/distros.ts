/**
 * Pinned distro allowlist. The Burner refuses anything off this list.
 *
 * Each entry pins:
 *   - SHA-256 of the upstream ISO (so a tampered download is rejected
 *     even if GPG verification is skipped)
 *   - Upstream URL (for the "where to download" UX hint)
 *   - GPG signing key fingerprint + signature URL (post-Phase-1)
 *   - Whether it boots BIOS, UEFI, or both (so we can warn the user
 *     if their target machine doesn't match)
 *
 * v1 starts narrow — Ubuntu Server 22.04.4 LTS only. We expand as we
 * test each release on a real laptop. NEVER ship a distro entry we
 * haven't end-to-end-tested.
 *
 * Update process: run `flagship-burn pin-distro <url>` against a fresh
 * Canonical download in CI; commit the resulting entry. Never accept
 * a SHA from the user — always compute from the upstream URL ourselves.
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
    sizeBytes: 2_120_415_232,
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
