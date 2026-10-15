import Foundation
import CryptoKit
import LocalAuthentication
import Flagship
import FlagshipAPI
import FlagshipCore

/// Saves the owner's server order (docs/server-order.md). Home's drag and
/// server detail's "Make leader" both come here, and both read the order
/// back from `AppState`, so the change shows everywhere at once and is put
/// back everywhere if signing or posting fails.
@MainActor
public struct ServerOrderSaver {
    public enum Outcome: Equatable, Sendable {
        case saved
        /// Kept on this device only (a demo account holds no keys).
        case local
        /// `.com` already holds a newer order: refetch `/pods`.
        case superseded
        case failed(String)
    }

    /// The sensitive-order key: the admin master root when this device holds
    /// one, else the account IRK. Gets at most one prompt.
    public typealias Signer = @MainActor (_ reason: String) async throws -> Curve25519.Signing.PrivateKey

    public static let reason = "Confirm the new server order"

    private let app: AppState
    private let mailbox: any SecretMailboxClient
    /// Reaches each server directly, to hand it the new order at once.
    private let clients: PodScreensClientFactory?
    private let signer: Signer
    private let now: () -> Int64

    public init(
        app: AppState,
        mailbox: any SecretMailboxClient,
        clients: PodScreensClientFactory? = nil,
        signer: Signer? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.app = app
        self.mailbox = mailbox
        self.clients = clients
        self.signer = signer ?? { reason in try await Self.sensitiveOrderKey(reason: reason) }
        self.now = now
    }

    /// Show `podIds` (first = leader) as the order, then sign and post it.
    public func save(podIds: [String]) async -> Outcome {
        guard let user = app.currentUser, !user.isEmpty else { return .failed("Sign in first.") }
        let issuedAt = now()
        let snapshot = app.beginServerOrderChange(podIds: podIds, issuedAt: issuedAt)
        if app.isDemoAccount {
            // A demo order never leaves the device: no box will acknowledge it.
            for pod in app.pods { app.recordServerOrderAck(podId: pod.podId, issuedAt: issuedAt) }
            app.finishServerOrderChange()
            return .local
        }
        let order = ServerOrder.make(user: user, stks: app.serverOrder, now: issuedAt)
        guard !order.stks.isEmpty else {
            app.finishServerOrderChange()
            return .local
        }
        do {
            let key = try await signer(Self.reason)
            let signature = try order.sign(with: key)
            let wire = SignedServerOrderWire(order: order.wire, signature: signature)
            try await mailbox.postServerOrder(username: user, body: wire)
            app.finishServerOrderChange()
            Task { await deliver(wire) }
            return .saved
        } catch ScreensClientError.http(status: 409, message: _) {
            app.restoreServerOrder(snapshot)
            return .superseded
        } catch {
            app.restoreServerOrder(snapshot)
            return .failed(Self.message(for: error))
        }
    }

    /// Hand the saved order to every server that is up, so each acts on it
    /// now instead of on its next check-in with `.com`, and record what each
    /// answers (Home shows the leader gray until the leader holds it). A box
    /// that can't be reached, or is too old to take it, still gets the order
    /// from `.com`, which keeps only the newest one.
    public func deliver(_ wire: SignedServerOrderWire) async {
        guard let clients else { return }
        let targets = app.pods.filter { $0.status == .online && !$0.isRevoked && !$0.fqdn.isEmpty }
        let acks = await withTaskGroup(of: (String, Int64?).self) { group in
            for pod in targets {
                group.addTask {
                    let client = await clients.client(forFqdn: pod.fqdn)
                    return (pod.podId, try? await client.deliverServerOrder(wire).heldIssuedAt)
                }
            }
            var out: [(String, Int64)] = []
            for await (podId, held) in group { if let held { out.append((podId, held)) } }
            return out
        }
        for (podId, held) in acks { app.recordServerOrderAck(podId: podId, issuedAt: held) }
    }

    /// Move one server to the top of the order.
    public func makeLeader(podId: String) async -> Outcome {
        await save(podIds: app.orderWithLeader(podId))
    }

    static func message(for error: Error) -> String {
        if BiometricGate.GateError.from(error) == .userCancelled {
            return "The server order wasn't changed."
        }
        if case ScreensClientError.http(status: 403, message: _) = error {
            return "Your account didn't accept the new order. Try again."
        }
        return "Couldn't save the server order. Check your connection and try again."
    }

    /// Silent when the session already holds the IRK and this device has no
    /// admin root; otherwise one Face ID / passcode prompt, which also opens
    /// the account keys for the rest of the session.
    static func sensitiveOrderKey(reason: String) async throws -> Curve25519.Signing.PrivateKey {
        if !Keystore.hasAdminRoot, let irk = Keystore.sessionIRKIfCached() { return irk }
        let context = try await BiometricGate().evaluateReturningContext(reason: reason)
        Keystore.cacheSessionUMK(authenticatedBy: context)
        if Keystore.hasAdminRoot { return try Keystore.adminRootKey(authenticatedBy: context) }
        if let irk = Keystore.sessionIRKIfCached() { return irk }
        return try await Keystore.deriveIRK(reason: reason)
    }
}
