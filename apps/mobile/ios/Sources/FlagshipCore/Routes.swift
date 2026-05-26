import Foundation
import FlagshipAPI

/// Typed navigation destinations per tab. Each NavigationStack inside the
/// RootShell uses one of these as its path element type so we get
/// type-safe deep-linking and zero stringly-typed navigation.
public enum HomeRoute: Hashable, Sendable {
    case serverDetail(podId: String)
    case addServer
    case installProgress(serial: String, name: String, description: String)
}

public enum AppsRoute: Hashable, Sendable {
    case appDetail(serviceId: String)
    case marketplace
    case marketplaceDetail(creator: String, slug: String)
    case vibeCodeProviderPick
    case vibeCodeDescribe
    case vibeCodeGenerating(sessionId: String)
    /// W10 — vibe-code chat surface. Reached via push deep link
    /// `flagship://vibecode/<sessionId>` when the AI needs the owner.
    case vibeCodeChat(sessionId: String)
    /// W10 — per-app env-var KV editor. Reached from the per-service
    /// detail screen's "Configure environment" menu item.
    case serviceEnv(appId: String, creator: String, slug: String)
    /// P8 — list of headless-Chromium tabs running for an app.
    case browserTabs(serviceId: String)
    /// P8 — the framebuffer viewer that streams a single tab.
    case browserViewer(serviceId: String, tabId: String)
}

public enum ActivityRoute: Hashable, Sendable {
    /// The sealed-key RELAY approval surface (SecretRequestsContainer).
    case secretRequests
    case installProgress(serial: String)
    /// Activity-feed shortcut into Settings → Recovery → Re-attach
    /// progress. Separate path-stack entry so back-nav lands the user
    /// on Activity, not Settings.
    case postRecovery
    /// P5 — the dedicated full-page audit-log viewer, reached from the
    /// Activity feed's "View full audit log" row.
    case auditLog
}

public enum SettingsRoute: Hashable, Sendable {
    case providers
    /// P7 — the dedicated tier-status / subscription screen, reached from
    /// the Settings "Subscription" nav row.
    case tierStatus
    case recovery
    case postRecoveryProgress
    /// "Back up your account key" — passphrase-encrypted `.flagshipkey`
    /// export of the whole UMK. Reached from Settings → Recovery.
    case keyfileBackup
    case about
    case addControlDevice
    /// Phase 3b — ADMIN side of cross-device QR pairing. Settings →
    /// Devices → Add device. Shows a pairing QR (a `/join` universal
    /// link) and runs the admin relay role: derive SAS → confirm match
    /// → sign a DeviceAdmit → seal + send the UMK bundle.
    case addDevice
    /// Phase 3b — INCOMING side of cross-device QR pairing, when the app
    /// is ALREADY paired and a `/join` deeplink (or in-app scan) arrives.
    /// Carries the scanned pairing-link string; routes into the
    /// JoinAccountViewModel add-profile flow.
    case joinAccount(joinUrl: String)
    /// Phase 3b — the in-app scanner entry for the incoming side
    /// ("Scan a pairing code"), reached from Settings → Devices.
    case scanPairingCode
    case developer
    case privacy
    /// W3 — multi-profile picker; lists the clouds this phone is a
    /// member of and lets the user switch active profile.
    case profiles
    /// P9 — peer-backup management. Participation toggle + peer lists
    /// (backing you up / you back up) + shard health + repair status.
    case peerBackup
}

/// The four top-level destinations. Both the iPhone TabView and the iPad
/// NavigationSplitView sidebar use this as the selection type.
public enum RootDestination: String, CaseIterable, Hashable, Identifiable, Sendable {
    case home, apps, activity, settings

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .home:     return "Home"
        case .apps:     return "Apps"
        case .activity: return "Activity"
        case .settings: return "Settings"
        }
    }

    public var systemImage: String {
        switch self {
        case .home:     return "house.fill"
        case .apps:     return "square.grid.2x2.fill"
        case .activity: return "waveform.path.ecg"
        case .settings: return "gearshape.fill"
        }
    }
}

/// Onboarding sub-routes. Welcome is the root; the leaf flows are
/// "create a new account" (Welcome → ChooseUsername → OpenAccount) and
/// "I already have an account" (Welcome → Recovery via WebAuthn-PRF →
/// PostRecoveryChoice). Both leave the user on the paired RootShell.
/// Provisioning a server is no longer part of onboarding — it's the
/// in-shell "Add a server" flow (HomeRoute.addServer).
public enum OnboardingRoute: Hashable, Sendable {
    case chooseUsername
    /// Open account — the Phase-2 step that decouples account identity
    /// from server provisioning. Generates the UMK, derives the IRK,
    /// POSTs a standalone `claimUsername`, and names this first device.
    /// On success the user lands on Home with ZERO servers; the
    /// create-server flow becomes a reusable "Add a server" from there
    /// (HomeRoute.addServer), so onboarding no longer carries a
    /// server-mint route.
    case openAccount(username: String)
    /// Skippable "Secure your account" step. Shown right after a
    /// brand-new account is opened (OpenAccount) and BEFORE the user
    /// lands in the main app — the new-account path only (never the "I
    /// already have an account" path). Nudges a backup with the cloud
    /// option pre-selected; lets the user skip behind a clear warning.
    /// Reuses the existing cloud-recovery + `.flagshipkey` mechanisms.
    case secureAccount(username: String)
    /// Username-first Join ("I already have an account"). The FIRST
    /// screen is a bare-username input; on submit a single preflight
    /// (`/api/account/resolve`, 200 always) branches: demo attaches a
    /// new device + opens the sandbox; unknown renders an inline state;
    /// single/multi push `.realAccountLogin`. This replaces the old
    /// `assertAny()`-first recovery entry — Join no longer 404s.
    case recoverFromWelcome
    /// Phase 3 — the real single/multi login state machine for a
    /// resolved account. Carries the full `AccountResolution` from the
    /// preflight so the downstream screen branches on `kind` / `recovery`
    /// / `graceModel` WITHOUT re-resolving. Drives:
    ///   - `recovery.present == false` → a clean STATE (single vs multi
    ///     copy), never a 404.
    ///   - `single` (recovery) → passkey-PRF unwrap → 7-day-grace
    ///     TAKEOVER → install UMK → initiate re-pair → admin label.
    ///   - `multi` (recovery + TOTP) → passkey-PRF + recovery-TOTP /
    ///     recovery-code → 24h-grace TAKEOVER → install UMK → admin.
    /// Replaces the Phase-1 stopgap that pushed the old passkey
    /// recovery container. (`AccountResolution` is Hashable so it rides
    /// the typed nav path directly.)
    case realAccountLogin(resolution: AccountResolution)
    /// Phase 3b — cross-device QR pairing as a brand-new collaborator
    /// (the app is UNPAIRED and a `/join` deeplink/scan arrives, or the
    /// user picks "Scan a pairing code" from Welcome). Carries the
    /// scanned/deeplinked `/join` link; runs the incoming JoinAccount
    /// flow which attaches a FRESH device key + installs the shared UMK
    /// into a new per-profile slot, then completes onboarding paired.
    case joinByPairing(joinUrl: String?)
}
