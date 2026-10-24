/**
 * Authenticated time for a box (architecture v2; docs/architecture-v2/pq-suites.md §17).
 *
 * A box at boot has only its own clock, which an attacker with the hypervisor or the RTC can set
 * back to revive an expired lease, grant or binding. The box asks `.com` for the time with a fresh
 * nonce; `.com` answers with its CA operational key over
 *
 *   flagship/signed-time/v1|<nonce hex>|<time ms>
 *
 * and the box accepts the answer only when that key is a CA key the box's own baked maintainer
 * pin authorizes at that time (the same chain every CA-signed artifact goes through), and the
 * nonce is the one it sent. `.com` can lie about the time only as far as its CA key is trusted,
 * and a replayed answer fails the nonce. The box keeps a monotonic floor of the newest time it
 * accepted, so its clock is never read earlier than that, after a restart too.
 */
import { ed } from "./edSync.js";
import { authorizedCaKeysOrFailClosed, type CaTrustChain } from "./maintainerCa.js";
import type { Bytes } from "./types.js";

export const TAG_SIGNED_TIME = "flagship/signed-time/v1";

export interface SignedTimeWire {
  nonce: string;
  timeMs: number;
  keyHex: string;
  signature: string;
}

const HEX32 = /^[0-9a-f]{64}$/;

export function canonicalSignedTime(nonceHex: string, timeMs: number): Bytes {
  if (!HEX32.test(nonceHex)) throw new Error("signed-time: nonce must be 32-byte lowercase hex");
  if (!Number.isSafeInteger(timeMs) || timeMs <= 0) throw new Error("signed-time: bad time");
  return new TextEncoder().encode([TAG_SIGNED_TIME, nonceHex, timeMs].join("|"));
}

export function signSignedTime(nonceHex: string, timeMs: number, caPriv: Bytes): SignedTimeWire {
  const sig = ed.sign(canonicalSignedTime(nonceHex, timeMs), caPriv);
  return { nonce: nonceHex, timeMs, keyHex: toHex(ed.getPublicKey(caPriv)), signature: toHex(sig) };
}

export type SignedTimeRefusal = "malformed" | "nonce" | "key-not-authorized" | "signature";

/** The authenticated time, or why it is refused. `chain` is the box's baked-pin CA chain. */
export function verifySignedTime(
  wire: unknown,
  nonceHex: string,
  chain: CaTrustChain | null,
  pinnedMandateHash?: string,
): { ok: true; timeMs: number } | { ok: false; code: SignedTimeRefusal } {
  if (!wire || typeof wire !== "object") return { ok: false, code: "malformed" };
  const w = wire as Partial<SignedTimeWire>;
  if (typeof w.nonce !== "string" || typeof w.timeMs !== "number" || typeof w.keyHex !== "string" || typeof w.signature !== "string") {
    return { ok: false, code: "malformed" };
  }
  if (!Number.isSafeInteger(w.timeMs) || w.timeMs <= 0 || !HEX32.test(w.keyHex) || !/^[0-9a-f]{128}$/.test(w.signature)) {
    return { ok: false, code: "malformed" };
  }
  if (w.nonce !== nonceHex) return { ok: false, code: "nonce" };
  const gate = pinnedMandateHash === undefined
    ? authorizedCaKeysOrFailClosed(chain, w.timeMs)
    : authorizedCaKeysOrFailClosed(chain, w.timeMs, pinnedMandateHash);
  if (!gate.ok || !gate.keys.map((k) => k.toLowerCase()).includes(w.keyHex)) return { ok: false, code: "key-not-authorized" };
  let good = false;
  try {
    good = ed.verify(fromHex(w.signature), canonicalSignedTime(nonceHex, w.timeMs), fromHex(w.keyHex));
  } catch {
    good = false;
  }
  return good ? { ok: true, timeMs: w.timeMs } : { ok: false, code: "signature" };
}

function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fromHex(s: string): Bytes {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
