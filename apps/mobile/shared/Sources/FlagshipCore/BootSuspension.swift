import Foundation
import CryptoKit
import FlagshipAPI

/// Durable boot suspension, the phone's side (SEC-LOCK-001, SEC-DEADMAN-001).
///
/// A lock lives at the boot worker, not on the box: while it says "suspended"
/// no auto-unlock lease is released for the server, whoever asks, and the box's
/// own key can set it but never clear it. The owner starts every change as a NEW
/// epoch (current + 1). Canonical bytes mirror `@flagship/protocol`
/// `bootSuspension.ts` and the shared vectors in
/// `packages/protocol/test-vectors/boot-suspension/vectors.json`.
public struct BootSuspensionOrder: Equatable, Sendable {
    public static let canonicalTag = "flagship/boot-suspension/v1"

    public enum Action: String, Sendable { case suspend, resume }

    public let serverDomain: String
    public let epoch: Int64
    public let seq: Int64
    public let action: Action
    public let reason: String
    public let signer: String
    public let issuedAt: Int64

    public init(serverDomain: String, epoch: Int64, seq: Int64 = 0, action: Action, reason: String, signer: String = "owner", issuedAt: Int64) {
        self.serverDomain = serverDomain; self.epoch = epoch; self.seq = seq; self.action = action
        self.reason = reason; self.signer = signer; self.issuedAt = issuedAt
    }

    public enum OrderError: Error, Equatable { case badField(String) }

    private static func guardField(_ name: String, _ v: String) throws {
        if v.isEmpty { throw OrderError.badField(name) }
        for u in v.unicodeScalars where u.value == 0x7c || u.value <= 0x1f || u.value == 0x7f { throw OrderError.badField(name) }
    }

    /// `flagship/boot-suspension/v1|<serverDomain>|<epoch>|<seq>|<action>|<reason>|<signer>|<issuedAt>`
    public func canonicalBytes() throws -> Data {
        try Self.guardField("serverDomain", serverDomain)
        try Self.guardField("reason", reason)
        guard epoch >= 0 else { throw OrderError.badField("epoch") }
        guard seq >= 0 else { throw OrderError.badField("seq") }
        guard issuedAt >= 0 else { throw OrderError.badField("issuedAt") }
        guard signer == "owner" || signer == "box" else { throw OrderError.badField("signer") }
        return Data([Self.canonicalTag, serverDomain, String(epoch), String(seq), action.rawValue, reason, signer, String(issuedAt)]
            .joined(separator: "|").utf8)
    }

    public func sign(with key: Curve25519.Signing.PrivateKey) throws -> Data {
        try key.signature(for: canonicalBytes())
    }

    public var wire: BootSuspensionOrderWire {
        BootSuspensionOrderWire(serverDomain: serverDomain, epoch: epoch, seq: seq, action: action.rawValue,
                                reason: reason, signer: signer, issuedAt: issuedAt)
    }
}

/// What a lock or resume came to, in words a screen can show without overclaiming.
public enum BootLockOutcome: Equatable, Sendable {
    /// The boot worker durably recorded it.
    case confirmed(leasesRevoked: Int, alreadyInState: Bool)
    /// It is NOT recorded. `retry` is true when trying again later can work.
    case pending(why: String)
}

/// The phone's memory of locks: what it last confirmed, and locks the worker has
/// not yet confirmed (retried on the next action). Non-secret.
public struct BootLockStateStore {
    private let defaults: UserDefaults
    private static let suspendedPrefix = "flagship.bootLock.suspended."
    private static let pendingKey = "flagship.bootLock.pending"

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private static func key(_ server: String) -> String { suspendedPrefix + server.lowercased() }

    /// nil when this phone has never confirmed a state for the server.
    public func lastKnownSuspended(_ server: String) -> Bool? {
        defaults.object(forKey: Self.key(server)) as? Bool
    }

    public func setLastKnown(_ suspended: Bool, for server: String) {
        defaults.set(suspended, forKey: Self.key(server))
    }

    public func pending() -> [String] { defaults.stringArray(forKey: Self.pendingKey) ?? [] }

    public func markPending(_ server: String) {
        var p = Set(pending()); p.insert(server.lowercased())
        defaults.set(Array(p).sorted(), forKey: Self.pendingKey)
    }

    public func clearPending(_ server: String) {
        defaults.set(pending().filter { $0 != server.lowercased() }, forKey: Self.pendingKey)
    }
}

