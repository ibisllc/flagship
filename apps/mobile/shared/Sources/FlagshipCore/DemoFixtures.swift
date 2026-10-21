#if DEBUG
import Foundation
import FlagshipAPI

/// The mock gym's sample servers (Debug builds only; Release ships no sample
/// data). A `-smoke-mode` launch seeds the shell with these so every screen
/// renders with no backend. Real demo accounts are `DemoAccount`: `.com` names
/// one real server for them.
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
                name: String(localized: "Home"),
                description: String(localized: "Living-room mini-PC"),
                fqdn: "home.\(username).flagship.services",
                status: .online
            ),
            PodInfo(
                podId: "demo-office-\(suffix())",
                name: String(localized: "Office"),
                description: String(localized: "Office tower, work failover"),
                fqdn: "office.\(username).flagship.services",
                status: .online
            ),
            PodInfo(
                podId: "demo-music-\(suffix())",
                name: String(localized: "Music"),
                description: String(localized: "Garage rack, music studio"),
                fqdn: "music.\(username).flagship.services",
                status: .offline,
                // Was live, stopped reporting a few hours ago: the honest
                // "offline, last seen" state, not "never came online".
                liveness: .unreachable,
                lastSeenMsAgo: 3 * 60 * 60 * 1000
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
                name: String(localized: "Cabin"),
                description: String(localized: "Remote box, waiting to unlock"),
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
                name: String(localized: "Attic"),
                description: String(localized: "Old box that never came online"),
                fqdn: "attic.\(username).flagship.services",
                status: .offline,
                cameOnline: false,
                registeredAt: sevenDaysAgoMs,
                awaitingUnlock: false
            )
        )
        return pods
    }

    /// GYM seed variant — the three sample pods PLUS a box the owner revoked
    /// (lost, then found again): its page says it's revoked and offers
    /// Un-revoke instead of Revoke. Gym-only.
    public static func samplePodsWithRevokedServer(username: String) -> [PodInfo] {
        let suffix = { UUID().uuidString.prefix(6).lowercased() }
        var pods = samplePods(username: username)
        let twoDaysAgoMs = Int64(Date().timeIntervalSince1970 * 1000) - 2 * 24 * 60 * 60 * 1000
        pods.append(
            PodInfo(
                podId: "demo-garage-\(suffix())",
                name: String(localized: "Garage"),
                description: String(localized: "Revoked after it went missing"),
                fqdn: "garage.\(username).flagship.services",
                status: .offline,
                revokedAt: twoDaysAgoMs,
                revocationReason: "lost"
            )
        )
        return pods
    }

    public static func samplePodFromDemoServer(_ block: DemoServerBlock, username: String) -> PodInfo {
        DemoAccount.pod(from: block, username: username)
    }

    public static func mapStatus(_ lifecycle: DemoServerBlock.Lifecycle) -> PodInfo.Status {
        DemoAccount.mapStatus(lifecycle)
    }

    /// A demo session as `.com` describes it, or (no `demoServer`) the three
    /// sample servers the gym starts from.
    @MainActor
    public static func activate(
        _ appState: AppState,
        username: String,
        demoServer: DemoServerBlock? = nil,
        deviceCapability: DeviceCapabilityBlock? = nil
    ) {
        if demoServer != nil {
            DemoAccount.activate(appState, username: username, demoServer: demoServer, deviceCapability: deviceCapability)
            return
        }
        appState.completeOnboarding(username: username, pods: samplePods(username: username))
        appState.deviceCapability = deviceCapability
    }

    /// Seed the shell with an explicit pod set (the seed-state variants above).
    @MainActor
    public static func activate(
        _ appState: AppState,
        username: String,
        pods: [PodInfo]
    ) {
        appState.completeOnboarding(username: username, pods: pods)
    }
}
#endif
