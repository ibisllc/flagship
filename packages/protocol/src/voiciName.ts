// Custom voi.ci names for services (docs/named-links.md).
//
// A service always has its random code; an admin may also give it ONE custom
// name, `voi.ci/<name>`. The order that sets or clears it is signed with the
// account's sensitive-order key (admin root when pinned, else the IRK):
//
//   flagship/voici-name/v1|<user>|<serviceId>|<name or "">|<set|clear>|<issuedAt>|<nonce>
//
// The rules a name must meet are here too, so every client checks the same
// grammar before it asks `.com` (which stays the authority, and also knows the
// reserved words, what is taken and the dibs window).

import { ed } from "./edSync.js";
import { validateNoSepCtrl } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

const TAG = "flagship/voici-name/v1";

export type VoiciNameOp = "set" | "clear";

export interface VoiciNameOrder {
  user: string;
  serviceId: string;
  /** The custom name as typed (lower-case); "" when clearing. */
  name: string;
  op: VoiciNameOp;
  issuedAt: number;
  /** 32 random bytes, lower-case hex: single use. */
  nonce: string;
}

export interface SignedVoiciNameOrder {
  order: VoiciNameOrder;
  /** Ed25519 over the canonical bytes, lower-case hex. */
  signature: string;
}

const enc = (s: string): Bytes => new TextEncoder().encode(s);

export function canonicalVoiciNameOrder(o: VoiciNameOrder): Bytes {
  validateNoSepCtrl("user", o.user);
  validateNoSepCtrl("serviceId", o.serviceId);
  validateNoSepCtrl("name", o.name);
  validateNoSepCtrl("nonce", o.nonce);
  return enc([TAG, o.user, o.serviceId, o.name, o.op, o.issuedAt, o.nonce].join("|"));
}

export function signVoiciNameOrder(o: VoiciNameOrder, signer: Keypair): Bytes {
  return ed.sign(canonicalVoiciNameOrder(o), signer.privateKey);
}

export function verifyVoiciNameOrder(o: VoiciNameOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalVoiciNameOrder(o), pub);
  } catch {
    return false;
  }
}

/** Shape-check an untrusted body; null when it isn't a well-formed signed order. */
export function parseSignedVoiciNameOrder(body: unknown): SignedVoiciNameOrder | null {
  const b = body as { order?: Record<string, unknown>; signature?: unknown } | null;
  const o = b?.order;
  if (
    !o ||
    typeof o.user !== "string" ||
    typeof o.serviceId !== "string" ||
    typeof o.name !== "string" ||
    (o.op !== "set" && o.op !== "clear") ||
    typeof o.issuedAt !== "number" ||
    !Number.isFinite(o.issuedAt) ||
    typeof o.nonce !== "string" ||
    !/^[0-9a-f]{64}$/.test(o.nonce) ||
    typeof b?.signature !== "string" ||
    !/^[0-9a-f]{128}$/.test(b.signature)
  ) {
    return null;
  }
  if ((o.op === "set") === (o.name === "")) return null;
  return {
    order: { user: o.user, serviceId: o.serviceId, name: o.name, op: o.op, issuedAt: o.issuedAt, nonce: o.nonce },
    signature: b.signature,
  };
}

// ---- the name rules ------------------------------------------------------------------------

/** Shortest and longest a name may be, as typed (hyphens included). */
export const VOICI_NAME_MIN = 4;
export const VOICI_NAME_MAX = 40;

export type VoiciNameProblem = "too-short" | "too-long" | "characters";

/**
 * Check what a client can check alone. `characters` covers anything but
 * `a-z 0-9 -`, a leading/trailing/doubled hyphen. The length that counts for
 * "too short" is the one without hyphens (`a-b-c-d` is the same name as `abcd`).
 * Upper case is folded, not refused: the field lower-cases as people type.
 */
export function voiciNameProblem(typed: string): VoiciNameProblem | null {
  const name = typed.toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return "characters";
  if (name.length > VOICI_NAME_MAX) return "too-long";
  if (name.replace(/-/g, "").length < VOICI_NAME_MIN) return "too-short";
  return null;
}

/**
 * The key two names are compared by: lower case, hyphens removed, so
 * `halloween-party` and `halloweenparty` can't belong to two different people.
 */
export function voiciNameKey(typed: string): string {
  return typed.toLowerCase().replace(/-/g, "");
}
