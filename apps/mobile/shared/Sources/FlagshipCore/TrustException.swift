import Foundation
import CryptoKit

/// An owner-signed, per-cert trust EXCEPTION — the recovery primitive for the
/// maintainer-trust gate. When the control-server (or relay) blessing fails
/// verification and the owner deliberately chooses to proceed anyway, the
/// granting phone signs this with its device key (the biometric-gated IRK),
/// scoped to EXACTLY one cert-hash. It is safe to route through a
/// possibly-rogue `.com` because it is device-key-signed and cert-hash-scoped:
/// `.com` can drop or replay it but cannot forge it, and replaying "accept
/// cert X" is harmless. The red sliver line persists after override so the
/// degraded state stays visible.
///
/// Canonical bytes (byte-identical TS / Swift / Kotlin — pinned cross-platform
/// vector):
///
///   flagship/trust-exception/v1|<certClass>|<certHash>|<grantedAt>|<grantedByDevicePub>
public struct TrustException: Equatable, Sendable {
    public static let canonicalTag = "flagship/trust-exception/v1"

    /// Which blessing this exception covers — control-server or relay.
    public enum CertClass: String, Equatable, Sendable, CaseIterable {
        case control
        case relay
    }

    public let certClass: CertClass
    /// `sha256hex(utf8(caPubkey))` — the cert-hash slug source. Lower-case hex.
    public let certHash: String
    public let grantedAt: Int64
    /// Hex of the granting device's Ed25519 public key (the IRK pub).
    public let grantedByDevicePub: String

    public init(certClass: CertClass, certHash: String, grantedAt: Int64, grantedByDevicePub: String) {
        self.certClass = certClass
        self.certHash = certHash
        self.grantedAt = grantedAt
        self.grantedByDevicePub = grantedByDevicePub
    }

    /// `sha256hex(utf8(caPubkey))` — the cert-hash the sliver slugs and the
    /// exception scopes. The control bytes the daemon-status pin uses, applied
    /// to the served CA pubkey.
    public static func certHash(forCaPubkey caPubkey: String) -> String {
        HexUtil.encode(Data(SHA256.hash(data: Data(caPubkey.utf8))))
    }

    public func canonicalBytes() -> Data {
        Data(
            [Self.canonicalTag, certClass.rawValue, certHash, String(grantedAt), grantedByDevicePub]
                .joined(separator: "|").utf8
        )
    }

    public func sign(with key: Curve25519.Signing.PrivateKey) throws -> Data {
        try key.signature(for: canonicalBytes())
    }

    /// `{ request, signature }` body — the same envelope shape the IRK-signed
    /// power/journal endpoints use. Propagated via `.com`'s directory.
    public func envelope(signatureHex: String) -> [String: Any] {
        [
            "request": [
                "certClass": certClass.rawValue,
                "certHash": certHash,
                "grantedAt": grantedAt,
                "grantedByDevicePub": grantedByDevicePub,
            ],
            "signature": signatureHex,
        ]
    }

    /// The WIRE envelope `POST /api/users/:u/trust-exceptions` expects — the
    /// same shape the webapp posts and `handleStoreTrustException` +
    /// `verifyTrustException` read (`kind`/`version`/fields/`signatures[]`).
    /// This is the shape that FANS OUT: `.com` stores it, and every box pulls
    /// it via resolveTrustExceptions, so one phone override silences the
    /// warning on all affected servers.
    public func wireEnvelope(signatureHex: String) -> [String: Any] {
        [
            "kind": "TrustException",
            "version": 1,
            "certClass": certClass.rawValue,
            "certHash": certHash,
            "grantedAt": grantedAt,
            "grantedByDevicePub": grantedByDevicePub,
            "signatures": [["pubkey": grantedByDevicePub, "sig": signatureHex]],
        ]
    }
}
