import Foundation

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
}

public enum ActivityRoute: Hashable, Sendable {
    case unlockApprovals
    case installProgress(serial: String)
    /// Activity-feed shortcut into Settings → Recovery → Re-attach
    /// progress. Separate path-stack entry so back-nav lands the user
    /// on Activity, not Settings.
    case postRecovery
}

public enum SettingsRoute: Hashable, Sendable {
    case providers
    case recovery
    case postRecoveryProgress
    case about
    case addControlDevice
    case developer
    case privacy
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
/// "create a new account" (Welcome → ChooseUsername → CreateServer)
/// and "I already have an account" (Welcome → Recovery via WebAuthn-PRF
/// → PostRecoveryChoice). Both leave the user on the paired RootShell.
public enum OnboardingRoute: Hashable, Sendable {
    case chooseUsername
    case createServer(username: String)
    /// WebAuthn-PRF recovery on a fresh install. Fetches the
    /// wrapped UMK from flagshipserver.com using the user's passkey
    /// (iCloud Keychain on Apple-paired devices, or a hardware
    /// authenticator). After unwrap, presents PostRecoveryChoice.
    case recoverFromWelcome
}
