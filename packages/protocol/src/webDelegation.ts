/**
 * `flagship/web-delegation/v1` ("Sign in with Flagship", docs/voici-and-messages.md §6.4): an account-held Ed25519
 * key (the principal; for voi.ci the per-page pseudonym key P) lets a browser's non-extractable WebCrypto P-256 key B
 * sign for it, for one scope, one website origin and one audience, until `expiresAt`. Generic: voi.ci is the only
 * scope in 0.3. Revocation is `flagship/web-delegation-revoke/v1`, signed by the same principal.
 *
 *   flagship/web-delegation/v1|<scope>|<origin>|<audience>|<principalPub>|<delegateAlg>|<delegatePub>|<issuedAt>|<expiresAt>|<nonce>
 *   flagship/web-delegation-revoke/v1|<delegatePub>|<issuedAt>
 *
 * principalPub: Ed25519 hex (64). delegateAlg: "p256"; delegatePub: uncompressed SEC1 (65 bytes) hex. nonce: 16
 * bytes hex. The signature (`delegationSig`) is Ed25519 by principalPub over the canonical bytes, hex.
 *
 * Exported API: TAG_WEB_DELEGATION, TAG_WEB_DELEGATION_REVOKE, WEB_DELEGATION_SCOPES, VOICI_WEB_ORIGIN,
 * VOICI_WEB_ORIGIN_GYM, WebDelegation, WebDelegationRevoke, canonicalWebDelegation, signWebDelegation,
 * parseWebDelegation, checkWebDelegation (+ WebDelegationRefusal), canonicalWebDelegationRevoke,
 * signWebDelegationRevoke, verifyWebDelegationRevoke, parseWebDelegationRevoke.
 */
import { hex } from "./canonicalBase.js";
import { ed } from "./edSync.js";
import type { Bytes } from "./types.js";
import { ed25519VerifyHex, isLowerHex } from "./webEnvelope.js";

export const TAG_WEB_DELEGATION = "flagship/web-delegation/v1";
export const TAG_WEB_DELEGATION_REVOKE = "flagship/web-delegation-revoke/v1";
export const WEB_DELEGATION_SCOPES = ["voici-messages"] as const;
export type WebDelegationScope = (typeof WEB_DELEGATION_SCOPES)[number];
export const VOICI_WEB_ORIGIN = "https://voi.ci";
export const VOICI_WEB_ORIGIN_GYM = "https://gym.voi.ci";

export interface WebDelegation {
  scope: WebDelegationScope;
  origin: string;
  audience: string;
  principalPub: string;
  delegateAlg: "p256";
  delegatePub: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface WebDelegationRevoke {
  delegatePub: string;
  issuedAt: number;
}

const ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const AUDIENCE = /^[a-z0-9-]{1,64}$/;
const isTime = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const enc = (s: string): Bytes => new TextEncoder().encode(s);

function isP256Pub(s: unknown): s is string {
  return isLowerHex(s, 65) && (s as string).startsWith("04");
}

export function canonicalWebDelegation(d: WebDelegation): Bytes {
  if (typeof d.scope !== "string" || !WEB_DELEGATION_SCOPES.includes(d.scope)) throw new Error(`${TAG_WEB_DELEGATION}: bad scope`);
  if (typeof d.origin !== "string" || !ORIGIN.test(d.origin)) throw new Error(`${TAG_WEB_DELEGATION}: bad origin`);
  if (typeof d.audience !== "string" || !AUDIENCE.test(d.audience)) throw new Error(`${TAG_WEB_DELEGATION}: bad audience`);
  if (!isLowerHex(d.principalPub, 32)) throw new Error(`${TAG_WEB_DELEGATION}: bad principalPub`);
  if (d.delegateAlg !== "p256" || !isP256Pub(d.delegatePub)) throw new Error(`${TAG_WEB_DELEGATION}: bad delegate`);
  if (!isTime(d.issuedAt) || !isTime(d.expiresAt) || d.expiresAt <= d.issuedAt) throw new Error(`${TAG_WEB_DELEGATION}: bad time`);
  if (!isLowerHex(d.nonce, 16)) throw new Error(`${TAG_WEB_DELEGATION}: bad nonce`);
  return enc(
    [TAG_WEB_DELEGATION, d.scope, d.origin, d.audience, d.principalPub, d.delegateAlg, d.delegatePub, String(d.issuedAt), String(d.expiresAt), d.nonce].join("|"),
  );
}

/** Ed25519 signature (hex) by the principal's 32-byte seed. */
export function signWebDelegation(d: WebDelegation, principalSeed: Bytes): string {
  return hex(ed.sign(canonicalWebDelegation(d), principalSeed));
}

/** Strict shape of an untrusted delegation object (exact keys); null when malformed. */
export function parseWebDelegation(v: unknown): WebDelegation | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const keys = ["audience", "delegateAlg", "delegatePub", "expiresAt", "issuedAt", "nonce", "origin", "principalPub", "scope"];
  const got = Object.keys(r).sort();
  if (got.length !== keys.length || got.some((k, i) => k !== keys[i])) return null;
  const d = r as unknown as WebDelegation;
  try {
    canonicalWebDelegation(d);
  } catch {
    return null;
  }
  return {
    scope: d.scope,
    origin: d.origin,
    audience: d.audience,
    principalPub: d.principalPub,
    delegateAlg: d.delegateAlg,
    delegatePub: d.delegatePub,
    issuedAt: d.issuedAt,
    expiresAt: d.expiresAt,
    nonce: d.nonce,
  };
}

