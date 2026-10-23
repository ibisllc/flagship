// The security sliver (SECURITY-HARDENING-PLAN.md 18.14, N14): one persistent line per issue, never
// merged or truncated, with the platform's severity, the target, the state, when it last changed,
// and a deadline and action when there is one. Also the owner's answer to a waiting publisher key
// (18.11): trust it for ONE service with a signature from this account's own key, or reject it.
//
// The box keeps the record (server-daemon/src/securitySliver.ts) and this reads it; the app never
// sets a severity. A signed trust statement mirrors packages/protocol/src/appRelease.ts.

import { boxClient } from "./api.js";
import { bytesToHex } from "../keystore.js";
import { sensitiveSigner } from "./adminRoot.js";
import { getSession } from "./state.js";

export const TAG_PUBLISHER_TRUST = "flagship/publisher-trust/v1";

export const SEVERITY_ORDER = Object.freeze({ critical: 4, high: 3, moderate: 2, low: 1 });
export const SEVERITY_LABEL = Object.freeze({ critical: "Critical", high: "High", moderate: "Moderate", low: "Low" });

export function canonicalPublisherTrustBytes(t) {
  for (const k of ["serviceId", "appId"]) {
    if (!t[k] || /[|\u0000-\u001f\u007f]/.test(t[k])) throw new Error(`bad ${k}`);
  }
  return new TextEncoder().encode(
    [TAG_PUBLISHER_TRUST, t.serviceId, t.appId, t.identityGeneration, t.oldKeyHex, t.newKeyHex, t.newEpoch, t.issuedAt].join("|"),
  );
}

/** "3 days 4 hours left", "overdue by 2 hours", or "" when there is no deadline. Pure. */
export function remainingText(remainingMs) {
  if (remainingMs === null || remainingMs === undefined) return "";
  const abs = Math.abs(remainingMs);
  const day = 86_400_000, hour = 3_600_000, min = 60_000;
  let body;
  if (abs >= day) body = `${Math.floor(abs / day)} day${Math.floor(abs / day) === 1 ? "" : "s"} ${Math.floor((abs % day) / hour)} hours`;
  else if (abs >= hour) body = `${Math.floor(abs / hour)} hour${Math.floor(abs / hour) === 1 ? "" : "s"} ${Math.floor((abs % hour) / min)} minutes`;
  else body = `${Math.max(1, Math.floor(abs / min))} minute${Math.floor(abs / min) <= 1 ? "" : "s"}`;
  return remainingMs >= 0 ? `${body} left` : `overdue by ${body}`;
}

/** What each line shows. One model per line, in the order the box sent (worst first). Pure. */
export function sliverModel(lines, formatTime = (ms) => new Date(ms).toLocaleString()) {
  return (lines ?? []).map((l) => ({
    key: l.eventId,
    severity: l.severity,
    severityLabel: SEVERITY_LABEL[l.severity] ?? l.severity,
    active: l.state === "active",
    stateLabel: l.state === "active" ? "Active" : "Resolved",
    target: l.target,
    summary: l.summary,
    updated: formatTime(l.updatedAt),
    deadline: remainingText(l.remainingMs),
    action: l.state === "active" ? l.action : null,
    publisherKey: l.kind === "publisher-key" && l.state === "active" ? l.target : null,
  }));
}

export async function fetchSliver(podFqdn = "") {
  const c = boxClient(podFqdn);
  if (!c.baseUrl || !c.token()) return null;
  return c.fetch("/api/screens/security-sliver");
}

export async function fetchWaitingPublisher(serviceId, podFqdn = "") {
  return boxClient(podFqdn).fetch(`/api/screens/services/${encodeURIComponent(serviceId)}/publisher`);
}

/**
 * Trust the waiting key for one service: sign exactly "this service, this old key to this new key"
 * with the account's sensitive signer (the admin root when the account pins one), behind the same
 * biometric as any sensitive order. The box checks the signature against that key.
 */
export async function trustPublisherKey(serviceId, deps = {}) {
  const info = await (deps.fetchWaiting ?? fetchWaitingPublisher)(serviceId);
  if (!info?.waiting) throw new Error("No new key is waiting for this service.");
  const trust = { ...info.waiting.trust, issuedAt: (deps.now ?? Date.now)() };
  const sign = deps.signer ?? sensitiveSigner();
  const session = deps.session ?? getSession();
  const sig = await sign(session.umk, canonicalPublisherTrustBytes(trust));
  const body = JSON.stringify({ trust, signatureHex: typeof sig === "string" ? sig : bytesToHex(sig) });
  return (deps.post ?? ((path, b) => boxClient().fetch(path, { method: "POST", body: b })))(`/api/screens/services/${encodeURIComponent(serviceId)}/publisher/trust`, body);
}

export async function rejectPublisherKey(serviceId, deps = {}) {
  return (deps.post ?? ((path) => boxClient().fetch(path, { method: "POST", body: "{}" })))(`/api/screens/services/${encodeURIComponent(serviceId)}/publisher/reject`, "{}");
}
