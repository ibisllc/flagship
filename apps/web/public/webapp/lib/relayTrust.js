// Per-cert RELAY-trust aggregation (maintainer-trust enforcement, Layer 3).
//
// Each box independently verifies the `.services` relay blessing it is handed
// and signs a `flagship/box-trust-status/v1` verdict with its STK; `.com`
// relays it VERBATIM on `/pods` (`pod.trustStatus = { report, signatureHex }`).
// This module is the CLIENT half: for every pod it
//   1. re-verifies the box-trust-status signature against that pod's STK
//      (`pod.identityPubKey` — the registered identity key, NOT `.com`'s word),
//      so a rogue `.com` can DROP a verdict but never FORGE one; and
//   2. AGGREGATES the surviving `relayVerdict === "untrusted"` reports BY
//      `failingCertHash` across ALL of a user's pods — ONE sliver line + ONE
//      biometric override per DISTINCT faulty relay authority, showing how many
//      servers it affects. One owner exception for that cert-hash is fanned out
//      by `.com` and satisfies every affected server at once.
//
// This is a NEW failing-cert SOURCE alongside the control-CA class (the
// `serverTrust` global halt). Unlike the control-CA failure it does NOT
// hard-halt `.com` I/O — it is a warning + override; the box keeps relaying
// once an owner exception covers it (Layer 1). The standing "operating under
// admin override" marker is driven from the RELAYED wire field
// `coveringExceptionCertHash` (persistent — it stays until a fresh valid
// blessing clears the box's verdict), never from local state alone.
//
// The canonical bytes MUST match packages/protocol/src/boxTrustStatus.ts
// byte-for-byte (and its Swift/Kotlin mirrors) — the box signed them.

import { verifyWithEd25519Pub, hexToBytes } from "../keystore.js";
import { serverTrust } from "./serverTrust.js";

const TAG = "flagship/box-trust-status/v1";

/** Canonical pre-image of a box-trust-status report — mirrors the protocol's
 *  `canonicalBoxTrustStatusReport` (sep "|", empty string for null fields). */
export function canonicalBoxTrustStatusBytes(r) {
  return new TextEncoder().encode(
    [
      TAG,
      String(r.serverDomain ?? ""),
      String(r.relayVerdict ?? ""),
      r.lockedDown ? "1" : "0",
      r.failingCertHash ?? "",
      r.coveringExceptionCertHash ?? "",
      String(r.nonce ?? ""),
      String(r.issuedAt ?? ""),
    ].join("|"),
  );
}

/** Verify a relayed box-trust-status report under the box's STK (hex). Returns
 *  false — never throws — on any malformed input / bad signature. */
export async function verifyBoxTrustStatus(report, signatureHex, stkPubHex) {
  try {
    if (!report || typeof report !== "object") return false;
    if (!/^[0-9a-f]{128}$/i.test(String(signatureHex || ""))) return false;
    if (!/^[0-9a-f]{64}$/i.test(String(stkPubHex || ""))) return false;
    const sig = hexToBytes(signatureHex);
    const pub = hexToBytes(stkPubHex);
    return await verifyWithEd25519Pub(pub, sig, canonicalBoxTrustStatusBytes(report));
  } catch {
    return false;
  }
}

/**
 * Aggregate the per-box relay-trust verdicts across a `/pods` list into ONE
 * entry per DISTINCT failing relay cert-hash. Each pod's signed verdict is
 * re-verified under its own STK first; an unsigned / unverifiable / non-object
 * `trustStatus` is DROPPED (a box's trust claim must be authenticated, not
 * trusted blindly). Pure aside from the crypto verify — DOM-free + testable.
 *
 * @param {Array<{ identityPubKey?:string, trustStatus?:{report:any,signatureHex:string} }>} pods
 * @param {{ verify?: typeof verifyBoxTrustStatus }} [deps]
 * @returns {Promise<Array<{ certClass:"relay", certHash:string, servers:string[], serverCount:number, overridden:boolean }>>}
 */
export async function aggregateRelayFailures(pods, deps = {}) {
  const verify = deps.verify ?? verifyBoxTrustStatus;
  /** @type {Map<string, { servers:Set<string>, overridden:boolean }>} */
  const byCert = new Map();
  for (const pod of pods ?? []) {
    const ts = pod?.trustStatus;
    if (!ts || typeof ts !== "object" || !ts.report || typeof ts.signatureHex !== "string") {
      continue;
    }
    const stk = pod?.identityPubKey;
    if (!(await verify(ts.report, ts.signatureHex, stk))) continue; // unauthenticated → drop
    const report = ts.report;
    if (report.relayVerdict !== "untrusted") continue;
    const certHash = String(report.failingCertHash || "");
    if (!/^[0-9a-f]{64}$/i.test(certHash)) continue;
    const entry = byCert.get(certHash) ?? { servers: new Set(), overridden: false };
    const domain = String(report.serverDomain || pod.serverDomain || "");
    if (domain) entry.servers.add(domain);
    // Standing override marker driven from the WIRE field: a covered box keeps
    // reporting `untrusted` for the cert but also names it as covered.
    if (report.coveringExceptionCertHash === certHash) entry.overridden = true;
    byCert.set(certHash, entry);
  }
  const out = [];
  for (const [certHash, entry] of byCert) {
    const servers = [...entry.servers].sort();
    out.push({
      certClass: "relay",
      certHash,
      servers,
      serverCount: servers.length,
      overridden: entry.overridden,
    });
  }
  out.sort((a, b) => a.certHash.localeCompare(b.certHash));
  return out;
}

/**
 * Verify + aggregate the pods' relay verdicts and push the result into the
 * shared trust store (which merges it with the control-CA source for the red
 * sliver). Best-effort — a bad snapshot just clears the relay failures.
 */
export async function updateRelayTrustFromPods(pods, deps = {}) {
  let failures = [];
  try {
    failures = await aggregateRelayFailures(pods, deps);
  } catch {
    failures = [];
  }
  serverTrust.setRelayFailures(failures);
  return failures;
}
