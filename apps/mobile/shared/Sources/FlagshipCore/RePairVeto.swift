import Foundation
import CryptoKit

/// An active admin's veto of a pending recovery (SECURITY-HARDENING-PLAN.md 10.6, N04).
///
/// Signed with the account's admin root, behind the device's biometric. It names the exact
/// attempt (the pending device key, when it began, its deadline), so it can never be replayed
/// onto a later attempt. Canonical bytes mirror `@flagship/protocol` `recovery.ts` and the
/// shared vectors in `packages/protocol/test-vectors/re-pair-veto/vectors.json`.
public struct RePairVeto: Equatable, Sendable {
    public static let canonicalTag = "flagship/re-pair-veto/v1"

    public let username: String
    public let newIrkPubHex: String
    public let initiatedAt: Int64
    public let completesAt: Int64
    public let vetoerPubHex: String
    public let issuedAt: Int64

    public init(username: String, newIrkPubHex: String, initiatedAt: Int64, completesAt: Int64, vetoerPubHex: String, issuedAt: Int64) {
        self.username = username; self.newIrkPubHex = newIrkPubHex; self.initiatedAt = initiatedAt
        self.completesAt = completesAt; self.vetoerPubHex = vetoerPubHex; self.issuedAt = issuedAt
    }

    public enum VetoError: Error, Equatable { case badField(String) }

    private static func guardField(_ name: String, _ v: String) throws {
        if v.isEmpty { throw VetoError.badField(name) }
        for u in v.unicodeScalars where u.value == 0x7c || u.value <= 0x1f || u.value == 0x7f { throw VetoError.badField(name) }
    }

    /// `flagship/re-pair-veto/v1|<username lowercase>|<newIrkPubHex>|<initiatedAt>|<completesAt>|<vetoerPubHex>|<issuedAt>`
    public func canonicalBytes() throws -> Data {
        try Self.guardField("username", username)
        try Self.guardField("newIrkPub", newIrkPubHex)
        try Self.guardField("vetoerPub", vetoerPubHex)
        guard initiatedAt >= 0 else { throw VetoError.badField("initiatedAt") }
        guard completesAt >= 0 else { throw VetoError.badField("completesAt") }
        guard issuedAt >= 0 else { throw VetoError.badField("issuedAt") }
        return Data([Self.canonicalTag, username.lowercased(), newIrkPubHex, String(initiatedAt), String(completesAt), vetoerPubHex, String(issuedAt)]
            .joined(separator: "|").utf8)
    }

    public func sign(with key: Curve25519.Signing.PrivateKey) throws -> Data {
        try key.signature(for: canonicalBytes())
    }
}

/// The sentences the recovery screens show, one place so the three apps agree.
public enum RecoveryReviewCopy {
    public static let confirmTitle = "Reject this recovery?"
    public static let confirmMessage = "This cancels the recovery attempt. If the real owner is trying to get back in, they will have to start again and wait the full time. Only reject it if you do not expect it."
    public static let unusualNote = "If this is unusual, please check on the physical safety of your device and server."
}
