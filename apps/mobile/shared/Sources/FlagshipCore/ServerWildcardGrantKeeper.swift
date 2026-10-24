import CryptoKit
import Foundation
import FlagshipAPI

/// The app-name certificate grant's upkeep on this device (docs/first-contact.md "App-name certificate
/// grant"): the admin device signs `flagship/server-wildcard-grant/v1` over the PINNED key in the same
/// biometric session as the first blessing, keeps the signed grant until the server takes it (the box is
/// usually not reachable yet at that moment), and an admin device that finds a server without one signs
/// it silently while the session is unlocked. On an account whose sensitive-order key is the admin root,
/// that key opens only inside a Face ID moment, so the grant is marked owed and signed at the next Face ID
/// the owner does anyway (`signOwed`).
///
/// Holds signatures only (public), in UserDefaults.
public final class ServerWildcardGrantKeeper: @unchecked Sendable {
    public static let shared = ServerWildcardGrantKeeper()

    public struct Signed: Codable, Equatable, Sendable {
        public let stkPubHex: String
        public let issuedAt: Int64
        public let signatureHex: String
    }

    private static let signedKey = "flagship.wildcardGrant.signed.v1"
    private static let owedKey = "flagship.wildcardGrant.owed.v1"
    private let defaults: UserDefaults
    private let lock = NSLock()

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    /// Hand the kept grant to the server now (set by the app: a POST to the box). Returns true when the
    /// server took it.
    public var deliver: (@Sendable (_ serverDomain: String, _ signed: Signed) async -> Bool)?

    private var signedAll: [String: Signed] {
        get {
            guard let data = defaults.data(forKey: Self.signedKey) else { return [:] }
            return (try? JSONDecoder().decode([String: Signed].self, from: data)) ?? [:]
        }
        set { defaults.set(try? JSONEncoder().encode(newValue), forKey: Self.signedKey) }
    }

    private var owedAll: [String: String] {
        get { defaults.dictionary(forKey: Self.owedKey) as? [String: String] ?? [:] }
        set { defaults.set(newValue, forKey: Self.owedKey) }
    }

    /// Sign the grant for this server's pinned key and keep it until the server takes it.
    @discardableResult
    public func sign(
        username: String, serverDomain: String, pinnedStk: Data, key: Curve25519.Signing.PrivateKey, issuedAt: Int64
    ) throws -> Signed {
        let grant = ServerWildcardGrant(username: username, serverDomain: serverDomain.lowercased(),
                                        stkPubHex: HexUtil.encode(pinnedStk), issuedAt: issuedAt)
        let sig = try key.signature(for: try grant.canonicalBytes())
        let signed = Signed(stkPubHex: grant.stkPubHex, issuedAt: issuedAt, signatureHex: HexUtil.encode(sig))
        let d = ServerKeyPins.normalize(serverDomain)
        lock.lock()
        var m = signedAll
        m[d] = signed
        signedAll = m
        var o = owedAll
        o[d] = nil
        owedAll = o
        lock.unlock()
        return signed
    }

    /// The kept grant for this server, if it still names `pinnedStk` (a grant over any other key is dropped).
    public func pending(_ serverDomain: String, pinnedStk: Data) -> Signed? {
        let d = ServerKeyPins.normalize(serverDomain)
        lock.lock(); defer { lock.unlock() }
        guard let s = signedAll[d] else { return nil }
        return s.stkPubHex == HexUtil.encode(pinnedStk) ? s : nil
    }

    public func markDelivered(_ serverDomain: String) {
        let d = ServerKeyPins.normalize(serverDomain)
        lock.lock(); defer { lock.unlock() }
        var m = signedAll
        m[d] = nil
        signedAll = m
    }

    /// The server holds no grant and no key could sign silently: sign at the next Face ID.
    public func markOwed(_ serverDomain: String, username: String) {
        let d = ServerKeyPins.normalize(serverDomain)
        lock.lock(); defer { lock.unlock() }
        var o = owedAll
        o[d] = username.lowercased()
        owedAll = o
    }

    public func owed() -> [(serverDomain: String, username: String)] {
        lock.lock(); defer { lock.unlock() }
        return owedAll.map { ($0.key, $0.value) }.sorted { $0.serverDomain < $1.serverDomain }
    }

    /// Sign every owed grant with a key the owner just opened (the admin root at a Face ID they did for
    /// something else). Servers without a pin stay owed. Returns the servers signed.
    @discardableResult
    public func signOwed(key: Curve25519.Signing.PrivateKey, pins: ServerKeyPins, now: Int64) -> [String] {
        var done: [String] = []
        for (domain, user) in owed() {
            guard let stk = pins.pinnedStk(domain) else { continue }
            if (try? sign(username: user, serverDomain: domain, pinnedStk: stk, key: key, issuedAt: now)) != nil {
                done.append(domain)
            }
        }
        return done
    }

    /// Try to hand over the kept grant for one server; true once the server holds it.
    @discardableResult
    public func deliverKept(_ serverDomain: String, pins: ServerKeyPins) async -> Bool {
        guard let stk = pins.pinnedStk(serverDomain), let signed = pending(serverDomain, pinnedStk: stk),
              let deliver else { return false }
        guard await deliver(serverDomain, signed) else { return false }
        markDelivered(serverDomain)
        return true
    }

    public func clear() {
        lock.lock(); defer { lock.unlock() }
        defaults.removeObject(forKey: Self.signedKey)
        defaults.removeObject(forKey: Self.owedKey)
    }
}

/// One pass of upkeep for one server, run by an admin device: deliver a kept grant, else ask the server
/// whether it holds one and, when it doesn't, sign one silently if a key is open, else mark it owed.
public enum ServerWildcardGrantUpkeep {
    public enum Outcome: Equatable, Sendable { case delivered, alreadyGranted, signedAndDelivered, owed, skipped }

    public static func run(
        username: String,
        serverDomain: String,
        keeper: ServerWildcardGrantKeeper,
        pins: ServerKeyPins,
        status: () async -> Bool?,
        silentKey: () -> Curve25519.Signing.PrivateKey?,
        now: Int64
    ) async -> Outcome {
        guard let stk = pins.pinnedStk(serverDomain) else { return .skipped }
        if keeper.pending(serverDomain, pinnedStk: stk) != nil {
            return await keeper.deliverKept(serverDomain, pins: pins) ? .delivered : .skipped
        }
        guard let granted = await status() else { return .skipped }
        if granted { return .alreadyGranted }
        guard let key = silentKey() else {
            keeper.markOwed(serverDomain, username: username)
            return .owed
        }
        guard (try? keeper.sign(username: username, serverDomain: serverDomain, pinnedStk: stk, key: key, issuedAt: now)) != nil
        else { return .skipped }
        return await keeper.deliverKept(serverDomain, pins: pins) ? .signedAndDelivered : .skipped
    }
}
