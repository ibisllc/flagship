import Foundation
import FlagshipCore

/// A new server asks twice on its first boot: "Unlock device", then about 80 s later "Authorize device to join your
/// cloud" (the creating device checks the box's first-contact code on that second request). The second arrived with
/// nothing on screen, so the owner had to find it in Activity → Server approvals (Windows acceptance, 2026-11-06).
/// After a first-boot unlock is approved the server is watched for a while; when its entitlement request shows up in
/// the Box Request Inbox the app brings the approvals back. Mirror of Android SecondStepWatch and the webapp's.
@MainActor
public final class SecondStepWatch {
    public static let shared = SecondStepWatch()
    public static let window: TimeInterval = 10 * 60

    private let window: TimeInterval
    private var armed: [String: Date] = [:]

    public init(window: TimeInterval = SecondStepWatch.window) { self.window = window }

    /// The owner just approved `server`'s first-boot unlock: its next request is the second step.
    public func arm(_ server: String, now: Date = Date()) {
        armed[server.lowercased()] = now.addingTimeInterval(window)
    }

    /// The watched servers whose entitlement request now waits (`awaitingEntitlement`, lowercased fqdns). Each is
    /// reported once; a watch past its window is dropped.
    public func arrived(_ awaitingEntitlement: Set<String>, now: Date = Date()) -> [String] {
        armed = armed.filter { $0.value >= now }
        let hits = armed.keys.filter { awaitingEntitlement.contains($0) }.sorted()
        for h in hits { armed[h] = nil }
        return hits
    }

    /// The Home row of a server that has never come online (a fresh order) and is waiting for an approval opens the
    /// approvals, not the install screen. A running server keeps its page (its own Approve card).
    public static func opensApprovals(fqdn: String, neverOnline: Bool, inbox: [String: [BoxRequest]]) -> Bool {
        neverOnline && !(inbox[fqdn.lowercased()] ?? []).isEmpty
    }
}
