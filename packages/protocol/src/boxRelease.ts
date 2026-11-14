/**
 * "Release this box" (docs/retail-box-setup.md §7.8, §8.2, §15.3): the owner's admin root orders a
 * retail box wiped back to unclaimed, so it can be sold on or returned. Releasing always wipes
 * (owner, 2026-11-14); keeping the data is a backup or the transfer-a-box flow.
 *
 *   flagship/box-release/v1|<serverDomain>|<stkPubHex>|<issuedAt>|<nonceHex>
 *
 * Signed by the account's admin root only: the IRK and admin-granted device keys are refused, so
 * a co-manager, a non-admin device or a recovery mid-wait can never empty a box. `stkPubHex` is the
 * box's own Ed25519 server key, so an order for one box never releases another of the same name
 * (a replaced or re-claimed box); `nonceHex` (16 bytes) makes each order single use on the box.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

export const TAG_BOX_RELEASE = "flagship/box-release/v1";
/** How far an order's `issuedAt` may be from the box clock. */
export const BOX_RELEASE_MAX_SKEW_MS = 10 * 60_000;

export interface BoxReleaseOrder {
  serverDomain: string;
  /** The box's Ed25519 server key, lowercase hex. */
  stkPubHex: string;
  /** Unix ms. */
  issuedAt: number;
  /** 16 random bytes, lowercase hex. */
  nonceHex: string;
}

const DOMAIN = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const STK = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;

/** The reason an order has a bad shape (a code, not a sentence), or null. */
export function boxReleaseProblem(o: BoxReleaseOrder): "domain" | "stk" | "time" | "nonce" | null {
  if (!o || typeof o.serverDomain !== "string" || !DOMAIN.test(o.serverDomain)) return "domain";
  if (typeof o.stkPubHex !== "string" || !STK.test(o.stkPubHex)) return "stk";
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt <= 0) return "time";
  if (typeof o.nonceHex !== "string" || !NONCE.test(o.nonceHex)) return "nonce";
  return null;
}

export function canonicalBoxRelease(o: BoxReleaseOrder): Bytes {
  const p = boxReleaseProblem(o);
  if (p) throw new Error(`box release order: bad ${p}`);
  legacyFieldGuard("serverDomain", o.serverDomain);
  return new TextEncoder().encode([TAG_BOX_RELEASE, o.serverDomain, o.stkPubHex, String(o.issuedAt), o.nonceHex].join("|"));
}

/** Sign with the account's admin root. */
export function signBoxRelease(o: BoxReleaseOrder, adminRoot: Keypair): Bytes {
  return ed.sign(canonicalBoxRelease(o), adminRoot.privateKey);
}

/** Never throws. A bad shape never verifies. */
export function verifyBoxRelease(o: BoxReleaseOrder, sig: Bytes, adminRootPub: Bytes): boolean {
  try {
    if (boxReleaseProblem(o) || sig.length !== 64 || adminRootPub.length !== 32) return false;
    return ed.verify(sig, canonicalBoxRelease(o), adminRootPub);
  } catch {
    return false;
  }
}

/** Reads `{serverDomain, stkPubHex, issuedAt, nonceHex}`; null on any other shape. */
export function parseBoxRelease(raw: unknown): BoxReleaseOrder | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.serverDomain !== "string" || typeof o.stkPubHex !== "string" || typeof o.issuedAt !== "number" || typeof o.nonceHex !== "string") return null;
  return { serverDomain: o.serverDomain, stkPubHex: o.stkPubHex, issuedAt: o.issuedAt, nonceHex: o.nonceHex };
}
