/**
 * Cloud Gossip Key (CGK) provisioning — the read-only consume half.
 *
 * The CGK is one symmetric key PER CLOUD (per account); every pod of the
 * account derives the SAME one (`deriveCGK(umk.seed)` in @flagship/protocol).
 * It authenticates (HMAC) and transports (AES-256-GCM seal) the per-tick gossip
 * frame between siblings. Without it the gossip loop stays DISABLED — a box with
 * no CGK simply never gossips and never claims/yields a leader route (no brick).
 *
 * Provisioning here MIRRORS the SWK read in index.ts exactly:
 *
 *   1. FLAGSHIP_CGK_HEX env       (dev / test runs)
 *   2. /var/flagship/cgk.hex      (provisioned box, the stable on-disk path)
 *   3. install-blob.json cgkHex   (the phone's recipe-embedded sibling)
 *
 * The phone-side derive+embed of `cgkHex` into the recipe is a SEPARATE later
 * provisioning step (Phase 6). Here we only CONSUME a provisioned CGK — there is
 * no deposit consumer, no derivation. A malformed/absent value yields null and
 * gossip stays off, exactly like a platform-less box stays platform-less.
 */
import { readFile } from "node:fs/promises";

const HEX64 = /^[0-9a-f]{64}$/i;

/** Read the recipe's `cgkHex` UNSIGNED sibling from the on-disk install blob. */
async function cgkHexFromInstallBlob(): Promise<string | null> {
  const blobPath = process.env.FLAGSHIP_INSTALL_BLOB ?? "/var/flagship/install-blob.json";
  const raw = await tryRead(blobPath);
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as { cgkHex?: unknown };
    const v = b.cgkHex;
    if (typeof v !== "string" || !HEX64.test(v)) return null;
    return v.toLowerCase();
  } catch {
    return null;
  }
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve the CGK as raw 32 bytes, or null when none is provisioned (gossip
 * disabled). Resolution order is env → /var/flagship/cgk.hex → install-blob
 * sibling — the SWK order. Never throws.
 */
export async function resolveCgk(opts?: {
  cgkHexFilePath?: string;
}): Promise<Uint8Array | null> {
  const filePath = opts?.cgkHexFilePath ?? "/var/flagship/cgk.hex";
  let hex: string | null =
    (process.env.FLAGSHIP_CGK_HEX ?? null) ?? (await tryRead(filePath));
  if (hex) hex = hex.trim();
  if (!hex || !HEX64.test(hex)) {
    hex = await cgkHexFromInstallBlob();
  }
  if (!hex || !HEX64.test(hex)) return null;
  return hexToBytes(hex.toLowerCase());
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
