import Foundation
import UserNotifications

/// Wrapper over UNUserNotificationCenter for the operations the iOS app
/// cares about:
///
///   - Request authorization (alert + sound + badge) on first launch
///     after the user has paired (we never prompt pre-pair).
///   - Receive the APNs device token and ship it to the user's pod via
///     `orders/send` as a `register-push-device/v1` envelope so the
///     daemon can deliver Web-Push-style RFC 8291 encrypted payloads
///     for unlock approvals.
///   - On notification tap, parse the `flagship://...` URL out of the
///     payload (or the `view=...` query) and enqueue it on the shared
///     DeepLinker for the SwiftUI shell to consume.
///
/// Real APNs delivery requires an Apple Developer account + APNs key
/// + the matching `APNS_KEY_ID`/`APNS_BUNDLE_ID` secrets on the Worker
/// (see `apps/com/`). This module is the iOS-side seam.
@MainActor
public final class PushNotifications: NSObject {
    public let linker: DeepLinker
    public private(set) var deviceToken: Data?
    public var onDeviceTokenChange: ((Data?) -> Void)?

    public init(linker: DeepLinker) {
        self.linker = linker
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    public func requestAuthorization() async -> Bool {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            return granted
        } catch {
            return false
        }
    }

    /// Forward the iOS-supplied device token (raw bytes from
    /// `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`)
    /// into our state so callers can ship it to the pod.
    public func setDeviceToken(_ token: Data?) {
        self.deviceToken = token
        onDeviceTokenChange?(token)
    }

    public func tokenAsHex() -> String? {
        deviceToken?.map { String(format: "%02x", $0) }.joined()
    }
}

extension PushNotifications: UNUserNotificationCenterDelegate {

    nonisolated public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }

    nonisolated public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        Task { @MainActor in
            self.handleNotificationPayload(userInfo)
            completionHandler()
        }
    }

    @MainActor
    private func handleNotificationPayload(_ info: [AnyHashable: Any]) {
        if let urlString = info["flagship_url"] as? String, let url = URL(string: urlString),
           let link = DeepLink.parse(url) {
            linker.enqueue(link)
            return
        }
        if let requestId = info["requestId"] as? String,
           let kind = info["kind"] as? String, kind == "unlock-approve" {
            linker.enqueue(.unlockApprove(requestId: requestId))
        }
    }
}