/// Lock and resume against the boot worker. Reads the record, signs the next
/// owner epoch, and retries when the record moved underneath it.
public struct BootLock: Sendable {
    private let client: any SecretMailboxClient
    private let now: @Sendable () -> Int64
    private let nonce: @Sendable () -> Data

    public init(
        client: any SecretMailboxClient,
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        nonce: @escaping @Sendable () -> Data = { BootAuth.randomNonce() }
    ) {
        self.client = client; self.now = now; self.nonce = nonce
    }

    public func read(serverDomain: String, irk: Curve25519.Signing.PrivateKey) async -> BootSuspensionStateWire? {
        let path = "/api/boot/suspension/\(serverDomain)"
        guard let auth = try? BootAuth.ownerHeader(serverDomain: serverDomain, method: "GET", path: path, irk: irk, now: now(), nonce: nonce())
        else { return nil }
        return try? await client.readBootSuspension(serverDomain: serverDomain, bootAuth: auth)
    }

    /// Lock (`.suspend`) or resume (`.resume`) as the owner.
    public func setOwner(
        serverDomain: String,
        action: BootSuspensionOrder.Action,
        reason: String? = nil,
        irk: Curve25519.Signing.PrivateKey
    ) async -> BootLockOutcome {
        let reason = reason ?? (action == .suspend ? "manual-lock" : "owner-resume")
        var last = BootLockOutcome.pending(why: "unreachable")
        for _ in 0..<3 {
            guard let cur = await read(serverDomain: serverDomain, irk: irk) else { return last }
            if action == .suspend && cur.suspended { return .confirmed(leasesRevoked: 0, alreadyInState: true) }
            if action == .resume && !cur.suspended { return .confirmed(leasesRevoked: 0, alreadyInState: true) }
            let order = BootSuspensionOrder(serverDomain: serverDomain, epoch: cur.epoch + 1, action: action, reason: reason, issuedAt: now())
            let path = "/api/boot/suspension"
            do {
                let sig = try order.sign(with: irk)
                let auth = try BootAuth.ownerHeader(serverDomain: serverDomain, method: "PUT", path: path, irk: irk, now: now(), nonce: nonce())
                let r = try await client.putBootSuspension(order: order.wire, signatureHex: HexUtil.encode(sig), bootAuth: auth)
                if r.durable { return .confirmed(leasesRevoked: r.leasesRevoked, alreadyInState: false) }
                if r.status == 409 { last = .pending(why: "moved"); continue }
                return .pending(why: r.refusal ?? "refused")
            } catch {
                last = .pending(why: "unreachable")
            }
        }
        return last
    }

    /// Revoke every lease for the server (the dead-man switch was turned on).
    public func revokeAllLeases(serverDomain: String, irk: Curve25519.Signing.PrivateKey) async throws {
        let auth = try BootAuth.ownerHeader(serverDomain: serverDomain, method: "DELETE", path: "/api/boot/lease/\(serverDomain)", irk: irk, now: now(), nonce: nonce())
        try await client.revokeAllBoxSealedLeases(serverDomain: serverDomain, bootAuth: auth)
    }
}

/// How the dead-man switch bounds an auto-unlock lease: a lease never outlives
/// the affirmation that keeps the switch alive.
public enum DeadManLeaseBound {
    /// The lease expiry to use, or nil when no lease may be deposited (the
    /// switch is on and has no live deadline).
    public static func expiry(requested: Int64, enabled: Bool, deadline: Int64?, now: Int64) -> Int64? {
        guard enabled else { return requested }
        guard let deadline, deadline > now else { return nil }
        return min(requested, deadline)
    }
}

/// The words for a lock result. Never says "locked" for less than a durable record.
public enum LockWords {
    public static func describe(lock: BootLockOutcome?, powerSent: Bool?, mode: PowerMode, executed: PowerMode? = nil) -> String {
        var parts: [String] = []
        if let powerSent {
            if powerSent {
                let did = executed ?? mode
                parts.append(did == .off ? "The server is powering off" : "The server is restarting")
                if executed != nil && executed != mode { parts[0] += " (it shut down instead of restarting because the lock could not be confirmed)" }
            } else {
                parts.append("The power command didn't reach the server")
            }
        }
        switch lock {
        case .confirmed?: parts.append("locked: it can't unlock itself until you resume it")
        case .pending?: parts.append("remote lock pending: it will be retried")
        case nil: break
        }
        guard !parts.isEmpty else { return "" }
        return parts.joined(separator: "; ") + "."
    }
}
