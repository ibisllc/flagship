export function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Constant-time byte compare (#47). The earlier short-circuiting
 * version leaked the position of the first mismatch via timing.
 * For pubkeys + signatures this is largely academic — they're public
 * values — but for opaque tokens (admin keys, paired-session secrets)
 * it matters. Use the accumulator pattern: walk every byte regardless
 * of where the mismatch is, OR-in differences, return at the end.
 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  // We DO leak length via the length check; that's by design — the
  // caller already knows the canonical length of the data type they're
  // comparing (pubkeys are 32 bytes, sigs are 64, etc.).
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Constant-time hex compare (#47). Normalize case first (a single
 * pass over each input — does not depend on the bytes' values),
 * then accumulator-compare character-by-character. Returns false
 * fast only on length mismatch; on equal-length inputs, every byte
 * is examined.
 */
export function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  let diff = 0;
  for (let i = 0; i < al.length; i++) {
    diff |= al.charCodeAt(i) ^ bl.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Constant-time string token compare. Use this anywhere an opaque
 * secret (admin-secret env var, paired-session token, single-use
 * link token) is being compared. Length-mismatch fast-paths are
 * intentional — the caller knows the canonical token length.
 */
export function equalToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export const HEX64 = /^[0-9a-f]{64}$/;
export const HEX128 = /^[0-9a-f]{128}$/;
