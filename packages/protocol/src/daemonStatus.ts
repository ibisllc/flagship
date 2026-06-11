/**
 * STK-signed daemon-status report — the cert-fingerprint pinning primitive
 * (cert-model A′, phase 4).
 *
 * The daemon periodically POSTs this report to .com; .com verifies it,
 * stores the VERBATIM signed tuple + signature, and relays both on /pods.
 * A phone that derived the box STK locally (deriveSTK(deriveSWK(UMK,
 * serverId))) re-verifies the leaf-cert fingerprint end-to-end, so a rogue
 * .com can DROP the report but cannot FORGE one — the fingerprint a client
 * pins is the box's own word, not .com's.
 *
 * Canonical bytes (one implementation, shared by the daemon heartbeat, the
 * control-plane verifier, and every client; iOS/Android mirror this
 * byte-for-byte — see the pinned vector in tests/daemonStatus.test.ts):
 *
 *   flagship/daemon-status/v1|<serverDomain>|<certSha256 or "">|
 *   <certValidUntil or "">|<certIssuer or "">|<appsServed sorted, ","-joined>|
 *   <nonce>|<issuedAt>
 */
import { ed } from "./edSync.js";
import type { Bytes, Keypair } from "./types.js";

export interface DaemonStatusReport {
  serverDomain: string;
  /** Leaf-cert SHA-256 fingerprint: lowercase hex, no colons. Null when the
   *  box has no cert yet (liveness-only report). */
  certSha256: string | null;
  certValidUntil: number | null;
  certIssuer: string | null;
  appsServed: string[];
  nonce: string;
  issuedAt: number;
}

const TAG_DAEMON_STATUS = "flagship/daemon-status/v1";

export function canonicalDaemonStatusReport(r: DaemonStatusReport): Bytes {
  const apps = r.appsServed.slice().sort().join(",");
  return new TextEncoder().encode(
    [
      TAG_DAEMON_STATUS,
      r.serverDomain,
      r.certSha256 ?? "",
      String(r.certValidUntil ?? ""),
      r.certIssuer ?? "",
      apps,
      r.nonce,
      String(r.issuedAt),
    ].join("|"),
  );
}

export function signDaemonStatusReport(
  r: DaemonStatusReport,
  identity: Keypair,
): Bytes {
  return ed.sign(canonicalDaemonStatusReport(r), identity.privateKey);
}

export function verifyDaemonStatusReport(
  r: DaemonStatusReport,
  sig: Bytes,
  stkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalDaemonStatusReport(r), stkPub);
  } catch {
    return false;
  }
}
