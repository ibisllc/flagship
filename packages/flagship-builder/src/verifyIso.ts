/**
 * ISO hash verification against the pinned distro allowlist.
 *
 * Phase 1: SHA-256 only. Phase 2 will add GPG verification against
 * pinned Canonical/Debian signing-key fingerprints.
 *
 * Streams the file in 1 MiB chunks so we never hold a 2 GB ISO in
 * memory.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { findDistroBySha, type PinnedDistro } from "./distros.js";

export interface VerifyIsoResult {
  ok: boolean;
  sha256: string;
  sizeBytes: number;
  matched?: PinnedDistro;
  reason?: string;
}

export async function verifyIsoHash(isoPath: string): Promise<VerifyIsoResult> {
  let sizeBytes: number;
  try {
    const st = await stat(isoPath);
    sizeBytes = st.size;
  } catch (e) {
    return {
      ok: false,
      sha256: "",
      sizeBytes: 0,
      reason: `cannot stat ${isoPath}: ${(e as Error).message}`,
    };
  }
  const hash = createHash("sha256");
  const stream = createReadStream(isoPath, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  const sha = hash.digest("hex");
  const matched = findDistroBySha(sha);
  if (!matched) {
    return {
      ok: false,
      sha256: sha,
      sizeBytes,
      reason: "SHA-256 does not match a recommended distro",
    };
  }
  return { ok: true, sha256: sha, sizeBytes, matched };
}
