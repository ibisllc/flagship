import Foundation
import CryptoKit
import FlagshipAPI

/// Custom voi.ci names for services (docs/named-links.md), byte-identical to
/// `packages/protocol/src/voiciName.ts` (vectors in
/// `packages/protocol/test-vectors/voici-name/`). A service always keeps its
/// random code; an admin may give it ONE readable name on top. The order that
/// sets or clears it is signed with the sensitive-order key: the admin root
/// when this device holds one, else the account IRK. The name rules (`VoiciName`)
/// live in FlagshipAPI, so the client's username checks use them too.
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
