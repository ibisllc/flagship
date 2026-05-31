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
            // .criticalAlert lets unlock-approval pushes bypass Focus /
            // Do-Not-Disturb. The system silently downgrades it to a
            // normal alert until Apple grants the
            // com.apple.developer.usernotifications.critical-alerts
            // entitlement (separate request via
            // developer.apple.com/contact/request/notifications-critical-alerts-entitlement/).
            // Shipping the option pre-grant is harmless and saves an
            // app update once the entitlement lands.
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge, .criticalAlert])
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
        // A provision-phase push that arrives while the app is foregrounded
        // should still drive the install-progress surface (the user is
        // very likely watching the provisioning screen). Route it without
        // also enqueuing a deep link — they're already in-app.
        let info = notification.request.content.userInfo
        Task { @MainActor in
            if let event = ProvisionPhaseBridge.parse(info) {
                ProvisionPhaseBridge.shared.onPhase?(event)
            }
        }
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
        // Provisioning observability — route the phase into the
        // install-progress Live Activity AND deep-link to the progress
        // screen so a tap on the notification opens it.
        if let event = ProvisionPhaseBridge.parse(info) {
            ProvisionPhaseBridge.shared.onPhase?(event)
            if let url = URL(string: "flagship://create-server") {
                if let link = DeepLink.parse(url) { linker.enqueue(link) }
            }
            return
        }
        if let urlString = info["flagship_url"] as? String, let url = URL(string: urlString),
           let link = DeepLink.parse(url) {
            linker.enqueue(link)
            return
        }
        // Phone-as-unlock-endpoint RELAY (sealed-key flow): a box is
        // finishing setup / rebooting in "approve" mode and needs the phone
        // to release its boot secret. Routes to the SecretRequests approval
        // list. (`category` mirrors the Android FCM payload's alternate key.)
        if let kind = (info["kind"] as? String) ?? (info["category"] as? String),
           kind == "secret-request" {
            linker.enqueue(.secretRequests)
            return
        }
        // W10 — vibecode-needs-you push.
        //
        // The .com Web Push fan-out (RFC 8291 encrypted) carries
        // { kind, sessionId, appId, request, deepLink } where deepLink
        // is `flagship://vibecode/<sessionId>`. If the iOS notification
        // unwraps that payload, the deepLink path above handles it; the
        // fallback here is for sealed-payload pushes that surface only
        // the discrete fields in `userInfo`.
        if let kind = info["kind"] as? String, kind == "vibecode-needs-you",
           let sessionId = info["sessionId"] as? String, !sessionId.isEmpty {
            linker.enqueue(.vibeCodeChat(sessionId: sessionId))
        }
    }
}
