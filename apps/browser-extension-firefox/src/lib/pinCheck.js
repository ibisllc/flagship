// The certificate pin check (docs/browser-extension.md "As built"). Pure: the background page feeds it the leaf
// fingerprint Firefox reports for a connection and the boxes the owner's phone paired; it never touches the network.
//
// Same rule as the phones (CertPinRegistry.swift, CertPinRegistry.kt): a box's pin is the leaf fingerprint the box
// signed with its server key, verified under the key the owner's PHONE pinned (never one .com or the box reports);
// a box name and every name under it share the box's wildcard certificate. A mismatch is a hard stop.

import { DATA_APEX, DIRECT_APEX, MAX_CLOCK_SKEW_MS, MAX_EVIDENCE_AGE_MS } from "./config.js";
import { parseReport, verifyDaemonStatus } from "./daemonStatus.js";

const HEX64 = /^[0-9a-f]{64}$/;

export function normalizeHost(host) {
  let h = String(host ?? "").trim().toLowerCase();
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** "AB:CD:…" (Firefox's securityInfo) or plain hex → 64 lowercase hex, else null. */
export function normalizeFingerprint(fp) {
  const h = String(fp ?? "").replace(/:/g, "").trim().toLowerCase();
  return HEX64.test(h) ? h : null;
}

const under = (host, apex) => host.length > apex.length + 1 && host.endsWith(`.${apex}`);

/** A name the extension looks at: a box or app name, or a direct name. */
export function isFlagshipHost(host) {
  const h = normalizeHost(host);
  return under(h, DATA_APEX) || under(h, DIRECT_APEX);
}

/**
 * The paired box whose certificate covers `host`: the box name itself or a name under it. Exact label
 * matching, never a substring, so `evilhome.alice.flagship.services` is not under `home.alice.flagship.services`.
 */
export function boxFor(host, boxes) {
  const h = normalizeHost(host);
  let best = null;
  for (const box of Object.values(boxes ?? {})) {
    const d = normalizeHost(box?.serverDomain);
    if (!d || !under(d, DATA_APEX)) continue;
    if ((h === d || h.endsWith(`.${d}`)) && (!best || d.length > normalizeHost(best.serverDomain).length)) best = box;
  }
  return best;
}

/**
 * The verdict for one connection:
 *   match             the leaf is the one the box signed, and the signature is less than a week old
 *   expired-evidence  the leaf is the one the box signed, but that signature is older than a week
 *   mismatch          a paired box's name served a different certificate: stop
 *   no-evidence       a paired box the extension has no signed fingerprint for yet
 *   unknown-name      not a paired box's name (Firefox's own checks stand)
 * A direct name (`*.fshp.app`) belongs to no box by name; it is a match only when its leaf is one a paired box
 * signed, otherwise unknown.
 */
export function checkPin({ host, servedSha256, boxes, now, maxAgeMs = MAX_EVIDENCE_AGE_MS }) {
  const h = normalizeHost(host);
  const served = normalizeFingerprint(servedSha256);
  if (!isFlagshipHost(h)) return { verdict: "unknown-name" };
  const box = boxFor(h, boxes);
  if (!box) {
    if (under(h, DIRECT_APEX) && served) {
      for (const b of Object.values(boxes ?? {})) {
        if (b?.evidence?.certSha256 === served) return fresh(b, now, maxAgeMs);
      }
    }
    return { verdict: "unknown-name" };
  }
  const evidence = box.evidence;
  if (!evidence || !HEX64.test(evidence.certSha256 ?? "")) return { verdict: "no-evidence", serverDomain: box.serverDomain };
  if (!served || served !== evidence.certSha256) {
    return { verdict: "mismatch", serverDomain: box.serverDomain, expected: evidence.certSha256, served };
  }
  return fresh(box, now, maxAgeMs);
}

function fresh(box, now, maxAgeMs) {
  const age = now - box.evidence.issuedAt;
  return { verdict: age > maxAgeMs ? "expired-evidence" : "match", serverDomain: box.serverDomain };
}

/** What to do with a verdict before trying to refresh: allow, block, or fetch the box's fresh fingerprint first. */
export function needsRefresh(verdict) {
  return verdict === "mismatch" || verdict === "no-evidence" || verdict === "expired-evidence";
}

/** What to do with a verdict once a refresh has been tried. Only a mismatch is blocked. */
export function finalAction(verdict) {
  return verdict === "mismatch" ? "block" : "allow";
}

/**
 * Take a box's freshly served signed fingerprint (`GET /api/companion/cert-pin`) as its new pin, or say why not.
 * `servedSha256` is the leaf of the very connection that carried it: the box's word must name the certificate
 * this connection used, or someone in the middle relayed it. Rejects a report older than the one held.
 */
export async function acceptEvidence({ box, body, servedSha256, now, subtle }) {
  const report = parseReport(body?.report);
  if (!report) return { ok: false, reason: "malformed" };
  if (normalizeHost(report.serverDomain) !== normalizeHost(box.serverDomain)) return { ok: false, reason: "other-server" };
  const cert = normalizeFingerprint(report.certSha256);
  if (!cert || cert !== report.certSha256) return { ok: false, reason: "malformed" };
  if (!(await verifyDaemonStatus(report, body?.signatureHex, box.stkPubHex, subtle))) return { ok: false, reason: "bad-signature" };
  if (report.issuedAt > now + MAX_CLOCK_SKEW_MS) return { ok: false, reason: "from-the-future" };
  if (now - report.issuedAt > MAX_EVIDENCE_AGE_MS) return { ok: false, reason: "too-old" };
  if (box.evidence && report.issuedAt < box.evidence.issuedAt) return { ok: false, reason: "older-than-held" };
  const served = normalizeFingerprint(servedSha256);
  if (!served || served !== cert) return { ok: false, reason: "served-other-certificate", expected: cert, served };
  return {
    ok: true,
    evidence: { certSha256: cert, certValidUntil: report.certValidUntil, issuedAt: report.issuedAt },
  };
}
