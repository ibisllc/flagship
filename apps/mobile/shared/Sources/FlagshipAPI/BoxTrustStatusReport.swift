import Foundation

/// The box's verdict on the relay-class (`.services` hub) blessing it holds.
public enum RelayVerdict: String, Codable, Sendable {
    case trusted
    case untrusted
    case unknown
}

/// PER-BOX relay-trust verdict — the DATA half of the box's STK-signed
/// `flagship/box-trust-status/v1` envelope (canonical bytes + verify live in
/// `FlagshipCore.BoxTrustStatus`, mirroring the `DaemonStatusReport`/
/// `DaemonStatus` split so the wire type can ride `PodDirectoryEntry` without a
/// FlagshipCore ↔ FlagshipAPI cycle).
///
/// Each box independently verifies the ServiceBlessing the `.services` hub
/// hands it; that verdict is genuinely per-box. `.com` relays this VERBATIM on
/// `/pods` (`trustStatus: { report, signatureHex }`). A phone re-verifies it
/// under the box's registered STK, so a rogue `.com` can DROP a report but not
/// FORGE one. Clients aggregate warnings by `failingCertHash` ACROSS all a
/// user's pods: one sliver line + one override per DISTINCT faulty authority.
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

    private enum CodingKeys: String, CodingKey {
        case serverDomain, relayVerdict, lockedDown, failingCertHash, coveringExceptionCertHash, nonce, issuedAt
    }
}

/// `trustStatus` on a `/pods` pod: the verbatim box-trust-status report + its
/// Ed25519 signature (hex) under the box STK. Verified by
/// `FlagshipCore.BoxTrustStatus.verify`.
public struct SignedBoxTrustStatus: Codable, Equatable, Sendable {
    public let report: BoxTrustStatusReport
    public let signatureHex: String
    public init(report: BoxTrustStatusReport, signatureHex: String) {
        self.report = report
        self.signatureHex = signatureHex
    }
}
