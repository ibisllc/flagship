import Foundation
#if canImport(UserNotifications)
import UserNotifications
#endif

/// Schedules the dead-man affirmation reminders: the phone prompts the owner
/// to manually re-affirm BEFORE the lease lapses, at T-6h / T-1h / T-15m.
///
/// The scheduling math is a pure, testable function (`fireOffsets` /
/// `pendingFireDates`); the UNUserNotificationCenter side-effect is a thin
/// wrapper so previews/tests never touch the real center.
public enum DeadManReminders {
    /// Reminder lead times before lease expiry. Pinned to the spec
    /// (T-6h / T-1h / T-15m).
    public static let leadTimesMs: [Int64] = [6 * 3600_000, 1 * 3600_000, 15 * 60_000]

    /// Notification-identifier prefix, per server, so re-scheduling can
    /// cancel a server's previous reminders without touching others'.
    public static func identifierPrefix(serverDomain: String) -> String {
        "flagship.deadman.reminder." + serverDomain.lowercased() + "."
    }

    public static func identifier(serverDomain: String, leadMs: Int64) -> String {
        identifierPrefix(serverDomain: serverDomain) + String(leadMs)
    }

    /// The fire instants (ms since epoch) for a given lease expiry, dropping
    /// any already in the past relative to `now`. Pure — drives both the real
    /// scheduler and the tests.
    public static func pendingFireDates(leaseExpiryMs: Int64, nowMs: Int64) -> [(leadMs: Int64, fireAtMs: Int64)] {
        leadTimesMs
            .map { (leadMs: $0, fireAtMs: leaseExpiryMs - $0) }
            .filter { $0.fireAtMs > nowMs }
    }

    #if canImport(UserNotifications)
    /// Cancel any previously-scheduled reminders for this server, then
    /// schedule fresh ones for the new lease expiry. A no-op set (lease too
    /// soon for any lead time) just leaves the server with none pending —
    /// the user is presumably about to be locked out by design.
    public static func reschedule(
        serverDomain: String,
        serverName: String,
        leaseExpiryMs: Int64,
        nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        center: UNUserNotificationCenter = .current()
    ) {
        cancel(serverDomain: serverDomain, center: center)
        let pending = pendingFireDates(leaseExpiryMs: leaseExpiryMs, nowMs: nowMs)
        for p in pending {
            let content = UNMutableNotificationContent()
            content.title = "Keep \(serverName) unlocked?"
            content.body = "Tap to affirm — otherwise it locks when the window lapses."
            content.sound = .default
            content.categoryIdentifier = "deadman-affirm"
            content.userInfo = ["category": "deadman-affirm", "serverDomain": serverDomain]

            let intervalSec = max(1.0, Double(p.fireAtMs - nowMs) / 1000.0)
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: intervalSec, repeats: false)
            let req = UNNotificationRequest(
                identifier: identifier(serverDomain: serverDomain, leadMs: p.leadMs),
                content: content,
                trigger: trigger
            )
            center.add(req, withCompletionHandler: nil)
        }
    }

    /// Cancel all pending reminders for a server (used on disable + before a
    /// reschedule).
    public static func cancel(
        serverDomain: String,
        center: UNUserNotificationCenter = .current()
    ) {
        let ids = leadTimesMs.map { identifier(serverDomain: serverDomain, leadMs: $0) }
        center.removePendingNotificationRequests(withIdentifiers: ids)
    }
    #endif
}
