import Foundation
import CryptoKit
import FlagshipAPI

/// Swift mirror of `packages/protocol/src/boxTrustStatus.ts` — canonical bytes
/// + Ed25519 verify for the box's STK-signed PER-BOX relay-trust verdict.
///
/// Each box independently verifies the ServiceBlessing it is handed by the
/// `.services` hub; that verdict is genuinely per-box. The daemon signs this
/// tuple with its STK; `.com` relays it VERBATIM on `/pods`
/// (`trustStatus: { report, signatureHex }`). A phone that derives the box
/// STK locally (`ServerKeys.deriveStkPub` — NOT `.com`'s echo) re-verifies
/// it end-to-end, so a rogue `.com` can DROP a report but cannot FORGE one:
/// the per-server warning a client renders is the box's own word.
///
/// SIBLING of `DaemonStatus` — do NOT fold together. Canonical bytes MUST
/// match the TS implementation byte-for-byte (pinned cross-platform vector in
/// packages/protocol/tests/boxTrustStatus.test.ts):
///
///   flagship/box-trust-status/v1|<serverDomain>|<relayVerdict>|
///   <lockedDown "1"|"0">|<failingCertHash or "">|
///   <coveringExceptionCertHash or "">|<nonce>|<issuedAt>

/// The box's verdict on the relay-class (`.services` hub) blessing it holds.
public enum RelayVerdict: String, Codable, Sendable {
    case trusted
    case untrusted
    case unknown
}

public struct BoxTrustStatusReport: Codable, Equatable, Sendable {
    public let serverDomain: String
    public let relayVerdict: RelayVerdict
    public let lockedDown: Bool
    /// relay-class cert-hash of the offending hub key, when untrusted.
    public let failingCertHash: String?
    /// relay-class cert-hash of the owner TrustException that lifted the
    /// failing verdict, when an override is in force.
    public let coveringExceptionCertHash: String?
    public let nonce: String
    public let issuedAt: Int64

    public init(
        serverDomain: String,
        relayVerdict: RelayVerdict,
        lockedDown: Bool,
        failingCertHash: String?,
        coveringExceptionCertHash: String?,
        nonce: String,
        issuedAt: Int64
    ) {
        self.serverDomain = serverDomain
        self.relayVerdict = relayVerdict
        self.lockedDown = lockedDown
        self.failingCertHash = failingCertHash
        self.coveringExceptionCertHash = coveringExceptionCertHash
        self.nonce = nonce
        self.issuedAt = issuedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.serverDomain = try c.decode(String.self, forKey: .serverDomain)
        self.relayVerdict = try c.decode(RelayVerdict.self, forKey: .relayVerdict)
        self.lockedDown = try c.decodeIfPresent(Bool.self, forKey: .lockedDown) ?? false
        self.failingCertHash = try c.decodeIfPresent(String.self, forKey: .failingCertHash)
        self.coveringExceptionCertHash = try c.decodeIfPresent(String.self, forKey: .coveringExceptionCertHash)
        self.nonce = try c.decode(String.self, forKey: .nonce)
        self.issuedAt = try c.decode(Int64.self, forKey: .issuedAt)
    }
}

public enum BoxTrustStatus {
    public static let canonicalTag = "flagship/box-trust-status/v1"

    /// Freshness bound on a relayed report, mirroring `DaemonStatus`: older
    /// than this and the verdict is treated as stale (fail-open, no alarm).
    public static let maxReportAgeMs: Int64 = 7 * 24 * 60 * 60 * 1000

    public static func canonicalBytes(_ r: BoxTrustStatusReport) -> Data {
        let segments = [
            canonicalTag,
            r.serverDomain,
            r.relayVerdict.rawValue,
            r.lockedDown ? "1" : "0",
            r.failingCertHash ?? "",
            r.coveringExceptionCertHash ?? "",
            r.nonce,
            String(r.issuedAt)
        ]
        return Data(segments.joined(separator: "|").utf8)
    }

    /// Verify the box's signature under its (locally derived) STK pubkey.
    /// Returns false — never throws — on malformed input.
    public static func verify(_ r: BoxTrustStatusReport, signature: Data, stkPub: Data) -> Bool {
        guard signature.count == 64,
              let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: stkPub)
        else { return false }
        return pub.isValidSignature(signature, for: canonicalBytes(r))
    }

    public static func verify(_ r: BoxTrustStatusReport, signatureHex: String, stkPub: Data) -> Bool {
        guard let sig = HexUtil.decode(signatureHex) else { return false }
        return verify(r, signature: sig, stkPub: stkPub)
    }
}
