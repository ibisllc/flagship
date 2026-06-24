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

/// Box-direct delivery for the owner-assignable apex ("front page").
/// Two unauthenticated reads + one IRK-signed write on the box's pinned
/// canonical pipe. Defaults to the in-process Mock so previews/tests are
/// inert.
private struct FrontPageClientKey: EnvironmentKey {
    static let defaultValue: any FrontPageClient = MockFrontPageClient()
}

public extension EnvironmentValues {
    var frontPageClient: any FrontPageClient {
        get { self[FrontPageClientKey.self] }
        set { self[FrontPageClientKey.self] = newValue }
    }
}

/// Direct (box-read) per-service leadership — `GET /api/leads` over the box's
/// pinned canonical pipe, preferred over the `.com` `/pods` `leadsServices`
/// relay when a box is reachable. Defaults to the in-process Mock (returns nil =
/// "no fresher source"), so previews/tests keep the relay value untouched.
private struct LeadsClientKey: EnvironmentKey {
    static let defaultValue: any LeadsClient = MockLeadsClient()
}

public extension EnvironmentValues {
    var leadsClient: any LeadsClient {
        get { self[LeadsClientKey.self] }
        set { self[LeadsClientKey.self] = newValue }
    }
}

/// Per-service access gating (docs/service-access-gating.md): the owner-IRK
/// toggle + allow-list manager (box + `.com`) and the friend AID-signed redeem
/// (box). Box calls ride the pinned canonical pipe; `.com` calls (invite
/// create/list/revoke) ride a public-CA session. Defaults to the in-process
/// Mock so previews/tests are inert.
private struct ServiceAccessClientKey: EnvironmentKey {
    static let defaultValue: any ServiceAccessClient = MockServiceAccessClient()
}

public extension EnvironmentValues {
    var serviceAccessClient: any ServiceAccessClient {
        get { self[ServiceAccessClientKey.self] }
        set { self[ServiceAccessClientKey.self] = newValue }
    }
}

/// Box-direct delivery for the owner-signed service uninstall
/// (`DELETE /api/services/:id`). Same pinned canonical pipe + IRK-signature
/// trust posture as the front-page / lock-power clients. Defaults to the
/// in-process Mock so previews/tests are inert (they record sends, never hit a
/// network).
private struct ServiceUninstallClientKey: EnvironmentKey {
    static let defaultValue: any ServiceUninstallClient = MockServiceUninstallClient()
}

public extension EnvironmentValues {
    var serviceUninstallClient: any ServiceUninstallClient {
        get { self[ServiceUninstallClientKey.self] }
        set { self[ServiceUninstallClientKey.self] = newValue }
    }
}

/// Transfer-a-box broker client (`.com`): deposits the giver's offer, polls for
/// the acquirer's claim, and hands off the re-sealed disk key. Hits `.com`
/// (the namespace-migration broker), not a box-pinned pipe. Defaults to the
/// in-process Mock so previews/tests are inert.
private struct ServerTransferClientKey: EnvironmentKey {
    static let defaultValue: any ServerTransferClient = MockServerTransferClient()
}

public extension EnvironmentValues {
    var serverTransferClient: any ServerTransferClient {
        get { self[ServerTransferClientKey.self] }
        set { self[ServerTransferClientKey.self] = newValue }
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

/// Web-experience gating (docs/service-access-gating.md): the local store of
/// browser QR-login sessions THIS phone has authorized. Drives Settings →
/// "Open secured sessions" (list / refresh online-offline / stop). NEVER leaves
/// the device — the secretId is the box's poll/close handle, nothing more. The
/// default value is the UserDefaults-backed implementation; tests + previews
/// inject the in-memory variant.
private struct SecuredSessionStoreKey: EnvironmentKey {
    static let defaultValue: any SecuredSessionStoring = UserDefaultsSecuredSessionStore()
}

public extension EnvironmentValues {
    var securedSessionStore: any SecuredSessionStoring {
        get { self[SecuredSessionStoreKey.self] }
        set { self[SecuredSessionStoreKey.self] = newValue }
    }
}
