import Foundation
import SwiftUI
import UIKit
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
            // Revoke is now IRK-signed (SEC): .com verifies the envelope
            // against the token owner's registered IRK before deleting the
            // tether. We sign behind the biometric, exactly like register.
            let irk = try await Keystore.deriveIRK(reason: "Revoke push token from Flagship")
            let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
            let bytes = PushTokenRevoke.canonicalBytes(tokenId: tokenId, issuedAt: issuedAt)
            let sig = try irk.signature(for: bytes)
            try await client.revokePushToken(
                PushTokenRevokeRequest(
                    request: .init(tokenId: tokenId, issuedAt: issuedAt),
                    signature: HexUtil.encode(Data(sig))
                )
            )
        } catch {
            // Network blip (or a declined biometric) during sign-out is
            // non-fatal — the daemon can garbage-collect stale tokens on
            // its own schedule.
            self.lastError = error
        }
        try? Keystore.setPushTokenId(nil)
        self.lastRegisteredTokenId = nil
    }

    /// Length-cap + strip control characters to match the Worker's
    /// handler-side validation (control-plane/src/push.ts caps at 64
    /// chars + rejects 0x00-0x1f + 0x7f). Exposed `static` so tests
    /// can pin the contract.
    static func sanitizeLabel(_ raw: String) -> String {
        let stripped = raw.unicodeScalars
            .filter { !($0.value < 0x20 || $0.value == 0x7f) }
            .reduce(into: "") { acc, s in acc.unicodeScalars.append(s) }
        let trimmed = stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.utf8.count <= 64 { return trimmed }
        // Truncate by UTF-8 bytes — not chars — since the server caps
        // bytes. Step back until we're under the limit + on a valid
        // boundary.
        var out = trimmed
        while out.utf8.count > 64, !out.isEmpty { out.removeLast() }
        return out
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
            // Device label = UIDevice.current.name unless the user
            // has set a custom one in Settings (placeholder for now —
            // a future commit adds an editable nickname).
            // UIDevice.current.name on iOS 16+ returns the
            // localized model ("iPhone") unless the user has
            // explicitly named the device — but it's the cleanest
            // out-of-the-box default we can ship without prompting.
            let label = Self.sanitizeLabel(UIDevice.current.name)
            let bytes = PushTokenRegister.canonicalBytes(
                username: username,
                platform: "apns",
                providerToken: providerTokenHex,
                pushX25519PubHex: pushPubHex,
                label: label,
                issuedAt: issuedAt
            )
            let sig = try irk.signature(for: bytes)
            let req = PushTokenRegisterRequest(
                request: .init(
                    username: username,
                    platform: "apns",
                    providerToken: providerTokenHex,
                    pushX25519Pub: pushPubHex,
                    label: label,
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
