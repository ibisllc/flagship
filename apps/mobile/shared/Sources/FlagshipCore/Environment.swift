import SwiftUI
import FlagshipAPI

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

/// The pod session store backing `LiveScreensClient` — holds the
/// per-pod `podBaseUrl` + session token. Exposed in the environment so
/// the shell can repoint `podBaseUrl` at whichever server is currently
/// selected + online (a `/pods`-reconciled server never ran the pairing
/// flow that historically set it, so without this its daemon BFF is
/// unreachable and every screen load fails). Defaults to a UserDefaults-
/// backed store so previews/tests get a real (in-memory-ish) writer.
private struct SessionStoreKey: EnvironmentKey {
    static let defaultValue: any SessionStoring = SessionStore()
}

public extension EnvironmentValues {
    var sessionStore: any SessionStoring {
        get { self[SessionStoreKey.self] }
        set { self[SessionStoreKey.self] = newValue }
    }
}

/// Box-direct delivery for the lock/power-off + dead-man envelopes. Dials
/// the box's signature-authed daemon routes (`/api/power`,
/// `/api/deadman/*`) over the box-pinned session. Defaults to the in-process
/// Mock (records sends, never auto-affirms) so previews/tests are inert.
private struct LockPowerClientKey: EnvironmentKey {
    static let defaultValue: any LockPowerClient = MockLockPowerClient()
}

public extension EnvironmentValues {
    var lockPowerClient: any LockPowerClient {
        get { self[LockPowerClientKey.self] }
        set { self[LockPowerClientKey.self] = newValue }
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