export type WebDelegationRefusal = "malformed" | "bad-signature" | "wrong-scope" | "wrong-origin" | "wrong-audience" | "wrong-principal" | "not-yet-valid" | "expired" | "too-long";

/**
 * Checks a delegation for a use: the signature by `principalPub`, then scope, origin, audience, principal, and
 * `now` inside [issuedAt, expiresAt). `notAfter` (the attestation's expiresAt) caps expiresAt.
 */
export function checkWebDelegation(
  d: unknown,
  signature: unknown,
  want: { scope: WebDelegationScope; origin: string; audience: string; principalPub: string; now: number; notAfter?: number },
): { ok: true; delegation: WebDelegation } | { ok: false; code: WebDelegationRefusal } {
  const p = parseWebDelegation(d);
  if (!p || typeof signature !== "string") return { ok: false, code: "malformed" };
  if (!ed25519VerifyHex(signature, canonicalWebDelegation(p), p.principalPub)) return { ok: false, code: "bad-signature" };
  if (p.scope !== want.scope) return { ok: false, code: "wrong-scope" };
  if (p.origin !== want.origin) return { ok: false, code: "wrong-origin" };
  if (p.audience !== want.audience) return { ok: false, code: "wrong-audience" };
  if (p.principalPub !== want.principalPub) return { ok: false, code: "wrong-principal" };
  if (want.notAfter !== undefined && p.expiresAt > want.notAfter) return { ok: false, code: "too-long" };
  if (want.now < p.issuedAt) return { ok: false, code: "not-yet-valid" };
  if (want.now >= p.expiresAt) return { ok: false, code: "expired" };
  return { ok: true, delegation: p };
}

export function canonicalWebDelegationRevoke(r: WebDelegationRevoke): Bytes {
  if (!isP256Pub(r.delegatePub)) throw new Error(`${TAG_WEB_DELEGATION_REVOKE}: bad delegatePub`);
  if (!isTime(r.issuedAt)) throw new Error(`${TAG_WEB_DELEGATION_REVOKE}: bad issuedAt`);
  return enc([TAG_WEB_DELEGATION_REVOKE, r.delegatePub, String(r.issuedAt)].join("|"));
}

export function signWebDelegationRevoke(r: WebDelegationRevoke, principalSeed: Bytes): string {
  return hex(ed.sign(canonicalWebDelegationRevoke(r), principalSeed));
}

export function verifyWebDelegationRevoke(r: WebDelegationRevoke, signature: string, principalPub: string): boolean {
  try {
    return ed25519VerifyHex(signature, canonicalWebDelegationRevoke(r), principalPub);
  } catch {
    return false;
  }
}

export function parseWebDelegationRevoke(v: unknown): WebDelegationRevoke | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const got = Object.keys(r).sort();
  if (got.length !== 2 || got[0] !== "delegatePub" || got[1] !== "issuedAt") return null;
  if (!isP256Pub(r.delegatePub) || !isTime(r.issuedAt)) return null;
  return { delegatePub: r.delegatePub, issuedAt: r.issuedAt };
}
