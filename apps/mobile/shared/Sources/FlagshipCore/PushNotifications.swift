import Foundation
import UserNotifications
import FlagshipAPI

/// Wrapper over UNUserNotificationCenter for the operations the iOS app
/// cares about:
///
///   - Request authorization (alert + sound + badge) on first launch
///     after the user has paired (we never prompt pre-pair).
///   - Receive the APNs device token and ship it to the user's pod via
///     `orders/send` as a `register-push-device/v1` envelope so the
///     daemon can deliver Web-Push-style RFC 8291 encrypted payloads
///     for unlock approvals.
///   - On notification tap, parse the payload's app link (`deepLink`, an
///     `https://<controlHost>/app/...` URL; older payloads' `flagship_url`)
///     and enqueue it on the shared DeepLinker for the SwiftUI shell to
///     consume.
///
/// Real APNs delivery requires an Apple Developer account + APNs key
/// + the matching `APNS_KEY_ID`/`APNS_BUNDLE_ID` secrets on the Worker
/// (see `apps/com/`). This module is the iOS-side seam.
@MainActor
public final class PushNotifications: NSObject {
    public let linker: DeepLinker
    public private(set) var deviceToken: Data?
    public var onDeviceTokenChange: ((Data?) -> Void)?

    /// The newest APNs token this app was given, as hex, for screens that
    /// register it somewhere besides the account (a shared server's start-up
    /// notices).
    public private(set) static var latestTokenHex: String?

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
        if let token, !token.isEmpty { Self.latestTokenHex = token.map { String(format: "%02x", $0) }.joined() }
        onDeviceTokenChange?(token)
    }

    /// `kind` of the push a server shared with this account sends when it
    /// waits to start. It rides the owner's `secret-request` category, and
    /// `kind` wins, so it opens Home's "Shared with me" instead of the
    /// owner's approvals list.
    public nonisolated static let shareStartupKind = "share-start-up"

    /// Pushes that carry only their category and whose APNs alert already says
    /// what happened: a box's relay-trust SOS and a newly registered server.
    /// They name no server, so a tap just opens the app, where Home shows it.
    public nonisolated static let accountNoticeCategories: Set<String> = ["cert-alert", "server-registered"]

    /// A non-admin device of this account invited someone to one of its apps
    /// (sent to admin devices only, content-free). Its `deepLink` opens the
    /// account activity; older payloads without one still land there.
    public nonisolated static let inviteCreatedCategory = "invite-created"

    /// Where a tapped push leads: its app link when it carries one, else
    /// what its `kind` / `category` names.
    public nonisolated static func link(forPush info: [AnyHashable: Any]) -> DeepLink? {
        for key in ["deepLink", "flagship_url"] {
            if let raw = info[key] as? String, let url = URL(string: raw), let link = DeepLink.parse(url) {
                return link
            }
        }
        let kind = info["kind"] as? String
        if kind == shareStartupKind { return .sharedWithMe }
        // APNs carries the category only inside `aps`; a top-level one is
        // Android's spelling and local notifications'.
        let category = info["category"] as? String
            ?? (info["aps"] as? [AnyHashable: Any])?["category"] as? String
        if (kind ?? category) == "secret-request" { return .secretRequests }
        if (kind ?? category) == inviteCreatedCategory { return .accountActivity }
        if let category, accountNoticeCategories.contains(category) { return nil }
        if kind == "vibecode-needs-you", let sessionId = info["sessionId"] as? String, !sessionId.isEmpty {
            if let server = (info["server"] as? String)?.lowercased(), !server.isEmpty {
                return .vibeCodeChatOnServer(sessionId: sessionId, serverFqdn: server)
            }
            return .vibeCodeChat(sessionId: sessionId)
        }
        return nil
    }

    public func tokenAsHex() -> String? {
        deviceToken?.map { String(format: "%02x", $0) }.joined()
    }

    /// #91 — raise an app-initiated LOCAL notification that an AI build chat
    /// is waiting on the owner. Value-free copy (driven only by the pending
    /// tool kind). The `userInfo` carries `kind: "vibecode-needs-you"` +
    /// `sessionId`, so the existing tap-handler routes it to
    /// `.vibeCodeChat(sessionId:)` exactly like a real Web-Push wake. Best-
    /// effort: if authorization wasn't granted the system drops it silently —
    /// the operations sliver already carries the signal.
    public func notifyAiChatNeedsYou(sessionId: String, isEnvVar: Bool, server: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = "Flagship"
        content.body = isEnvVar
            ? "The AI needs an environment variable to continue."
            : "The AI is asking you a question."
        content.sound = .default
        var info: [String: String] = ["kind": "vibecode-needs-you", "sessionId": sessionId]
        if let server, !server.isEmpty { info["server"] = server }
        content.userInfo = info
        // Per-session identifier so a re-fire for the same session replaces the
        // prior banner rather than stacking.
        let request = UNNotificationRequest(
            identifier: "flagship-ai-chat-\(sessionId)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }
}

extension PushNotifications: UNUserNotificationCenterDelegate {

    nonisolated public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // A canonical `provision-status` push that arrives while the app is
        // foregrounded should still drive the install-progress surface (the
        // user is very likely watching the provisioning screen). Route it
        // without also enqueuing a deep link — they're already in-app.
        let info = notification.request.content.userInfo
        // A `generic` push (`app-access` from an older box): the app is open,
        // so it fetches what's waiting from the box (access requests and
        // build chats that need the owner) and asks in-app instead of a banner.
        if AppAccessEvents.isPush(info, categoryIdentifier: notification.request.content.categoryIdentifier) {
            Task { @MainActor in
                AppAccessEvents.post()
                PhoneAlertEvents.postWake()
            }
            completionHandler([.list])
            return
        }
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
        let category = response.notification.request.content.categoryIdentifier
        Task { @MainActor in
            // `generic` / `app-access` carry nothing about the app or host:
            // opening the app is the whole action; it fetches the details.
            if AppAccessEvents.isPush(userInfo, categoryIdentifier: category) {
                AppAccessEvents.post()
                PhoneAlertEvents.postWake()
                completionHandler()
                return
            }
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
            linker.enqueue(.createServer)
            return
        }
        // A box waiting to start: the owner's `secret-request` push routes
        // to the approvals list, a shared server's to Home. The vibecode
        // fallback is for sealed-payload pushes that surface only discrete
        // fields in `userInfo` (`category` mirrors Android's alternate key).
        if let link = Self.link(forPush: info) {
            linker.enqueue(link)
        }
    }
}
