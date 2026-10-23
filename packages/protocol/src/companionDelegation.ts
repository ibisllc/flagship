/**
 * A phone-signed delegation to a Remote (browser) session: build and/or deploy ONE named app, until a
 * time no later than the session's own end (SECURITY-HARDENING-PLAN.md §16.2, SEC-AUTH-002).
 * A Remote session is read-only without one. The signature names the session (the id the owner's
 * session list shows), the app, the operations and the window, so it can neither be moved to another
 * browser or app nor widened.
 *
 *   flagship/companion-delegation/v1|<sessionId>|<serviceRef>|<ops>|<issuedAt>|<expiresAt>
 *
 * `ops` is the permitted operations, sorted and comma-separated, from {@link COMPANION_DELEGATION_OPS}.
 */
import { ed } from "./edSync.js";
import { resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_COMPANION_DELEGATION = "flagship/companion-delegation/v1";
export const COMPANION_DELEGATION_OPS = ["build", "deploy"] as const;
export type CompanionDelegationOp = (typeof COMPANION_DELEGATION_OPS)[number];

/** Longest a delegation may run, whatever the phone signs. */
export const COMPANION_DELEGATION_MAX_MS = 24 * 3600_000;

const SESSION_ID_RE = /^[0-9a-f]{16}$/;
const SERVICE_REF_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

export interface CompanionDelegation {
  sessionId: string;
  serviceRef: string;
  ops: CompanionDelegationOp[];
  issuedAt: number;
  expiresAt: number;
}

export function canonicalCompanionDelegation(d: CompanionDelegation): Bytes {
  if (!SESSION_ID_RE.test(d.sessionId)) throw new Error(`${TAG_COMPANION_DELEGATION}: bad sessionId`);
  if (!SERVICE_REF_RE.test(d.serviceRef)) throw new Error(`${TAG_COMPANION_DELEGATION}: bad serviceRef`);
  if (!Array.isArray(d.ops) || d.ops.length === 0 || d.ops.some((o) => !COMPANION_DELEGATION_OPS.includes(o))) {
    throw new Error(`${TAG_COMPANION_DELEGATION}: bad ops`);
  }
  if (!Number.isSafeInteger(d.issuedAt) || d.issuedAt < 0) throw new Error(`${TAG_COMPANION_DELEGATION}: bad issuedAt`);
  if (!Number.isSafeInteger(d.expiresAt) || d.expiresAt <= d.issuedAt) throw new Error(`${TAG_COMPANION_DELEGATION}: bad expiresAt`);
  const ops = [...new Set(d.ops)].sort().join(",");
  return new TextEncoder().encode([TAG_COMPANION_DELEGATION, d.sessionId, d.serviceRef, ops, String(d.issuedAt), String(d.expiresAt)].join("|"));
}

export function signCompanionDelegation(d: CompanionDelegation, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(canonicalCompanionDelegation(d));
}

export function verifyCompanionDelegation(d: CompanionDelegation, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalCompanionDelegation(d), pub);
  } catch {
    return false;
  }
}

export function parseCompanionDelegation(v: unknown): CompanionDelegation | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || typeof r.serviceRef !== "string" || !Array.isArray(r.ops)) return null;
  if (typeof r.issuedAt !== "number" || typeof r.expiresAt !== "number") return null;
  const d: CompanionDelegation = { sessionId: r.sessionId, serviceRef: r.serviceRef, ops: r.ops as CompanionDelegationOp[], issuedAt: r.issuedAt, expiresAt: r.expiresAt };
  try {
    canonicalCompanionDelegation(d);
  } catch {
    return null;
  }
  return d;
}
