import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Drives the "Quick approve from Apple Watch" toggle (docs/watch-delegate-
/// key-design.md §4).
///
/// ON  → mint a fresh `.userPresence` delegate key on THIS device, have the
///       IRK attest it (one Face ID prompt), and register the IRK-signed
///       `WatchDelegateKey` with .com (scoped boot-approval, 7-day TTL).
/// OFF → IRK-sign a `RevokeWatchDelegate`, POST it, and clear the local key.
///
/// Default-OFF: nothing happens until the user flips it on. The IRK stays
/// fully biometric-gated; only this separate, boot-approval-only key is
/// minted with a laxer policy so a later Watch-driven boot approval is silent.
@Observable
@MainActor
public final class WatchDelegateViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case enabling
        case disabling
        case failed(String)
    }

    /// 7-day default TTL, matching the design + the cloud convention.
    public static let defaultTtlMs: Int64 = 7 * 24 * 60 * 60 * 1000

    public private(set) var phase: Phase = .idle
    /// True when an active delegate is registered for this account.
    public private(set) var isEnabled: Bool = false
    /// Expiry of the active delegate, for the "renew by <date>" hint.
    public private(set) var expiresAt: Int64?

    private let server: FlagshipServerClient
    private let username: () -> String?
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let delegateKeyProvider: @MainActor () throws -> Curve25519.Signing.PrivateKey
    private let loadGrantId: () -> String?
    /// nil clears the local delegate entirely (key + grantId).
    private let saveGrantId: (String?) -> Void
    private let now: () -> Int64
    private let grantIdGen: () -> String

    public init(
        server: FlagshipServerClient,
        username: @escaping () -> String?,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        delegateKeyProvider: (@MainActor () throws -> Curve25519.Signing.PrivateKey)? = nil,
        loadGrantId: (() -> String?)? = nil,
        saveGrantId: ((String?) -> Void)? = nil,
        now: (() -> Int64)? = nil,
        grantIdGen: (() -> String)? = nil
    ) {
        self.server = server
        self.username = username
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
        self.delegateKeyProvider = delegateKeyProvider ?? { try Keystore.loadOrCreateWatchDelegateKey() }
        self.loadGrantId = loadGrantId ?? { Keystore.watchDelegateGrantId() }
        self.saveGrantId = saveGrantId ?? { id in
            if let id {
                try? Keystore.setWatchDelegateGrantId(id)
            } else {
                Keystore.clearWatchDelegate()
            }
        }
        self.now = now ?? { Int64(Date().timeIntervalSince1970 * 1000) }
        self.grantIdGen = grantIdGen ?? { UUID().uuidString }
    }

    /// Reconcile the toggle with the server's truth. The cloud lists only
    /// delegates that still verify under the current IRK, so a delegate
    /// orphaned by an IRK rotation reads back as "off" here.
    public func load() async {
        guard let user = username(), !user.isEmpty else { isEnabled = false; return }
        phase = .loading
        do {
            let list = try await server.listWatchDelegates(username: user)
            let active = list.delegates.first { $0.expiresAt > now() }
            isEnabled = active != nil
            expiresAt = active?.expiresAt
            phase = .idle
        } catch {
            // A read failure leaves the last-known state; surface nothing
            // destructive (the toggle just can't confirm right now).
            phase = .idle
        }
    }

    public func enable() async {
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }
        phase = .enabling
        let delegateKey: Curve25519.Signing.PrivateKey
        do {
            delegateKey = try delegateKeyProvider()
        } catch {
            phase = .failed("Couldn't create the Watch key: \(error.localizedDescription)")
            return
        }
        let irk: Curve25519.Signing.PrivateKey
        do {
            irk = try await signer("Allow your Watch to approve boots")
        } catch {
            phase = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return
        }
        let issuedAt = now()
        let expiresAt = issuedAt + Self.defaultTtlMs
        let grantId = grantIdGen()
        let delegatePubHex = HexUtil.encode(delegateKey.publicKey.rawRepresentation)
        let env = WatchDelegateKeyEnvelope(
            grantId: grantId,
            username: user,
            delegatePubKeyHex: delegatePubHex,
            scopes: [WatchDelegateKeyEnvelope.bootApprovalScope],
            issuedAt: issuedAt,
            expiresAt: expiresAt
        )
        let sig: Data
        do {
            sig = try env.sign(with: irk)
        } catch {
            phase = .failed("Couldn't sign: \(error.localizedDescription)")
            return
        }
        do {
            let res = try await server.mintWatchDelegate(
                username: user,
                body: WatchDelegateMintRequest(
                    grant: .init(
                        grantId: grantId,
                        username: user,
                        delegatePubKey: delegatePubHex,
                        scopes: [WatchDelegateKeyEnvelope.bootApprovalScope],
                        issuedAt: issuedAt,
                        expiresAt: expiresAt
                    ),
                    signature: HexUtil.encode(sig)
                )
            )
            saveGrantId(res.grantId)
            isEnabled = true
            self.expiresAt = res.expiresAt
            phase = .idle
        } catch let error as ScreensClientError {
            // UX-B — plain language, no raw status code or server message.
            phase = .failed(error.errorDescription ?? "That didn't work. Try again in a moment.")
        } catch {
            phase = .failed("Couldn't reach the server. Check your connection and try again.")
        }
    }

    public func disable() async {
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }
        // Without a known grantId we can't sign a targeted revoke. Treat the
        // toggle as already-off and clear any local key as a belt-and-braces.
        guard let grantId = loadGrantId() else {
            saveGrantId(nil)
            isEnabled = false
            expiresAt = nil
            phase = .idle
            return
        }
        phase = .disabling
        let irk: Curve25519.Signing.PrivateKey
        do {
            irk = try await signer("Stop allowing your Watch to approve boots")
        } catch {
            phase = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return
        }
        let issuedAt = now()
        let env = RevokeWatchDelegateEnvelope(grantId: grantId, username: user, issuedAt: issuedAt)
        let sig: Data
        do {
            sig = try env.sign(with: irk)
        } catch {
            phase = .failed("Couldn't sign: \(error.localizedDescription)")
            return
        }
        do {
            try await server.revokeWatchDelegate(
                username: user,
                body: WatchDelegateRevokeRequest(
                    request: .init(grantId: grantId, username: user, issuedAt: issuedAt),
                    signature: HexUtil.encode(sig)
                )
            )
        } catch {
            // Even if the server call fails, clear the local key so this
            // device stops being able to sign — the server's list re-verify +
            // TTL are the backstops. Report nothing destructive.
        }
        saveGrantId(nil)
        isEnabled = false
        expiresAt = nil
        phase = .idle
    }
}
