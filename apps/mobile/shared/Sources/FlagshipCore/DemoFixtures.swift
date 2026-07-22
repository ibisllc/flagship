import Foundation
import FlagshipAPI

/// Test-account / demo-mode fixtures.
///
/// Two coexisting modes drive demo accounts:
///
///   1. **Legacy fixtures-only** (`testAccount`-only). The Worker
///      returns a `testAccount` block but no `demoServer` block.
///      `activate(_:username:)` materialises three obviously-fake
///      sample pods so a reviewer can explore the surface without
///      provisioning real hardware. This is the v1.0 behaviour and
///      stays available so already-shipped binaries continue to work.
///
///   2. **On-connect Hetzner** (Plan A, Phase D). The Worker
///      additionally returns a `demoServer` block describing one real
///      VPS — its FQDN and lifecycle state (`none` / `provisioning` /
///      `up`). `activate(_:username:demoServer:)` materialises ONE
///      pod backed by that FQDN; tapping connect calls the
///      `/api/dev/sample-user/{u}/connect` endpoint and polls until
///      the lifecycle flips to `up`. See docs/sample-users.md §3.
///
/// The list of test-account usernames LIVES OFF THE OPEN SOURCE —
/// it's stored as env.TEST_ACCOUNTS (legacy) plus a `demo_users` D1
/// row (live) on the Worker. Mobile clients learn that the typed
/// string is a demo only by asking the Worker; we never bake
/// usernames into the app itself.
///
/// Demo mode (legacy) never:
///   - talks to flagshipserver.com (no auth-code mint, no DNS publish)
///   - talks to a real pod (no /api/screens/* against a live daemon)
///   - registers an APNs push token
///   - touches the Secure Enclave / Keychain UMK
///
/// Demo mode (Plan A) DOES talk to a real pod, but only after the
/// user explicitly taps "Connect" on the single rendered device. The
/// pod is a Hetzner VPS provisioned from a pre-built snapshot; the
/// daemon there serves real `/api/screens/*` requests over a real
/// Let's Encrypt cert.
///
/// Sign-out clears the demo flag the same way it clears everything
/// else (AppState.signOut() flips isPaired back to false).
public enum DemoFixtures {
    /// Pods the legacy demo user starts with. Three obviously-fake
    /// sample pods so a reviewer can explore Home / Apps / Activity /
    /// Settings. The first is online so HomeScreen's leader picks
    /// land on a non-pending detail page; one is offline so the
    /// status pill variant is exercised.
    public static func samplePods(username: String) -> [PodInfo] {
        let suffix = { UUID().uuidString.prefix(6).lowercased() }
        return [
            PodInfo(
                podId: "demo-home-\(suffix())",
                name: "Home",
                description: "Living-room mini-PC",
                fqdn: "home.\(username).flagship.services",
                status: .online
            ),
            PodInfo(
                podId: "demo-office-\(suffix())",
                name: "Office",
                description: "Office tower, work failover",
                fqdn: "office.\(username).flagship.services",
                status: .online
            ),
            PodInfo(
                podId: "demo-music-\(suffix())",
                name: "Music",
                description: "Garage rack, music studio",
                fqdn: "music.\(username).flagship.services",
                status: .offline
            ),
        ]
    }

    /// GYM seed variant (Tier-1 total gym, §6 D5) — the three sample pods
    /// PLUS one box that is waiting for a boot-unlock approval (`awaitingUnlock`
    /// = true, offline + never-came-online). Seeds the F1 "awaiting-unlock"
    /// event state deterministically: its Home row reads "waiting for approval"
    /// (`pod-card-waiting-approval`) and its server-detail surfaces the
    /// `sd-approve-unlock` card. Gym-only — the live app never seeds this.
    public static func samplePodsWithAwaitingUnlock(username: String) -> [PodInfo] {
        let suffix = { UUID().uuidString.prefix(6).lowercased() }
        var pods = samplePods(username: username)
        pods.append(
            PodInfo(
                podId: "demo-cabin-\(suffix())",
                name: "Cabin",
                description: "Remote box, waiting to unlock",
                fqdn: "cabin.\(username).flagship.services",
                status: .offline,
                cameOnline: false,
                awaitingUnlock: true
            )
        )
        return pods
    }

