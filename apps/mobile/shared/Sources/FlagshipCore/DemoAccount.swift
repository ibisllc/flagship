import Foundation
import FlagshipAPI

/// Demo accounts (docs/sample-users.md): real accounts on flagshipserver.com
/// whose name is the capability, each backed by one real demo server. The
/// list of demo usernames lives on `.com` (`demo_users`), never in the app:
/// `/api/users/check` and the account resolver return a `demoServer` block
/// for a demo name, and the app renders that one server, which talks to the
/// real box once the user taps Connect. The app ships no sample data.
public enum DemoAccount {
    /// The one server a demo account owns, from `.com`'s `demoServer` block.
    ///   - `none` / `provisioning` → `.pending` (not connected yet)
    ///   - `up`                    → `.online`
    public static func pod(from block: DemoServerBlock, username: String) -> PodInfo {
        let label = labelFromFqdn(block.fqdn) ?? "Home"
        return PodInfo(
            podId: "demo-server-\(username)",
            name: label.capitalized,
            description: "Live demo server",
            fqdn: block.fqdn,
            status: mapStatus(block.lifecycle),
            demoServer: block
        )
    }

    /// Both `none` and `provisioning` show as `.pending`: the connect action
    /// is the same write either way (POST /connect; `.com` arbitrates).
    public static func mapStatus(_ lifecycle: DemoServerBlock.Lifecycle) -> PodInfo.Status {
        switch lifecycle {
        case .up: return .online
        case .none, .provisioning: return .pending
        }
    }

    /// Sign this device in to the demo account `username`. `.com` always
    /// sends the account's `demoServer`; without one the account has no
    /// servers to show. A `deviceCapability` narrows the session's scopes.
    @MainActor
    public static func activate(
        _ appState: AppState,
        username: String,
        demoServer: DemoServerBlock?,
        deviceCapability: DeviceCapabilityBlock? = nil
    ) {
        appState.completeOnboarding(
            username: username,
            pods: demoServer.map { [pod(from: $0, username: username)] } ?? [],
            demoServer: demoServer
        )
        // After completeOnboarding, which doesn't touch the session-scoped
        // capability.
        appState.deviceCapability = deviceCapability
    }

    private static func labelFromFqdn(_ fqdn: String) -> String? {
        fqdn.split(separator: ".").first.map(String.init)
    }
}
