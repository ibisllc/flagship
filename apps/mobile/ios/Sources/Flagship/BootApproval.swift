import Foundation
import CryptoKit

/// A `BootApproval` claim is what the phone signs to authorize a
/// freshly-booted server to ask `.com` for its LUKS unlock key. The
/// canonical bytes match the rest of the codebase's `flagship/<purpose>/v1`
/// pipe-separated convention, so the signature is portable across the
/// Swift, Kotlin, and TypeScript implementations.
///
/// Format of the signed material:
///   flagship/boot-approval/v1|<serverFqdn>|<requestId>|<requestedAt>|<approvedAt>
///
/// The envelope shipped to the daemon as P1.9's body is the JSON object
/// {requestId, approvedAt, serverFqdn, signature}, base64-encoded; the
/// daemon checks the signature against the BAK public key it registered
/// for this server at provisioning.
public struct BootApproval: Codable, Equatable, Sendable {
    public let requestId: String
    public let serverFqdn: String
    public let requestedAt: Int64
    public let approvedAt: Int64

    public init(requestId: String, serverFqdn: String, requestedAt: Int64, approvedAt: Int64) {
        self.requestId = requestId
        self.serverFqdn = serverFqdn
        self.requestedAt = requestedAt
        self.approvedAt = approvedAt
    }

    /// Canonical bytes — the exact byte sequence that gets signed. The
    /// daemon recomputes this from the envelope fields and verifies
    /// against the BAK public key.
    public func canonicalBytes() -> Data {
        let s = "flagship/boot-approval/v1|\(serverFqdn)|\(requestId)|\(requestedAt)|\(approvedAt)"
        return Data(s.utf8)
    }

    /// Sign with the supplied BAK (typically `Keystore.deriveBAK(...)`),
    /// returning a base64-encoded envelope + hex signature ready to ship
    /// in an `UnlockApprovalApproveRequest`.
    public func sign(with bak: Curve25519.Signing.PrivateKey) throws -> SignedBootApproval {
        let sig = try bak.signature(for: canonicalBytes())
        let envelope = try JSONEncoder().encode(self)
        return SignedBootApproval(
            envelopeBase64: envelope.base64EncodedString(),
            signatureHex: sig.map { String(format: "%02x", $0) }.joined()
        )
    }

    /// Verifier — symmetric to `sign`, used in tests and (eventually)
    /// the daemon-side iOS-shared validator.
    public static func verify(
        envelopeBase64: String,
        signatureHex: String,
        publicKey: Curve25519.Signing.PublicKey
    ) -> Bool {
        guard let envelopeData = Data(base64Encoded: envelopeBase64),
              let claim = try? JSONDecoder().decode(BootApproval.self, from: envelopeData),
              let sig = Data(hex: signatureHex) else { return false }
        return publicKey.isValidSignature(sig, for: claim.canonicalBytes())
    }
}

public struct SignedBootApproval: Equatable, Sendable {
    public let envelopeBase64: String
    public let signatureHex: String
    public init(envelopeBase64: String, signatureHex: String) {
        self.envelopeBase64 = envelopeBase64
        self.signatureHex = signatureHex
    }
}

private extension Data {
    init?(hex: String) {
        let cleaned = hex.replacingOccurrences(of: " ", with: "")
        guard cleaned.count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(cleaned.count / 2)
        var i = cleaned.startIndex
        while i < cleaned.endIndex {
            let next = cleaned.index(i, offsetBy: 2)
            guard let b = UInt8(cleaned[i..<next], radix: 16) else { return nil }
            bytes.append(b)
            i = next
        }
        self.init(bytes)
    }
}
