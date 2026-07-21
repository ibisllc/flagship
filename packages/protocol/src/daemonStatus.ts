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
import { legacyFieldGuard } from "./auth.js";
import { resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

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
  legacyFieldGuard("serverDomain", r.serverDomain);
  if (r.certSha256 !== null) legacyFieldGuard("certSha256", r.certSha256);
  if (r.certIssuer !== null) legacyFieldGuard("certIssuer", r.certIssuer);
  for (const app of r.appsServed) legacyFieldGuard("appServed", app);
  legacyFieldGuard("nonce", r.nonce);
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
  identity: MsgSigner,
): Bytes {
  // Accepts the STK `Keypair` or a `sign(msg)` closure (custodian-backed);
  // signature bytes are identical either way.
  return resolveMsgSigner(identity)(canonicalDaemonStatusReport(r));
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
