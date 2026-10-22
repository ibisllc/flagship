import Foundation
import CryptoKit
import FlagshipAPI

/// Custom voi.ci names for services (docs/named-links.md), byte-identical to
/// `packages/protocol/src/voiciName.ts` (vectors in
/// `packages/protocol/test-vectors/voici-name/`). A service always keeps its
/// random code; an admin may give it ONE readable name on top. The order that
/// sets or clears it is signed with the sensitive-order key: the admin root
/// when this device holds one, else the account IRK.
public struct VoiciNameOrder: Equatable, Sendable {
    public static let tag = "flagship/voici-name/v1"

    public enum Op: String, Equatable, Sendable {
        case set
        case clear
    }

    public enum OrderError: Error, Equatable {
        case badField
        case badNonce
    }

    public let user: String
    public let serviceId: String
    /// The custom name as typed (lower case); "" when clearing.
    public let name: String
    public let op: Op
    public let issuedAt: Int64
    /// 32 random bytes, lowercase hex.
    public let nonce: String

    public init(user: String, serviceId: String, name: String, op: Op, issuedAt: Int64, nonce: String) {
        self.user = user
        self.serviceId = serviceId
        self.name = name
        self.op = op
        self.issuedAt = issuedAt
        self.nonce = nonce
    }

    public func canonicalBytes() throws -> Data {
        for field in [user, serviceId, name, nonce] where Self.hasSeparatorOrControl(field) {
            throw OrderError.badField
        }
        guard Self.isLowerHex(nonce, bytes: 32) else { throw OrderError.badNonce }
        let parts = [Self.tag, user, serviceId, name, op.rawValue, String(issuedAt), nonce]
        return Data(parts.joined(separator: "|").utf8)
    }

    public func sign(with key: Curve25519.Signing.PrivateKey) throws -> String {
        HexUtil.encode(try key.signature(for: canonicalBytes()))
    }

    public func verify(signatureHex: String, publicKey: Curve25519.Signing.PublicKey) -> Bool {
        guard Self.isLowerHex(signatureHex, bytes: 64),
              let sig = HexUtil.decode(signatureHex),
              let bytes = try? canonicalBytes() else { return false }
        return publicKey.isValidSignature(sig, for: bytes)
    }

    /// A fresh order. `name` is folded to lower case; a clear carries "".
    public static func make(
        user: String,
        serviceId: String,
        name: String,
        op: Op,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        nonce: Data = SecretRequestCoordinator.randomNonce()
    ) -> VoiciNameOrder {
        VoiciNameOrder(
            user: user.lowercased(),
            serviceId: serviceId,
            name: op == .clear ? "" : name.lowercased(),
            op: op,
            issuedAt: now,
            nonce: HexUtil.encode(nonce)
        )
    }

    private static func hasSeparatorOrControl(_ s: String) -> Bool {
        s.unicodeScalars.contains { $0.value == 0x7c || $0.value <= 0x1f || $0.value == 0x7f }
    }

    private static func isLowerHex(_ s: String, bytes: Int) -> Bool {
        s.count == bytes * 2 && s.unicodeScalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }
}

/// The name rules a client checks before asking `.com` (which stays the
/// authority on what is taken, reserved or held for a .com owner).
public enum VoiciName {
    /// Shortest (hyphens left out) and longest (hyphens counted) a name may be.
    public static let minLength = 4
    public static let maxLength = 40

    public enum Problem: Equatable, Sendable {
        case tooShort
        case tooLong
        case characters
    }

    /// `characters` covers anything but `a-z 0-9 -` and a leading, trailing or
    /// doubled hyphen. Upper case is folded, not refused.
    public static func problem(_ typed: String) -> Problem? {
        let name = typed.lowercased()
        let parts = name.split(separator: "-", omittingEmptySubsequences: false)
        let valid = parts.allSatisfy { part in
            !part.isEmpty && part.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) }
        }
        if !valid { return .characters }
        if name.count > maxLength { return .tooLong }
        if name.replacingOccurrences(of: "-", with: "").count < minLength { return .tooShort }
        return nil
    }

    /// The key two names are compared by: lower case, hyphens removed.
    public static func key(_ typed: String) -> String {
        typed.lowercased().replacingOccurrences(of: "-", with: "")
    }
}
