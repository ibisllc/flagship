// Let one browser session (docked through Remote) build or deploy ONE app, for a short time
// (SECURITY-HARDENING-PLAN.md §16.2, SEC-AUTH-002). A Remote session is read-only until an admin
// device signs this. It names the session, the app, the operations and the window, so it cannot be
// moved to another browser or app, or widened. Mirrors packages/protocol/src/companionDelegation.ts.

import { bytesToHex } from "../keystore.js";

export const TAG_COMPANION_DELEGATION = "flagship/companion-delegation/v1";
export const DELEGATION_OPS = Object.freeze(["build", "deploy"]);
export const DELEGATION_MAX_MS = 24 * 3600_000;

export const DELEGATION_COPY = Object.freeze({
  open: "Let it build…",
  title: "Let this browser build an app",
  intro: "A browser docked through Remote can only look. This lets it change one app you pick, for a short time. It ends on its own, or when you end it, or when the session ends.",
  build: "Change the app (build)",
  deploy: "Put changes live (deploy)",
  allow: "Allow",
  end: "End it",
  adminOnly: "Only an admin device can let a browser build.",
});

const SESSION_ID_RE = /^[0-9a-f]{16}$/;
const SERVICE_REF_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

export function canonicalCompanionDelegationBytes({ sessionId, serviceRef, ops, issuedAt, expiresAt }) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) throw new Error(`${TAG_COMPANION_DELEGATION}: bad sessionId`);
  if (typeof serviceRef !== "string" || !SERVICE_REF_RE.test(serviceRef)) throw new Error(`${TAG_COMPANION_DELEGATION}: bad serviceRef`);
  if (!Array.isArray(ops) || ops.length === 0 || ops.some((o) => !DELEGATION_OPS.includes(o))) throw new Error(`${TAG_COMPANION_DELEGATION}: bad ops`);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error(`${TAG_COMPANION_DELEGATION}: bad issuedAt`);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) throw new Error(`${TAG_COMPANION_DELEGATION}: bad expiresAt`);
  return new TextEncoder().encode([TAG_COMPANION_DELEGATION, sessionId, serviceRef, [...new Set(ops)].sort().join(","), String(issuedAt), String(expiresAt)].join("|"));
}

/** Sign (admin root, via the sensitive-order signer) and send. `durationMs` is capped at a day. */
export async function allowCompanionBuild({ sessionId, serviceRef, ops, durationMs, umk, signWithIrk }, fetchJson, now = Date.now) {
  if (!umk || typeof signWithIrk !== "function") throw new Error("unlock the webapp first");
  const issuedAt = now();
  const delegation = { sessionId, serviceRef, ops: [...new Set(ops)].sort(), issuedAt, expiresAt: issuedAt + Math.min(Math.max(durationMs, 60_000), DELEGATION_MAX_MS) };
  const sig = await signWithIrk(umk, canonicalCompanionDelegationBytes(delegation));
  return fetchJson("/api/screens/companion-delegation", { method: "POST", body: JSON.stringify({ delegation, signature: bytesToHex(sig) }) });
}

export function listCompanionDelegations(sessionId, fetchJson) {
  return fetchJson(`/api/screens/companion-delegation?sessionId=${encodeURIComponent(sessionId)}`);
}

export function endCompanionDelegation(sessionId, serviceRef, fetchJson) {
  return fetchJson("/api/screens/companion-delegation", { method: "DELETE", body: JSON.stringify({ sessionId, serviceRef }) });
}
