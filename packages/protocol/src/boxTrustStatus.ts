/**
 * STK-signed box-trust-status report — the PER-BOX relay-trust verdict
 * primitive (maintainer-trust enforcement, "per-server" surfacing).
 *
 * Each box independently verifies the ServiceBlessing (relay-class trust)
 * it is handed by the `.services` hub. That verdict is genuinely per-box —
 * two boxes on the same account can disagree if one is handed a stale or
 * invalid blessing. The daemon emits this SIGNED report on its heartbeat;
 * `.com` relays the VERBATIM signed tuple + signature on /pods; a client
 * that derived the box STK locally re-verifies it end-to-end, so a rogue
 * `.com` can DROP the report but cannot FORGE one — the verdict a client
 * renders is the box's own word, not `.com`'s.
 *
 * This is a SIBLING of daemonStatus.ts — do NOT fold it into that report:
 * the daemon-status canonical bytes are pinned across three platforms and
 * carry cert-fingerprint pinning, an orthogonal concern with its own
 * cadence. Keep the two envelopes independent.
 *
 * Canonical bytes (one implementation, shared by the daemon heartbeat, the
 * control-plane relay, and every client; iOS/Android mirror this
 * byte-for-byte — see the pinned vector in tests/boxTrustStatus.test.ts):
 *
 *   flagship/box-trust-status/v1|<serverDomain>|<relayVerdict>|
 *   <lockedDown "1"|"0">|<failingCertHash or "">|
 *   <coveringExceptionCertHash or "">|<nonce>|<issuedAt>
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./auth.js";
import { resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

/**
 * The box's verdict on the relay-class (`.services` hub) blessing it holds:
 *   trusted   — a currently-valid ServiceBlessing verified against the pin.
 *   untrusted — a blessing was expected but is missing/expired/invalid (RAISE).
 *   unknown   — trust enforcement is not configured / not yet evaluated
 *               (e.g. a transient network blip; stays fail-open, no alarm).
 */
export type RelayVerdict = "trusted" | "untrusted" | "unknown";

export interface BoxTrustStatusReport {
  serverDomain: string;
  relayVerdict: RelayVerdict;
  /** True when the box has entered relay-lockdown (data plane sealed). */
  lockedDown: boolean;
  /** relay-class cert-hash of the offending hub key, when untrusted. */
  failingCertHash: string | null;
  /** relay-class cert-hash of the owner TrustException that lifted the
   *  failing verdict, when an override is in force. */
  coveringExceptionCertHash: string | null;
  nonce: string;
  issuedAt: number;
}

const TAG_BOX_TRUST_STATUS = "flagship/box-trust-status/v1";

export function canonicalBoxTrustStatusReport(r: BoxTrustStatusReport): Bytes {
  legacyFieldGuard("serverDomain", r.serverDomain);
  legacyFieldGuard("relayVerdict", r.relayVerdict);
  if (r.failingCertHash !== null)
    legacyFieldGuard("failingCertHash", r.failingCertHash);
  if (r.coveringExceptionCertHash !== null)
    legacyFieldGuard("coveringExceptionCertHash", r.coveringExceptionCertHash);
  legacyFieldGuard("nonce", r.nonce);
  return new TextEncoder().encode(
    [
      TAG_BOX_TRUST_STATUS,
      r.serverDomain,
      r.relayVerdict,
      r.lockedDown ? "1" : "0",
      r.failingCertHash ?? "",
      r.coveringExceptionCertHash ?? "",
      r.nonce,
      String(r.issuedAt),
    ].join("|"),
  );
}

export function signBoxTrustStatusReport(
  r: BoxTrustStatusReport,
  identity: MsgSigner,
): Bytes {
  // Accepts the STK `Keypair` or a `sign(msg)` closure (custodian-backed);
  // signature bytes are identical either way.
  return resolveMsgSigner(identity)(canonicalBoxTrustStatusReport(r));
}

export function verifyBoxTrustStatusReport(
  r: BoxTrustStatusReport,
  sig: Bytes,
  stkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalBoxTrustStatusReport(r), stkPub);
  } catch {
    return false;
  }
}
