import Foundation

/// Snapshot of the user's pods that the app publishes to the App Group
/// container so the home-screen widget can render without launching
/// the app. Refreshed on every AppState change (sign-in, sign-out,
/// pods array mutation).
///
/// Why a separate type (not PodInfo): widget extensions can't depend
/// on FlagshipCore without dragging in SwiftUI + Observation + the
/// rest of the iOS app surface — extension binaries are size-capped.
/// Keep this struct tiny + Codable so the widget binary stays lean.
public struct PodStatusSnapshot: Codable, Sendable, Hashable {
    public struct Pod: Codable, Sendable, Hashable, Identifiable {
        public var id: String { podId }
        public let podId: String
        public let name: String
        public let fqdn: String
        public let statusRaw: String      // "online" | "offline" | "pending" | "unknown"
        public let isLeader: Bool

        public init(podId: String, name: String, fqdn: String, statusRaw: String, isLeader: Bool) {
            self.podId = podId
            self.name = name
            self.fqdn = fqdn
            self.statusRaw = statusRaw
            self.isLeader = isLeader
        }
    }

    public let username: String?
    public let pods: [Pod]
    public let updatedAt: Date

    public init(username: String? = nil, pods: [Pod] = [], updatedAt: Date = .init()) {
        self.username = username
        self.pods = pods
        self.updatedAt = updatedAt
    }

    /// Empty snapshot — what the widget reads before the app has ever
    /// written one (fresh install, app never launched).
    public static let empty = PodStatusSnapshot()

    /// App Group identifier the snapshot is keyed under. Both the
    /// main app and the widget extension must declare this group in
    /// their entitlements.
    public static let appGroupId = "group.com.flagshipserver.app"
    public static let userDefaultsKey = "pod-status-snapshot.v1"

    public static func read(from defaults: UserDefaults? = UserDefaults(suiteName: appGroupId)) -> PodStatusSnapshot {
        guard
            let defaults,
            let data = defaults.data(forKey: userDefaultsKey),
            let snap = try? JSONDecoder().decode(PodStatusSnapshot.self, from: data)
        else {
            return .empty
        }
        return snap
    }

    public func write(to defaults: UserDefaults? = UserDefaults(suiteName: appGroupId)) {
        guard let defaults, let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: PodStatusSnapshot.userDefaultsKey)
    }
}
