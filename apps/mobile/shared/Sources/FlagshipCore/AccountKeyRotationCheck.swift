import Foundation

/// The `account-key-rotated` push (docs/account-key-rotation.md): an admin device changed the account key and
/// this device was kept. The push proves nothing; it only makes the app ask `.com` for its delivery now, which
/// the app verifies itself under the admin root it pins.
public enum AccountKeyRotationCheck {
    public static let category = "account-key-rotated"

    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: (@Sendable () async -> Void)?

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

    public static func run() async {
        let fn = lock.withLock { handler }
        await fn?()
    }
}
