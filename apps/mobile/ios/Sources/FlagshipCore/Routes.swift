import Foundation

/// Typed navigation destinations per tab. Each NavigationStack inside the
/// RootShell uses one of these as its path element type so we get
/// type-safe deep-linking and zero stringly-typed navigation.
public enum HomeRoute: Hashable, Sendable {
    case serverDetail(podId: String)
    case addServer
    case podPair
    case createServer
    case pairedSessions
    case tierStatus
}

public enum AppsRoute: Hashable, Sendable {
    case appDetail(appId: String)
    case marketplace
    case marketplaceDetail(creator: String, slug: String)
    case vibeCodeProviderPick
    case vibeCodeDescribe
    case vibeCodeGenerating(sessionId: String)
}

public enum ActivityRoute: Hashable, Sendable {
    case unlockApprovals
    case installProgress(serial: String)
}

public enum SettingsRoute: Hashable, Sendable {
    case providers
    case recovery
    case about
    case addServer
    case podPair
    case createServer
    case serverDetail(podId: String)
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

/// Onboarding sub-routes. Welcome is the root; the two leaf flows are
/// "create new server" and "pair to existing server."
public enum OnboardingRoute: Hashable, Sendable {
    case chooseUsername
    case createServer(username: String)
    case podPair
}
