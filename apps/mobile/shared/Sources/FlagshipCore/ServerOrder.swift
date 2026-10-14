import Foundation
import CryptoKit
import FlagshipAPI

/// The owner's server order (docs/server-order.md), byte-identical to
/// `packages/protocol/src/serverOrder.ts` (vectors in
/// `packages/protocol/test-vectors/server-order/`). The first server in the
/// order that is up leads; the role passes down the list. Signed by the
/// sensitive-order key: the admin master root when this device holds one,
/// else the account IRK.
public struct ServerOrder: Equatable, Sendable {
    public static let tag = "flagship/server-order/v1"
    public static let maxServers = 64

    public enum OrderError: Error, Equatable {
        case badList
        case badStk
        case repeated
        case badNonce
        case badIssuedAt
        case badUser
    }

    public let user: String
    /// STK public keys, lowercase hex, first = leader.
    public let stks: [String]
    public let issuedAt: Int64
    /// 32 random bytes, lowercase hex.
    public let nonce: String

    public init(user: String, stks: [String], issuedAt: Int64, nonce: String) {
        self.user = user
        self.stks = stks
        self.issuedAt = issuedAt
        self.nonce = nonce
    }

    public func canonicalBytes() throws -> Data {
        if user.isEmpty || user.contains("|") || user.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) {
            throw OrderError.badUser
        }
        guard !stks.isEmpty, stks.count <= Self.maxServers else { throw OrderError.badList }
        var seen = Set<String>()
        for s in stks {
            guard Self.isLowerHex(s, bytes: 32) else { throw OrderError.badStk }
            guard seen.insert(s).inserted else { throw OrderError.repeated }
        }
        guard Self.isLowerHex(nonce, bytes: 32) else { throw OrderError.badNonce }
        guard issuedAt > 0 else { throw OrderError.badIssuedAt }
        let parts = [Self.tag, user.lowercased(), stks.joined(separator: ","), String(issuedAt), nonce]
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

    /// A fresh order over `stks` (normalized to lowercase), dropping repeats
    /// and anything that isn't an STK, capped at `maxServers`.
    public static func make(
        user: String,
        stks: [String],
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        nonce: Data = SecretRequestCoordinator.randomNonce()
    ) -> ServerOrder {
        var seen = Set<String>()
        let clean = stks.map { $0.lowercased() }
            .filter { isLowerHex($0, bytes: 32) && seen.insert($0).inserted }
        return ServerOrder(
            user: user.lowercased(),
            stks: Array(clean.prefix(maxServers)),
            issuedAt: now,
            nonce: HexUtil.encode(nonce)
        )
    }

    public var wire: SignedServerOrderWire.Order {
        .init(user: user, stks: stks, issuedAt: issuedAt, nonce: nonce)
    }

    static func isLowerHex(_ s: String, bytes: Int) -> Bool {
        s.count == bytes * 2 && s.unicodeScalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }
}
