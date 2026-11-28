import Foundation
import FlagshipAPI

/// The `device-removed` push (docs/revocation-ui.md): another device removed this one from the account. The push
/// proves nothing and erases nothing. It only makes the app ask `.com` now (a fresh read-token mint signed with this
/// device's own key); `.com`'s `403 device-removed` answer then reaches `AccountGoneRegistry`, and the app erases
/// the account's keys on that answer alone.
public enum DeviceRemovedCheck {
    public static let category = "device-removed"

    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: (@Sendable () async -> Void)?

    /// Set once by the app: ask `.com` about this device, and erase if it said so.
    public static func setHandler(_ fn: (@Sendable () async -> Void)?) {
        lock.lock()
        handler = fn
        lock.unlock()
    }

    public static func isPush(_ info: [AnyHashable: Any], categoryIdentifier: String = "") -> Bool {
        let aps = info["aps"] as? [AnyHashable: Any]
        return categoryIdentifier == category || (info["category"] as? String) == category
            || (aps?["category"] as? String) == category || (info["kind"] as? String) == category
    }

    /// Run the check (no-op before the app set its handler).
    public static func run() async {
        let fn = lock.withLock { handler }
        await fn?()
    }
}
