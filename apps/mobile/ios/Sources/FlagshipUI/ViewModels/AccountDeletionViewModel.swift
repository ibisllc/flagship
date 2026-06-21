import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Last-device account-deletion ceremony orchestrator
/// (docs/account-deletion-and-name-reclaim.md §2/§5).
///
/// Runs ONLY when the action is account DEATH — no cloud recovery AND this is
/// the last device (`SignOutPolicy.evaluate(...) == .deletionCeremony`) — gated
/// behind the full-page warning screen's typed-username + biometric confirm.
///
/// Steps:
///   1. Derive the OWNER IRK behind the biometric.
///   2. Sign the `account-self-delete` order (always) over the canonical bytes
///      via `FlagshipCore.AccountSelfDeleteOrder`.
///   3. If the user opted into the content wipe, ALSO sign the
///      `servers-self-delete` order via `ServersSelfDeleteOrder` — the two ride
///      as one atomic bundle (`.com` rejects a standalone servers order, §5).
///   4. POST the bundle to `/api/account/self-delete`.
///   5. On 200 ONLY: wipe ALL local key material (`Keystore.wipeAllProfiles`)
///      and drop to Welcome (the injected `onWiped` callback runs
///      `AppState.signOut`). The username frees immediately.
///
/// The local wipe is structurally unreachable before a 200 — every pre-POST
/// failure returns from `.failed` without touching the keystore. `.com`
/// independently re-enforces last-device, so a 403 "not the last device" is the
/// authoritative backstop surfaced via the humanized-error path.
@Observable
@MainActor
public final class AccountDeletionViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case signing
        case posting
        case wiping
        case completed
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

    private let server: FlagshipServerClient
    private let username: () -> String?
    /// Pluggable for tests: override the owner-IRK derivation step. Default
    /// derives via `Keystore.deriveIRK(reason:)` behind the biometric.
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    /// Pluggable for tests: the local key-material wipe. Default erases every
    /// Keychain profile (the only copy of the identity dies with the account).
    private let wipe: @MainActor () -> Void
    /// Drop to Welcome after a successful wipe (the SettingsTab wires this to
    /// `AppState.signOut`). Runs ONLY after a 200 + wipe.
    private let onWiped: @MainActor () -> Void

    public init(
        server: FlagshipServerClient,
        username: @escaping () -> String?,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        wipe: (@MainActor () -> Void)? = nil,
        onWiped: @escaping @MainActor () -> Void
    ) {
        self.server = server
        self.username = username
        self.signer = signer ?? { reason in
            try await Keystore.deriveIRK(reason: reason)
        }
        self.wipe = wipe ?? { Keystore.wipeAllProfiles() }
        self.onWiped = onWiped
    }

    /// Execute the ceremony. `alsoDeleteServerContent` mirrors the warning
    /// screen's opt-in checkbox: when true the `servers-self-delete` order is
    /// bundled in; when false it is omitted entirely (no standalone order, §5).
    public func run(alsoDeleteServerContent: Bool) async {
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }

        phase = .signing
        let irk: Curve25519.Signing.PrivateKey
        do {
            irk = try await signer("Delete your account")
        } catch {
            phase = .failed("Couldn't access your account key: \(error.localizedDescription)")
            return
        }

        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let accountOrder = AccountSelfDeleteOrder(username: user, issuedAt: issuedAt)
        let accountSig: Data
        do {
            accountSig = try accountOrder.sign(with: irk)
        } catch {
            phase = .failed("Couldn't sign: \(error.localizedDescription)")
            return
        }

        var serversBundle: AccountSelfDeleteBundleRequest.Order? = nil
        if alsoDeleteServerContent {
            let serversOrder = ServersSelfDeleteOrder(username: user, issuedAt: issuedAt)
            let serversSig: Data
            do {
                serversSig = try serversOrder.sign(with: irk)
            } catch {
                phase = .failed("Couldn't sign: \(error.localizedDescription)")
                return
            }
            serversBundle = .init(
                request: .init(username: user, issuedAt: issuedAt),
                signature: HexUtil.encode(serversSig)
            )
        }

        let bundle = AccountSelfDeleteBundleRequest(
            accountSelfDelete: .init(
                request: .init(username: user, issuedAt: issuedAt),
                signature: HexUtil.encode(accountSig)
            ),
            serversSelfDelete: serversBundle
        )

        phase = .posting
        do {
            _ = try await server.selfDeleteAccount(bundle)
        } catch ScreensClientError.http(let status, let message) where status == 403 {
            // The authoritative last-device backstop. `.com` returns "not the
            // last device: other active devices exist" / "stale request" /
            // "invalid … signature" — surface plainly, never wipe.
            if message.lowercased().contains("last device") {
                phase = .failed("Another device is still on this account, so it can't be deleted from here. Remove the other devices first.")
            } else {
                phase = .failed("The server rejected the request. Sign in again and retry.")
            }
            return
        } catch ScreensClientError.http(let status, _) where status == 404 {
            phase = .failed("That account no longer exists.")
            return
        } catch let error as ScreensClientError {
            phase = .failed(error.errorDescription ?? "That didn't work. Try again in a moment.")
            return
        } catch {
            phase = .failed("Couldn't reach the server. Check your connection and try again.")
            return
        }

        // 200 only: the account row is hard-deleted on `.com` (the name is
        // already free). Now — and ONLY now — erase the local key material and
        // drop to Welcome.
        phase = .wiping
        wipe()
        onWiped()
        phase = .completed
    }
}
