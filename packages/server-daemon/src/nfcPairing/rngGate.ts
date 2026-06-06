// N-BOX-2 — hard RNG entropy gate before any pair keygen.
//
// `/proc/sys/kernel/random/entropy_avail` reports the kernel pool depth;
// brand-new x86 boxes without a hardware TRNG can boot with very little
// entropy (~100 bits) and would otherwise generate pair keys from a
// half-empty pool — a small but real attack surface. The ISO bakes in
// jitterentropy + a haveged-equivalent (N-BOX-10) so the pool fills
// fast, but the daemon still blocks keygen until the threshold is met.
//
// 256 bits matches the spec in `docs/nfc-box-pairing.md § implementation
// checklist`. Above that, Ed25519/X25519/SHA-256 all draw on a pool that
// is *cryptographically* full per Linux's CSPRNG contract.

import { readFileSync } from "node:fs";

export const ENTROPY_THRESHOLD_BITS = 256;

const ENTROPY_PATH = "/proc/sys/kernel/random/entropy_avail";

export interface EntropyReader {
  /**
   * Return the current `entropy_avail` reading in bits, or `null` if
   * the source is unreadable (non-Linux host, missing /proc, etc.).
   *
   * Returning `null` is treated by `checkEntropy` as a soft fail: the
   * gate reports `ok: false` so callers can decide policy (block,
   * warn, proceed in dev). Throwing is reserved for genuine I/O errors
   * the caller should propagate.
   */
  read(): number | null;
}

export interface EntropyCheckResult {
  ok: boolean;
  available: number | null;
  threshold: number;
  /** Populated when ok=false. */
  reason?: string;
}

/**
 * Default reader — reads /proc/sys/kernel/random/entropy_avail. Returns
 * `null` if the file isn't accessible (so a macOS dev workstation
 * doesn't crash daemon startup; it gets a clean `ok: false` instead).
 */
export const defaultEntropyReader: EntropyReader = {
  read(): number | null {
    try {
      const raw = readFileSync(ENTROPY_PATH, "utf-8").trim();
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  },
};

/**
 * Gate check used immediately before per-boot pair-keygen. Box-side
 * pairing code MUST refuse to generate STK/ephemeral keys unless this
 * returns ok=true.
 */
export function checkEntropy(
  reader: EntropyReader = defaultEntropyReader,
  threshold = ENTROPY_THRESHOLD_BITS,
): EntropyCheckResult {
  const available = reader.read();
  if (available === null) {
    return {
      ok: false,
      available: null,
      threshold,
      reason: "entropy_avail unreadable (likely non-Linux host)",
    };
  }
  if (available < threshold) {
    return {
      ok: false,
      available,
      threshold,
      reason: `entropy_avail=${available} below threshold=${threshold}`,
    };
  }
  return { ok: true, available, threshold };
}
