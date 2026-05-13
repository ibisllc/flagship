import Foundation
import SwiftUI
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Minimum surface SwiftUI views need to invoke push-registration
/// cleanup (revoke + wipe). Separate from the concrete `PushRegistrar`
/// so the environment-key default can be a no-op without forcing
/// every preview to instantiate the real one.
@MainActor
public protocol PushRegistrarHandle: AnyObject {
    func revoke() async
}

private struct PushRegistrarKey: EnvironmentKey {
    static let defaultValue: PushRegistrarHandle? = nil
}

public extension EnvironmentValues {
    var pushRegistrar: PushRegistrarHandle? {
        get { self[PushRegistrarKey.self] }
        set { self[PushRegistrarKey.self] = newValue }
    }
}

/// Pairs an OS-supplied APNs device token with the user's IRK + a
/// per-device X25519 push key and POSTs the result to .com so the
/// Worker has somewhere to relay encrypted push payloads.
///
/// The canonical-bytes shape is identical to the verifier in
/// packages/protocol/src/auth.ts (`flagship/push-token-register/v1|...`)
/// so the Worker's `verifyPushTokenRegister` accepts the signature we
/// produce here.
///
/// Sign-on path:
///   1. ContentView wires `push.onDeviceTokenChange = { [weak self] in
///         await self?.registrar.handle(deviceToken: $0)
///      }`
///   2. iOS hands us the raw token bytes via AppDelegate.
///   3. We derive IRK, load-or-create the device's X25519 keypair, build
///      canonical bytes, sign them, POST. The returned tokenId is
///      stashed in the Keychain so we can revoke on sign-out.
@MainActor
public final class PushRegistrar: PushRegistrarHandle {
    private let appState: AppState
    private let client: any FlagshipServerClient
    /// Surfaced for callers (and tests) that want to know "did the last
    /// registration succeed?" without observing the keychain directly.
    public private(set) var lastRegisteredTokenId: String?
    public private(set) var lastError: Error?

    public init(appState: AppState, client: any FlagshipServerClient) {
        self.appState = appState
        self.client = client
    }

    /// Drop the last-registered push token on .com and wipe the
    /// Keychain entry. Called from the sign-out flow before AppState
    /// clears the username (we need it to remain readable so the
    /// canonical-bytes invariants on the server's verifier still
    /// make sense if we ever decide to add an IRK signature to
    /// revoke). Tolerates the no-token case + any transport error
    /// (sign-out shouldn't fail because the device was offline).
    public func revoke() async {
        guard let tokenId = Keystore.pushTokenId() else { return }
        do {
            try await client.revokePushToken(tokenId: tokenId)
        } catch {
            // Network blip during sign-out is non-fatal — the daemon
            // can garbage-collect stale tokens on its own schedule.
            self.lastError = error
        }
        try? Keystore.setPushTokenId(nil)
        self.lastRegisteredTokenId = nil
    }

    public func handle(deviceToken: Data?) async {
        guard let token = deviceToken, !token.isEmpty else {
            // OS revoked the token — leave the previous tokenId on file
            // until the user explicitly signs out, since a brief
            // permission flip shouldn't drop us off the relay.
            return
        }
        guard let username = appState.currentUser, !username.isEmpty else {
            // Pre-pairing — silently skip; ContentView re-fires once
            // the user finishes onboarding.
            return
        }
        do {
            let providerTokenHex = HexUtil.encode(token)
            let irk = try await Keystore.deriveIRK(
                reason: "Register push token with Flagship"
            )
            let pushKeypair = try Keystore.loadOrCreatePushX25519()
            let pushPubHex = HexUtil.encode(pushKeypair.publicKey.rawRepresentation)
            let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
            let bytes = PushTokenRegister.canonicalBytes(
                username: username,
                platform: "apns",
                providerToken: providerTokenHex,
                pushX25519PubHex: pushPubHex,
                issuedAt: issuedAt
            )
            let sig = try irk.signature(for: bytes)
            let req = PushTokenRegisterRequest(
                request: .init(
                    username: username,
                    platform: "apns",
                    providerToken: providerTokenHex,
                    pushX25519Pub: pushPubHex,
                    issuedAt: issuedAt
                ),
                signature: HexUtil.encode(Data(sig))
            )
            let resp = try await client.registerPushToken(req)
            try? Keystore.setPushTokenId(resp.tokenId)
            self.lastRegisteredTokenId = resp.tokenId
            self.lastError = nil
        } catch {
            self.lastError = error
        }
    }
}
