import Foundation
import CryptoKit
import FlagshipAPI

/// Swift mirror of `packages/protocol/src/daemonStatus.ts` — canonical bytes
/// + Ed25519 verify for the box's STK-signed daemon-status report, the
/// cert-fingerprint pinning primitive (cert-model A′, phase 4).
///
/// The box signs the tuple with its STK; `.com` relays it VERBATIM on
/// `/pods` (`signedStatus: { report, signatureHex }`). A phone that derives
/// the box STK locally (`ServerKeys.deriveStkPub` — NOT `.com`'s
/// `identityPubKey` echo) re-verifies the leaf-cert fingerprint end-to-end,
/// so a rogue `.com` can DROP a report but cannot FORGE one.
///
/// Canonical bytes MUST match the TS implementation byte-for-byte (pinned
/// cross-platform vector in packages/protocol/tests/daemonStatus.test.ts +
/// DaemonStatusVerifierTests here):
///
///   flagship/daemon-status/v1|<serverDomain>|<certSha256 or "">|
///   <certValidUntil or "">|<certIssuer or "">|<appsServed sorted, ","-joined>|
///   <nonce>|<issuedAt>
public enum DaemonStatus {
    public static let canonicalTag = "flagship/daemon-status/v1"

    /// Freshness bound on a relayed report: older than this and the
    /// fingerprint is NOT pinned. The daemon heartbeat is 5-minutely, so 7
    /// days is generous — a report this stale means the box (or the relay)
    /// has been silent long enough that its cert may have legitimately
    /// renewed; falling back to default TLS validation (no pin) is the safe
    /// failure, never a hard fail.
    public static let maxReportAgeMs: Int64 = 7 * 24 * 60 * 60 * 1000

    public static func canonicalBytes(_ r: DaemonStatusReport) -> Data {
        let segments = [
            canonicalTag,
            r.serverDomain,
            r.certSha256 ?? "",
            r.certValidUntil.map(String.init) ?? "",
            r.certIssuer ?? "",
            r.appsServed.sorted().joined(separator: ","),
            r.nonce,
            String(r.issuedAt)
        ]
        return Data(segments.joined(separator: "|").utf8)
    }

    /// Verify the box's signature under its (locally derived) STK pubkey.
    /// Returns false — never throws — on malformed input, mirroring the TS
    /// `verifyDaemonStatusReport`.
    public static func verify(_ r: DaemonStatusReport, signature: Data, stkPub: Data) -> Bool {
        guard signature.count == 64,
              let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: stkPub)
        else { return false }
        return pub.isValidSignature(signature, for: canonicalBytes(r))
    }

    public static func verify(_ r: DaemonStatusReport, signatureHex: String, stkPub: Data) -> Bool {
        guard let sig = HexUtil.decode(signatureHex) else { return false }
        return verify(r, signature: sig, stkPub: stkPub)
    }
}
