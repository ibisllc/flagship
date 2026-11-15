// A retail box's new owner gets a new box (docs/retail-box-setup.md §8.1, §8.2): a wipe, a reset
// claim or "Release this box" destroys every key and record keyd holds for the previous owner
// (the STK and its ML-DSA half, the workload and gossip keys, TLS and ACME keys, the owner and
// admin-root pins, archive keys, revocations, the audit log) and leaves only a fresh STK and
// ML-DSA seed, drawn from the OS RNG. Same files and formats as the serving keyd reads; the Rust
// keyd has the same reset (flagship-keyd `files::reset_state`).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed, hybridSigKeygen } from "@flagship/protocol";

export const KEYD_RESET_FLAG = "--yes-erase-every-key";

function writeKey(dir: string, name: string, bytes: Uint8Array): void {
  const final = join(dir, `${name}.key`);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, Buffer.from(bytes).toString("hex") + "\n", { mode: 0o400 });
  renameSync(tmp, final);
}

type Random = (n: number) => Uint8Array;
const osRandom: Random = (n) => new Uint8Array(randomBytes(n));

/** Empties keyd's state folder and puts a fresh box identity in it. keyd must be stopped. */
export function resetKeydState(dir: string, random: Random = osRandom): { publicKeyHex: string; mldsaPubHex: string } {
  if (existsSync(dir)) for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
  return writeFreshIdentity(dir, random);
}

/** Same file as server-daemon retailClaim/wipe.ts RETAIL_IMAGE_MARKER: only a retail image has it. */
export const RETAIL_IMAGE_MARKER_PATH = "/etc/flagship/retail-image.json";

/**
 * A retail box's first identity (docs/retail-box-setup.md §2): the image carries no box key, so
 * every unit of a SKU makes its own on its first boot, from its own RNG, before keyd first serves.
 * Runs in `migrate` (root, every keyd start) and does nothing once a key exists, or when the box
 * holds an installer-made key keyd has yet to move in, or on any box that is not a retail image.
 */
export function ensureRetailFirstIdentity(
  opts: { keydDir: string; legacyDir: string; retailMarker?: string; random?: Random },
): { publicKeyHex: string; mldsaPubHex: string } | null {
  if (!existsSync(opts.retailMarker ?? RETAIL_IMAGE_MARKER_PATH)) return null;
  if (existsSync(join(opts.keydDir, "identity.key"))) return null;
  if (existsSync(join(opts.legacyDir, "identity", "identity.priv.hex"))) return null;
  return writeFreshIdentity(opts.keydDir, opts.random ?? osRandom);
}

function writeFreshIdentity(dir: string, random: Random): { publicKeyHex: string; mldsaPubHex: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const seed = random(32);
  const pq = random(32);
  try {
    writeKey(dir, "identity", seed);
    writeKey(dir, "identity-mldsa", pq);
    return {
      publicKeyHex: Buffer.from(ed.getPublicKey(seed)).toString("hex"),
      mldsaPubHex: Buffer.from(hybridSigKeygen(seed, pq).publicKey.subarray(32)).toString("hex"),
    };
  } finally {
    seed.fill(0);
    pq.fill(0);
  }
}
