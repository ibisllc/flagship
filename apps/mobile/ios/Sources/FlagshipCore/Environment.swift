import SwiftUI
import FlagshipAPI
import Flagship

/// EnvironmentValues extension so any view can read the live ScreensClient
/// via `@Environment(\.screensClient)`. The App-level shell injects either
/// a MockScreensClient (dev/preview) or a LiveScreensClient (paired pod).
private struct ScreensClientKey: EnvironmentKey {
    static let defaultValue: any ScreensClient = MockScreensClient()
}

public extension EnvironmentValues {
    var screensClient: any ScreensClient {
        get { self[ScreensClientKey.self] }
        set { self[ScreensClientKey.self] = newValue }
    }
}

/// Pre-pairing endpoints on flagshipserver.com (the Cloudflare Worker).
/// Used by onboarding + recovery flows before a session token exists.
private struct FlagshipServerClientKey: EnvironmentKey {
    static let defaultValue: any FlagshipServerClient = MockFlagshipServerClient()
}

public extension EnvironmentValues {
    var flagshipServerClient: any FlagshipServerClient {
        get { self[FlagshipServerClientKey.self] }
        set { self[FlagshipServerClientKey.self] = newValue }
    }
}

/// QR-relay WebSocket peer of `flagshipserver.com/qr-pipe/<sid>`.
/// Used by the v2 create-server flow.
private struct QrRelayClientKey: EnvironmentKey {
    static let defaultValue: any QrRelayClient = MockQrRelayClient()
}

public extension EnvironmentValues {
    var qrRelayClient: any QrRelayClient {
        get { self[QrRelayClientKey.self] }
        set { self[QrRelayClientKey.self] = newValue }
    }
}

/// Phase 3b — bidirectional cross-device pairing relay seam (collaborator
/// admit). Distinct from `qrRelayClient` (one-shot phone→browser create-
/// server delivery). Defaults to the in-process Mock.
private struct PairingRelayClientKey: EnvironmentKey {
    static let defaultValue: any PairingRelayClient = MockPairingRelayClient()
}

public extension EnvironmentValues {
    var pairingRelayClient: any PairingRelayClient {
        get { self[PairingRelayClientKey.self] }
        set { self[PairingRelayClientKey.self] = newValue }
    }
}

/// Phone-as-unlock-endpoint RELAY mailbox on flagshipserver.com. The
/// SecretRequestsContainer reads this to fetch + answer pending boot-secret
/// requests. Defaults to the in-process Mock (empty inbox) so previews + the
/// unconfigured shell render the empty state with no network call.
private struct SecretMailboxClientKey: EnvironmentKey {
    static let defaultValue: any SecretMailboxClient = MockSecretMailboxClient()
}

public extension EnvironmentValues {
    var secretMailboxClient: any SecretMailboxClient {
        get { self[SecretMailboxClientKey.self] }
        set { self[SecretMailboxClientKey.self] = newValue }
    }
}

/// P6 — owner-only invite label book. Maps `(serviceId, opaqueTag)`
/// to a local display name + channel + sent-to memo + notes. NEVER
/// leaves the device. The default value is the UserDefaults-backed
/// implementation; tests + previews inject the in-memory variant.
private struct InviteLabelBookKey: EnvironmentKey {
    static let defaultValue: any InviteLabelBook = UserDefaultsInviteLabelBook()
}

public extension EnvironmentValues {
    var inviteLabelBook: any InviteLabelBook {
        get { self[InviteLabelBookKey.self] }
        set { self[InviteLabelBookKey.self] = newValue }
    }
}