    /// GYM seed variant (Tier-1 total gym, §6 D5) — the three sample pods PLUS
    /// one box that registered long ago but never checked in and has no live
    /// unlock request: the liveness classifier lands it on `.dead`. Seeds the
    /// F3 "dead/offline" event state deterministically — its Home row carries
    /// the `pod-card-never-online` pill. `registeredAt` is set well past the
    /// coming-online grace so the classification is stable. Gym-only.
    public static func samplePodsWithDeadServer(username: String) -> [PodInfo] {
        let suffix = { UUID().uuidString.prefix(6).lowercased() }
        var pods = samplePods(username: username)
        // Registered ~7 days ago (far past the coming-online grace window) with
        // no check-in and no live unlock request ⇒ classified `.dead`.
        let sevenDaysAgoMs = Int64(Date().timeIntervalSince1970 * 1000) - 7 * 24 * 60 * 60 * 1000
        pods.append(
            PodInfo(
                podId: "demo-attic-\(suffix())",
                name: "Attic",
                description: "Old box that never came online",
                fqdn: "attic.\(username).flagship.services",
                status: .offline,
                cameOnline: false,
                registeredAt: sevenDaysAgoMs,
                awaitingUnlock: false
            )
        )
        return pods
    }

    /// Plan A — build ONE pod from a server-supplied demoServer
    /// block. Used by the live demo flow: `/api/users/check` returned
    /// a `demoServer` and we render that single device instead of the
    /// three legacy fixtures.
    ///
    /// Status mapping:
    ///   - `none`          → `.pending` (user hasn't tapped connect yet)
    ///   - `provisioning`  → `.pending`
    ///   - `up`            → `.online`
    public static func samplePodFromDemoServer(
        _ block: DemoServerBlock,
        username: String
    ) -> PodInfo {
        let label = labelFromFqdn(block.fqdn) ?? "Home"
        return PodInfo(
            podId: "demo-server-\(username)",
            name: label.capitalized,
            description: "Live demo on Hetzner",
            fqdn: block.fqdn,
            status: mapStatus(block.lifecycle),
            demoServer: block
        )
    }

    /// Map the demoServer lifecycle enum to the iOS pod-status enum.
    /// Both `none` and `provisioning` surface as `.pending` so the
    /// home-screen renders the same "waiting" affordance — the connect
    /// CTA is the same write either way (POST /connect; the Worker is
    /// the state-machine arbiter).
    public static func mapStatus(_ lifecycle: DemoServerBlock.Lifecycle) -> PodInfo.Status {
        switch lifecycle {
        case .up: return .online
        case .none, .provisioning: return .pending
        }
    }

    /// Apply demo state for [username] to [appState]. Called from
    /// ChooseUsernameScreen after the Worker confirms the typed name
    /// is a test account.
    ///
    /// When [demoServer] is non-nil (Plan A), materialise ONE pod with
    /// the server-supplied FQDN + lifecycle. When nil (legacy), fall
    /// back to the three-fixture path so already-shipped binaries
    /// (and reviewers who don't want a live pod) keep working.
    ///
    /// When [deviceCapability] is non-nil (v2 device-addressing), the
    /// session inherits its scope set — the AccountHeader chip + the
    /// "this device cannot install services" tooltip render. Legacy
    /// callers omit it and get full scopes.
    @MainActor
    public static func activate(
        _ appState: AppState,
        username: String,
        demoServer: DemoServerBlock? = nil,
        deviceCapability: DeviceCapabilityBlock? = nil
    ) {
        if let block = demoServer {
            appState.completeOnboarding(
                username: username,
                pods: [samplePodFromDemoServer(block, username: username)],
                demoServer: block
            )
        } else {
            appState.completeOnboarding(
                username: username,
                pods: samplePods(username: username)
            )
        }
        // Write the capability AFTER completeOnboarding so it survives
        // the state mutation (completeOnboarding does NOT touch
        // deviceCapability — it's session-scoped not pod-scoped).
        appState.deviceCapability = deviceCapability
    }

    /// GYM activate (Tier-1 total gym) — seed the paired shell with an
    /// EXPLICIT pod set, for the D5 seed-state variants (awaiting-unlock /
    /// dead). Mirrors `activate(_:username:)` but lets the caller hand in the
    /// pods (e.g. `samplePodsWithAwaitingUnlock` / `samplePodsWithDeadServer`)
    /// so a gym scenario can render a specific server-event state without a
    /// backend. Gym-only — the live app uses the username-driven overload.
    @MainActor
    public static func activate(
        _ appState: AppState,
        username: String,
        pods: [PodInfo]
    ) {
        appState.completeOnboarding(username: username, pods: pods)
    }

    // Internal helper — first label of the FQDN ("home" from
    // "home.demoalice.flagship.services").
    private static func labelFromFqdn(_ fqdn: String) -> String? {
        let parts = fqdn.split(separator: ".")
        guard let first = parts.first else { return nil }
        return String(first)
    }
}
