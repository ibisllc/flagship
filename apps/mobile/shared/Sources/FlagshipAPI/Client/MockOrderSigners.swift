#if DEBUG
import Foundation
import CryptoKit

/// Gym-only: the keys the mock `.com` and mock boxes hold for the smoke
/// account, so every mock checks a signed order the way the real one does
/// (packages/control-plane/src/adminAuthorityGate.ts and the daemon's
/// adminAuthorityLocal.ts). The smoke account is admin-pinned like every
/// account opened today: a sensitive order must verify under the admin
/// master root, and the account IRK no longer authorizes one. Only when no
/// admin root is pinned does the IRK stand in (accounts that predate it).
///
/// Off (nothing pinned) by default, so unit tests that build mocks directly
/// keep accepting any signature; the `-smoke-mode` seam turns it on.
public final class MockOrderSigners: @unchecked Sendable {
    public static let shared = MockOrderSigners()

    /// Which key the real endpoint accepts for an order.
    public enum Authority: Sendable {
        /// Admin root when pinned, else the IRK (`authorizeSensitiveComOp`).
        case sensitive
        /// The account IRK only (e.g. revoking a lost server).
        case irk
    }

    public enum Signer: String, Sendable, Equatable {
        case adminRoot = "admin-root"
        case irk
        case share
    }

    public struct Seen: Equatable, Sendable {
        public let kind: String
        public let signer: Signer
    }

    private let lock = NSLock()
    private var adminRoot: Curve25519.Signing.PublicKey?
    private var irk: Curve25519.Signing.PublicKey?
    private var shareKeys: [String: Curve25519.Signing.PublicKey] = [:]
    private var canonical: [String: @Sendable (Any) -> Data?] = [:]
    private var seenOrders: [Seen] = []

    public init() {}

    /// Pin the account's keys. `adminRoot` nil = an account with no admin root.
    public func pin(adminRoot: Curve25519.Signing.PublicKey?, irk: Curve25519.Signing.PublicKey?) {
        lock.withLock {
            self.adminRoot = adminRoot
            self.irk = irk
            seenOrders = []
        }
    }

    /// The per-share key a co-manager signs with on a shared server.
    public func pinShareKey(_ key: Curve25519.Signing.PublicKey, shareId: String) {
        lock.withLock { shareKeys[shareId] = key }
    }

    /// How to build the canonical bytes of an order whose encoding lives
    /// above this module (FlagshipCore); `payload` is what the mock received.
    public func registerCanonical(_ kind: String, _ build: @escaping @Sendable (Any) -> Data?) {
        lock.withLock { canonical[kind] = build }
    }

    public var isEnforcing: Bool { lock.withLock { adminRoot != nil || irk != nil } }

    /// Every order a mock accepted, oldest first, with the key that signed it.
    public var seen: [Seen] { lock.withLock { seenOrders } }

    public func reset() {
        lock.withLock {
            adminRoot = nil
            irk = nil
            shareKeys = [:]
            seenOrders = []
        }
    }

    /// The refusal the real endpoints send for a signature they don't accept.
    public static let refusal = ScreensClientError.http(status: 403, message: #"{"error":"invalid signature"}"#)

    /// Throws the endpoint's 403 unless `signatureHex` over `bytes` is by
    /// the key `authority` names. A no-op while nothing is pinned.
    @discardableResult
    public func require(_ authority: Authority, kind: String, signatureHex: String, over bytes: Data?) throws -> Signer? {
        let (admin, irkKey) = lock.withLock { (adminRoot, irk) }
        guard admin != nil || irkKey != nil else { return nil }
        guard let bytes, let sig = Self.hex(signatureHex), sig.count == 64 else { return try refuse(kind) }
        let signer: Signer?
        switch authority {
        case .sensitive:
            if let admin {
                signer = admin.isValidSignature(sig, for: bytes) ? .adminRoot : nil
            } else {
                signer = irkKey?.isValidSignature(sig, for: bytes) == true ? .irk : nil
            }
        case .irk:
            signer = irkKey?.isValidSignature(sig, for: bytes) == true ? .irk : nil
        }
        guard let signer else { return try refuse(kind) }
        lock.withLock { seenOrders.append(Seen(kind: kind, signer: signer)) }
        GymProbe.note("signed \(kind) by \(signer.rawValue)")
        return signer
    }

    /// As `require(_:kind:signatureHex:over:)`, with the bytes built by the
    /// builder registered for `kind`.
    @discardableResult
    public func require(_ authority: Authority, kind: String, signatureHex: String, payload: Any) throws -> Signer? {
        guard isEnforcing else { return nil }
        let build = lock.withLock { canonical[kind] }
        return try require(authority, kind: kind, signatureHex: signatureHex, over: build?(payload))
    }

    /// A co-manager's order on a shared server: signed by that share's key.
    @discardableResult
    public func requireShare(shareId: String, kind: String, signatureHex: String, over bytes: Data?) throws -> Signer? {
        guard isEnforcing else { return nil }
        let key = lock.withLock { shareKeys[shareId] }
        guard let key, let bytes, let sig = Self.hex(signatureHex), key.isValidSignature(sig, for: bytes) else {
            return try refuse(kind)
        }
        lock.withLock { seenOrders.append(Seen(kind: kind, signer: .share)) }
        GymProbe.note("signed \(kind) by share")
        return .share
    }

    private func refuse(_ kind: String) throws -> Signer? {
        GymProbe.note("refused \(kind)")
        throw Self.refusal
    }

    static func hex(_ s: String) -> Data? {
        guard s.count % 2 == 0 else { return nil }
        var out = Data(capacity: s.count / 2)
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            guard let b = UInt8(s[i..<j], radix: 16) else { return nil }
            out.append(b)
            i = j
        }
        return out
    }
}
#endif
