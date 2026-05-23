/** Local hex + constant-time compare helpers (mirror of the
 *  control-plane versions; the boot worker keeps its own copy so it
 *  has no compile dependency on the control-plane internals). */

export function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(v)) throw new Error("non-hex");
    out[i] = v;
  }
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Constant-time hex compare (case-insensitive, length-leaking by design). */
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

/** Constant-time opaque-token compare (shared secrets). */
export function equalToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
