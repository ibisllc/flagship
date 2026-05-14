import Foundation

/// Test-account / demo-mode fixtures.
///
/// A typed username that the Worker confirms as a test account (via
/// /api/users/check returning a non-null testAccount field) short-
/// circuits the real claim + biometric + create-server flow and pre-
/// populates AppState with believable sample pods so an app reviewer
/// (or curious user) can explore the full surface without provisioning
/// real hardware.
///
/// The list of test-account usernames LIVES OFF THE OPEN SOURCE —
/// it's stored as env.TEST_ACCOUNTS on the Worker. Mobile clients
/// learn that the typed string is a test account only by asking the
/// Worker; we never bake usernames into the app itself.
///
/// Demo mode never:
///   - talks to flagshipserver.com (no auth-code mint, no DNS publish)
///   - talks to a real pod (no /api/screens/* against a live daemon)
///   - registers an APNs push token
///   - touches the Secure Enclave / Keychain UMK
///
/// Sign-out clears the demo flag the same way it clears everything
/// else (AppState.signOut() flips isPaired back to false).
public enum DemoFixtures {
    /// Pods the demo user starts with. The names + descriptions are
    /// obviously sample data so a reviewer can't confuse them for real
    /// pods, but realistic enough that Home / Apps / Activity /
    /// Settings all render meaningfully. The first pod is online so
    /// HomeScreen's leader picks land on a non-pending detail page;
    /// one is offline so the status pill variant is exercised.
    public static func samplePods(username: String) -> [PodInfo] {
        let suffix = { UUID().uuidString.prefix(6).lowercased() }
        return [
            PodInfo(
                podId: "demo-home-\(suffix())",
                name: "Home",
                description: "Living-room mini-PC. Everyday workloads.",
                fqdn: "home.\(username).flagship.services",
                status: .online
            ),
            PodInfo(
                podId: "demo-office-\(suffix())",
                name: "Office",
                description: "Office tower. Failover for work projects.",
                fqdn: "office.\(username).flagship.services",
                status: .online
            ),
            PodInfo(
                podId: "demo-music-\(suffix())",
                name: "Music",
                description: "Garage rack. Music production projects.",
                fqdn: "music.\(username).flagship.services",
                status: .offline
            ),
        ]
    }

    /// Apply demo state for [username] to [appState]. Called from
    /// ChooseUsernameScreen after the Worker confirms the typed name
    /// is a test account. The username itself comes from the user;
    /// the app never assumes a specific one — so a quarterly
    /// rotation of the secret list ships without an app update.
    @MainActor
    public static func activate(_ appState: AppState, username: String) {
        appState.completeOnboarding(
            username: username,
            pods: samplePods(username: username)
        )
    }
}
