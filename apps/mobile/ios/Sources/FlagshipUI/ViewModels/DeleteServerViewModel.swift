import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// "Delete server" for any registered server, online or not, revoked or not.
///
/// One biometric for the whole flow:
///   1. Ask the box to erase itself: a `ServerDecommission` order (`wipe-now`,
///      no final backup) bound to the box's registered STK, deposited on `.com`
///      for the box to pick up. Best-effort: an offline box is still deleted.
///   2. Release the name (`ReleaseServerName`), which ends the registration so
///      the box can never come back and the name is free. A failure here keeps
///      the pod: the name is still reserved.
///   3. Drop the pod locally.
@Observable
@MainActor
public final class DeleteServerViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case working
        /// `eraseRequested` is nil when the box never registered an identity
        /// (nothing to ask), else whether the erase order was deposited.
        case completed(eraseRequested: Bool?)
        case failed(String)
    }

    /// The keys the flow signs with. `orderKey` is the sensitive-order key
    /// (admin root when held, else the IRK); `mailboxIrk` authenticates the
    /// erase-order deposit and may be nil when it couldn't be derived.
    public struct Keys {
        public let orderKey: Curve25519.Signing.PrivateKey
        public let mailboxIrk: Curve25519.Signing.PrivateKey?
        public init(orderKey: Curve25519.Signing.PrivateKey, mailboxIrk: Curve25519.Signing.PrivateKey?) {
            self.orderKey = orderKey
            self.mailboxIrk = mailboxIrk
        }
    }

    public private(set) var phase: Phase = .idle

    public let serverFqdn: String
    private let identityPubKeyHex: String
    private let server: any FlagshipServerClient
    private let mailbox: any SecretMailboxClient
    private let username: () -> String?
    private let onDeleted: @MainActor () -> Void
    private let keys: @MainActor (String) async throws -> Keys
    private let now: () -> Int64
    private let randomNonce: () -> Data

    public init(
        server: any FlagshipServerClient,
        mailbox: any SecretMailboxClient,
        serverFqdn: String,
        identityPubKeyHex: String,
        username: @escaping () -> String?,
        onDeleted: @escaping @MainActor () -> Void,
        keys: (@MainActor (String) async throws -> Keys)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        randomNonce: @escaping () -> Data = { ReplaceServerFlow.random32() }
    ) {
        self.server = server
        self.mailbox = mailbox
        self.serverFqdn = serverFqdn
        self.identityPubKeyHex = identityPubKeyHex
        self.username = username
        self.onDeleted = onDeleted
        self.now = now
        self.randomNonce = randomNonce
        self.keys = keys ?? { reason in
            let orderKey = try await Keystore.sensitiveOrderSigningKey(reason: reason)
            // Without an admin root the order key IS the IRK. With one, the
            // deposit's mailbox auth still needs the IRK; the unlocked session
            // usually holds the UMK, and a failure only skips the erase order.
            let irk: Curve25519.Signing.PrivateKey?
            if Keystore.hasAdminRoot {
                irk = try? await Keystore.deriveIRK(reason: reason)
            } else {
                irk = orderKey
            }
            return Keys(orderKey: orderKey, mailboxIrk: irk)
        }
    }

    /// The `<server>` label the owner types to confirm, e.g. `home2`.
    public var serverLabel: String { Self.serverLabel(forFqdn: serverFqdn) }

    public static func serverLabel(forFqdn fqdn: String) -> String {
        String(fqdn.split(separator: ".").first ?? "").lowercased()
    }

    /// Case-insensitive, whitespace-trimmed match against the server label.
    public static func confirmationMatches(_ typed: String, serverLabel: String) -> Bool {
        let t = typed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return !serverLabel.isEmpty && t == serverLabel.lowercased()
    }

    public func confirmationMatches(_ typed: String) -> Bool {
        Self.confirmationMatches(typed, serverLabel: serverLabel)
    }

    public static func completionMessage(name: String, eraseRequested: Bool?) -> String {
        switch eraseRequested {
        case .some(true):  return "Deleted \(name). If it's online it will erase itself and power off."
        case .some(false): return "Deleted \(name). It couldn't be asked to erase itself."
        case .none:        return "Deleted \(name)."
        }
    }

    public func run(typedName: String) async {
        if case .working = phase { return }
        guard confirmationMatches(typedName) else {
            phase = .failed("Type \(serverLabel) to confirm.")
            return
        }
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }
        // A row that names no `<server>.<user>` (an old ghost) holds no name on
        // `.com`: there is nothing to release, so drop it without a call.
        if !Endpoints.isWellFormedServerFqdn(serverFqdn) {
            onDeleted()
            phase = .completed(eraseRequested: nil)
            return
        }
        phase = .working
        let k: Keys
        do {
            k = try await keys("Delete server \(serverLabel)")
        } catch {
            phase = .failed("Couldn't access your account key: \(UserErrorText.of(error))")
            return
        }

        var eraseRequested: Bool? = nil
        if !identityPubKeyHex.isEmpty {
            eraseRequested = await depositErase(username: user, keys: k)
        }

        let issuedAt = now()
        do {
            let sig = try k.orderKey.signature(for: ReleaseServerName.canonicalBytes(
                username: user, serverDomain: serverFqdn, issuedAt: issuedAt
            ))
            try await server.releaseServerName(.init(
                request: .init(username: user, serverDomain: serverFqdn, issuedAt: issuedAt),
                signature: HexUtil.encode(sig)
            ))
        } catch {
            // The real reason, in words: a refusal `.com` sent and a dropped
            // connection must not read the same.
            phase = .failed("Couldn't delete it, so the name is still reserved. \(UserErrorText.of(error))")
            return
        }

        PendingRckStore().clear(for: serverFqdn)
        onDeleted()
        phase = .completed(eraseRequested: eraseRequested)
    }

    private func depositErase(username: String, keys k: Keys) async -> Bool {
        guard let irk = k.mailboxIrk else { return false }
        do {
            let body = try ReplaceServerFlow.buildDeposit(
                serverFqdn: serverFqdn,
                username: username,
                irk: irk,
                orderKey: k.orderKey,
                retiredStkPubHex: identityPubKeyHex,
                finalBackup: false,
                disposition: .wipeNow,
                issuedAt: now(),
                nonce: randomNonce(),
                authNonce: randomNonce(),
                backupEpoch: 0
            )
            try await mailbox.depositDecommission(serverDomain: serverFqdn, body: body)
            return true
        } catch {
            return false
        }
    }
}
