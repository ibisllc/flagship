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

// ---- the namespace rules (docs/voici-namespace-spec.md) --------------------------------------
//
// Usernames and custom link names share one format (D12): 3 to 30 characters, a-z 0-9 and -, no leading, trailing
// or double hyphen; a name may start with a digit (D5). Codes are minted by `.com` only: a digit first, then 0-9a-z,
// never a hyphen (D2). Every claim of any kind is unique on the safety key (D9), enforced by `.com`'s registry.

export const VOICI_NAME_MIN = 3;
export const VOICI_NAME_MAX = 30;

export type VoiciNameProblem = "too-short" | "too-long" | "characters" | "hyphens";

/**
 * What a client can check alone, for a username or a custom link name. Upper case is folded, not refused (fields
 * lower-case as people type), so the answer is about `typed.toLowerCase()`. Checked in this order: characters, then
 * hyphens, then length.
 */
export function voiciNameProblem(typed: string): VoiciNameProblem | null {
  const name = typed.toLowerCase();
  if (!/^[a-z0-9-]*$/.test(name)) return "characters";
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) return "hyphens";
  if (name.length < VOICI_NAME_MIN) return "too-short";
  if (name.length > VOICI_NAME_MAX) return "too-long";
  return null;
}

/** True when `name` is already canonical (lower case) and meets the format. */
export function isVoiciName(name: string): boolean {
  return name === name.toLowerCase() && voiciNameProblem(name) === null;
}

/**
 * The safety key every claim is unique on (D9): lower case, hyphens removed, 0 read as o and 1 as l, so
 * chess-club, chessclub and chess-c1ub can't coexist.
 */
export function voiciNameKey(typed: string): string {
  return typed.toLowerCase().replace(/-/g, "").replace(/0/g, "o").replace(/1/g, "l");
}

// ---- codes (D2, D3) -----------------------------------------------------------------------------

const CODE_FIRST = "0123456789";
const CODE_REST = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A code's shape: a digit, then 0-9a-z; never a hyphen. Codes minted before D2 may start with a letter and stay valid. */
export function isVoiciCodeShape(s: string): boolean {
  return /^[0-9][0-9a-z]+$/.test(s);
}

/** One uniformly random character of `alphabet` (rejection sampling, so no modulo bias). */
function pick(alphabet: string, random: (n: number) => Uint8Array): string {
  const limit = 256 - (256 % alphabet.length);
  for (;;) {
    for (const b of random(16)) if (b < limit) return alphabet[b % alphabet.length]!;
  }
}

/** A fresh code of `length` characters (the CODE_LENGTH setting): a digit first, the rest from 0-9a-z. */
export function mintVoiciCode(length: number, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  if (!Number.isInteger(length) || length < 2) throw new Error("code length must be an integer of at least 2");
  let out = pick(CODE_FIRST, random);
  while (out.length < length) out += pick(CODE_REST, random);
  return out;
}
