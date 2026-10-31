import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// The dead-man editor on the server page (issuance-and-lease-records.md section 5): how long the
/// server keeps serving its apps when no admin opens Flagship, and what happens then. Saving signs
/// a new `serving-policy/v1` with the admin root (opened by the Face ID that opened the editor),
/// one generation above the current one, posts it to `.com` and the box, and under a time limit
/// signs the first lease at once so the server keeps serving.
@Observable
@MainActor
public final class ServingPolicyEditor: Identifiable {
    public enum Phase: Equatable, Sendable {
        case idle
        case saving
        case failed(String)
    }

    public nonisolated let id = UUID()
    public private(set) var phase: Phase = .idle
    public private(set) var grace: ServingGrace
    public var onLapse: ServingOnLapse

    public let current: ServingView
    private let username: String
    private let serverDomain: String
    private let boxPub: String
    private let adminRoot: Curve25519.Signing.PrivateKey
    private let mailbox: any SecretMailboxClient
    private let box: (any ScreensClient)?
    private let renewer: ServingRenewer
    /// Drops the server's auto-unlock leases before a policy that locks it is set (SEC-DEADMAN-001).
    private let bootLock: BootLock?
    private let irk: @MainActor () async throws -> Curve25519.Signing.PrivateKey
    private let state: ServingStateStore
    private let now: () -> Int64

    public init(
        current: ServingView,
        username: String,
        serverDomain: String,
        boxPub: String,
        adminRoot: Curve25519.Signing.PrivateKey,
        mailbox: any SecretMailboxClient,
        box: (any ScreensClient)?,
        renewer: ServingRenewer,
        bootLock: BootLock? = nil,
        irk: (@MainActor () async throws -> Curve25519.Signing.PrivateKey)? = nil,
        state: ServingStateStore = ServingStateStore(),
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.current = current
        self.grace = current.graceValue
        self.onLapse = current.graceValue == .indefinite ? .stopApps : current.onLapseValue
        self.username = username.lowercased()
        self.serverDomain = serverDomain
        self.boxPub = boxPub.lowercased()
        self.adminRoot = adminRoot
        self.mailbox = mailbox
        self.box = box
        self.renewer = renewer
        self.bootLock = bootLock
        self.irk = irk ?? {
            if let k = Keystore.sessionIRKIfCached() { return k }
            return try await Keystore.deriveIRK(reason: String(localized: "Remove auto-unlock for this server"))
        }
        self.state = state
        self.now = now
    }

    /// Locking needs a time limit: "Never" greys the second choice out.
    public var canLock: Bool { grace != .indefinite }

    public var changed: Bool { grace != current.graceValue || onLapse != current.onLapseValue }

    public func setGrace(_ g: ServingGrace) {
        grace = g
        if g == .indefinite { onLapse = .stopApps }
    }

    /// Sign and send the policy. True when `.com` took it.
    @discardableResult
    public func save() async -> Bool {
        phase = .saving
        let policy = ServingPolicy(account: username, box: boxPub, regGen: current.regGen, policyGen: current.policyGen + 1,
                                   grace: grace, onLapse: canLock ? onLapse : .stopApps,
                                   scopeSha256: current.scopeSha256, issuedAt: now())
        let signature: String
        do {
            signature = try ServingAuthority.signEd25519(try policy.canonicalBytes(), key: adminRoot)
        } catch {
            phase = .failed(String(localized: "Couldn't sign the change. Try again."))
            return false
        }
        let locksNow = policy.onLapse == ServingOnLapse.lockServer.rawValue
        let lockedBefore = current.onLapseValue == .lockServer && current.graceValue != .indefinite
        if locksNow, !lockedBefore, let bootLock {
            do {
                try await bootLock.revokeAllLeases(serverDomain: serverDomain, irk: try await irk())
            } catch {
                phase = .failed(String(localized: "Couldn't remove this server's auto-unlock, so locking was not turned on. \(HumanError.humanize(error))"))
                return false
            }
        }
        do {
            try await mailbox.postServingPolicy(username: username, body: ServingPolicyPost(policy: policy, signature: signature))
        } catch let e {
            phase = .failed(Self.message(for: e))
            return false
        }
        let signedPolicy = SignedServingRecord(record: policy, signature: signature)
        try? await box?.postServing(BoxServingPost(policy: signedPolicy))
        await renewer.delegate(with: adminRoot)
        var until: Int64?
        if let lease = renewer.signLease(policy, adminRoot: adminRoot) {
            await renewer.post([(serverDomain: serverDomain, lease: lease)])
            until = lease.record.notAfter
        }
        state.record(serverDomain, onLapse: policy.onLapseValue ?? .stopApps, grace: grace, until: until)
        phase = .idle
        return true
    }

    static func message(for error: Error) -> String {
        switch error {
        case ScreensClientError.http(status: 409, message: _):
            return String(localized: "This setting was changed on another device. Close it and try again.")
        case ScreensClientError.http(status: 403, message: _):
            return String(localized: "Your account didn't accept the change. Try again.")
        default:
            return String(localized: "Couldn't save the change. Check your connection and try again.")
        }
    }
}
