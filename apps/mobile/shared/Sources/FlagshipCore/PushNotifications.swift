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
    /// what happened: a box's relay-trust SOS, a newly registered server, and a
    /// server whose outbound proxy stopped working. They name no server, so a
    /// tap just opens the app, where Home (refreshing `/pods`) shows it.
    public nonisolated static let accountNoticeCategories: Set<String> = ["cert-alert", "server-registered", outboundProxyCategory]

    /// A server's outbound proxy isn't working (docs/outbound-proxy.md "Failure UX"): content-free; Home marks
    /// the server from `/pods` `proxyAlert`.
    public nonisolated static let outboundProxyCategory = "outbound-proxy"

    /// A non-admin device of this account invited someone to one of its apps
    /// (sent to admin devices only, content-free). Its `deepLink` opens the
    /// account activity; older payloads without one still land there.
    public nonisolated static let inviteCreatedCategory = "invite-created"

    /// An operator's notice about a report, or a suspension (docs/abuse-handling.md): content-free. The app re-reads
    /// the notices; a tap just opens it, where Home shows the notice (admin devices) or the suspended screen.
    public nonisolated static let abuseNoticeCategory = "abuse-notice"

    /// voi.ci Messages pushes (content-free): `messages` with kind `message` or `message-request`, and `page-drafts`.
    public nonisolated static let messagesCategory = "messages"
    public nonisolated static let pageDraftsCategory = "page-drafts"

    /// `kind` of the local notice raised when an app on a server ran out of
    /// its disk limit (docs/app-runtimes.md 5.3); a tap opens the app's page.
    public nonisolated static let appStorageFullKind = "app-storage-full"
    /// A retail box's reset window opened (local notification from the alert outbox).
    public nonisolated static let resetWindowKind = "reset-window-opened"
    /// Pro ended, so apps that kept a separate access list on each server use
    /// one list again (content-free; the app's lead server sends it). A tap
    /// opens the activity, where the box's row says what happened.
    public nonisolated static let accessListsCategory = "access-lists"

    /// A voi.ci call ringing this admin device (docs/voici-calls.md §4, §6). PushKit's VoIP push carries the fields
    /// under `flagship-call`; a device without VoIP ringing (the China mainland storefront, where CallKit is not
    /// allowed) gets them as an alert push of this category, which the open app turns into its own ringing screen.
    public nonisolated static let voiciCallCategory = "voici-call"

    /// A call push, VoIP or alert, or nil.
    public nonisolated static func voiciCall(_ info: [AnyHashable: Any], categoryIdentifier: String = "") -> VoiciCallPush? {
        if let nested = info["flagship-call"] as? [AnyHashable: Any] { return VoiciCallPush.parse(nested) }
        let category = info["category"] as? String ?? (info["aps"] as? [AnyHashable: Any])?["category"] as? String
        guard categoryIdentifier == voiciCallCategory || category == voiciCallCategory || (info["kind"] as? String) == voiciCallCategory else { return nil }
        return VoiciCallPush.parse(info)
    }

    /// A page owner ringing this account back (docs/voici-calls.md "ringing a caller back"): `{kind:"voici-ring", ringId,
    /// hint, room}`, nested under `flagship-call` in a VoIP push, flat in an ordinary one. No text: the hint is sealed to
    /// this account's thread key for that page.
    public nonisolated static func voiciRing(_ info: [AnyHashable: Any]) -> VoiciRingPush? {
        let d = (info["flagship-call"] as? [AnyHashable: Any]) ?? info
        guard (d["kind"] as? String) == "voici-ring" else { return nil }
        return VoiciRingPush.parse(d)
    }

    /// Where a tapped push leads: its app link when it carries one, else
    /// what its `kind` / `category` names.
    public nonisolated static func link(forPush info: [AnyHashable: Any]) -> DeepLink? {
        for key in ["deepLink", "flagship_url"] {
            if let raw = info[key] as? String, let url = URL(string: raw), let link = DeepLink.parse(url) {
                // A provision-status push's link names no install; its serial does.
                if case .installProgress(nil, let server) = link {
                    let meta = info["meta"] as? [AnyHashable: Any]
                    if let serial = (meta?["serial"] ?? info["serial"]) as? String, !serial.isEmpty {
                        return .installProgress(key: serial, serverFqdn: server)
                    }
                }
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
        if let k = kind ?? category, k == inviteCreatedCategory || k == accessListsCategory { return .accountActivity }
        // Content-free voi.ci pushes (docs/voici-and-messages.md §8.3): a message or a request opens Messages, another
        // device's post or page edit opens the page editor (admin devices publish it there).
        if category == messagesCategory || kind == "message" || kind == "message-request" { return .messages }
        if category == pageDraftsCategory { return .pageEditor }
        if let category, accountNoticeCategories.contains(category) { return nil }
        if (kind ?? category) == abuseNoticeCategory { return nil }
        if kind == appStorageFullKind, let serviceId = info["serviceId"] as? String, !serviceId.isEmpty {
            if let server = (info["server"] as? String)?.lowercased(), !server.isEmpty {
                return .appDetailOnServer(serviceId: serviceId, serverFqdn: server)
            }
            return .appDetail(serviceId: serviceId)
        }
        if kind == resetWindowKind, let server = (info["server"] as? String)?.lowercased(), !server.isEmpty {
            return .serverDetail(podId: server)
        }
        if kind == "vibecode-needs-you", let sessionId = info["sessionId"] as? String, !sessionId.isEmpty {
            if let server = (info["server"] as? String)?.lowercased(), !server.isEmpty {
                return .vibeCodeChatOnServer(sessionId: sessionId, serverFqdn: server)
            }
            return .vibeCodeChat(sessionId: sessionId)
        }
        return nil
    }

    /// An `abuse-notice` push, by its category (APNs `aps.category`, Android's top-level one) or its `kind`.
    public nonisolated static func isAbuseNotice(_ info: [AnyHashable: Any], categoryIdentifier: String = "") -> Bool {
        let category = info["category"] as? String
            ?? (info["aps"] as? [AnyHashable: Any])?["category"] as? String
        return categoryIdentifier == abuseNoticeCategory || category == abuseNoticeCategory
            || (info["kind"] as? String) == abuseNoticeCategory
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
    public func notifyAppStorageFull(serviceId: String, server: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = "Flagship"
        content.body = String(localized: "An app on this server is full")
        content.sound = .default
        var info: [String: String] = ["kind": Self.appStorageFullKind, "serviceId": serviceId]
        if let server, !server.isEmpty { info["server"] = server }
        content.userInfo = info
        let request = UNNotificationRequest(
            identifier: "flagship-app-storage-\(serviceId)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }

    /// The owner's sentence (docs/retail-box-setup.md §7.5) when someone opens a box's reset window.
    public nonisolated static func resetWindowText(server: String) -> String {
        let name = server.split(separator: ".").first.map(String.init) ?? server
        return String(localized: "Someone pressed the reset button on \(name). If that was not you, the server is unchanged and stays yours unless someone sets it up in the next 10 minutes.")
    }

    public func notifyResetWindowOpened(server: String?, at: Int64) {
        let content = UNMutableNotificationContent()
        content.title = "Flagship"
        content.body = Self.resetWindowText(server: server ?? "")
        content.sound = .default
        var info: [String: String] = ["kind": Self.resetWindowKind]
        if let server, !server.isEmpty { info["server"] = server }
        content.userInfo = info
        let request = UNNotificationRequest(identifier: "flagship-reset-window-\(server ?? "")-\(at)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }

    public func notifyAiChatNeedsYou(sessionId: String, isEnvVar: Bool, server: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = "Flagship"
        content.body = isEnvVar
            ? String(localized: "The AI needs an environment variable to continue.")
            : String(localized: "The AI is asking you a question.")
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
        // Removed from the account: ask `.com` at once (the push itself erases nothing).
        if DeviceRemovedCheck.isPush(info, categoryIdentifier: notification.request.content.categoryIdentifier) {
            Task { await DeviceRemovedCheck.run() }
            completionHandler([.list])
            return
        }
        // The account key changed: fetch and check this device's delivery now.
        if AccountKeyRotationCheck.isPush(info, categoryIdentifier: notification.request.content.categoryIdentifier) {
            Task { await AccountKeyRotationCheck.run() }
            completionHandler([.list])
            return
        }
        // A call while the app is open rings on its own screen, not as a banner.
        if let call = Self.voiciCall(info, categoryIdentifier: notification.request.content.categoryIdentifier) {
            Task { @MainActor in VoiciCallEvents.post(call) }
            completionHandler([.list])
            return
        }
        Task { @MainActor in
            if Self.isAbuseNotice(info, categoryIdentifier: notification.request.content.categoryIdentifier) {
                AbuseNoticeEvents.post()
            }

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
            if Self.isAbuseNotice(userInfo, categoryIdentifier: category) { AbuseNoticeEvents.post() }
            if DeviceRemovedCheck.isPush(userInfo, categoryIdentifier: category) {
                await DeviceRemovedCheck.run()
                completionHandler()
                return
            }
            if AccountKeyRotationCheck.isPush(userInfo, categoryIdentifier: category) {
                await AccountKeyRotationCheck.run()
                completionHandler()
                return
            }
            if let call = Self.voiciCall(userInfo, categoryIdentifier: category) {
                VoiciCallEvents.post(call)
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
            // The install this push is about, never a new create flow.
            linker.enqueue(.installProgress(key: event.serial.isEmpty ? nil : event.serial, serverFqdn: nil))
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

/// The fields of a voi.ci call push: the call id, the room host, the caller sealed to the page's inbox key (base64)
/// and the ring's start. Apple sees no caller.
public struct VoiciCallPush: Equatable, Sendable {
    public let callId: String
    public let room: String
    public let sealed: String
    public let issuedAt: Int64

    public init(callId: String, room: String, sealed: String, issuedAt: Int64) {
        self.callId = callId; self.room = room; self.sealed = sealed; self.issuedAt = issuedAt
    }

    public static func parse(_ d: [AnyHashable: Any]) -> VoiciCallPush? {
        guard let callId = d["callId"] as? String, CanonicalJson.isLowerHex(callId, bytes: 16),
              let room = (d["room"] as? String)?.lowercased(), !room.isEmpty, room.count <= 253,
              room.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }),
              let sealed = d["sealed"] as? String, !sealed.isEmpty, sealed.count <= 8192 else { return nil }
        let at: Int64? = (d["issuedAt"] as? String).flatMap(Int64.init) ?? (d["issuedAt"] as? NSNumber)?.int64Value
        guard let issuedAt = at else { return nil }
        return VoiciCallPush(callId: callId, room: room, sealed: sealed, issuedAt: issuedAt)
    }
}

/// The fields of a ring-back push: the ring id and the hint (base64), sealed to the caller's thread key.
public struct VoiciRingPush: Equatable, Sendable {
    public let ringId: String
    public let hint: String
    /// HMAC of `ringId` under the caller's ring tag key for the page that rings (docs/voici-locked-caller-names.md):
    /// lets a locked phone name the page. Absent from channels attached without a key.
    public let tag: String?

    public init(ringId: String, hint: String, tag: String? = nil) { self.ringId = ringId; self.hint = hint; self.tag = tag }

    public static func parse(_ d: [AnyHashable: Any]) -> VoiciRingPush? {
        guard let id = d["ringId"] as? String, CanonicalJson.isLowerHex(id, bytes: 16), let hint = d["hint"] as? String,
              !hint.isEmpty, hint.count <= 8192, CanonicalJson.b64Decode(hint) != nil else { return nil }
        let tag = (d["tag"] as? String).flatMap { CanonicalJson.isLowerHex($0, bytes: 16) ? $0 : nil }
        return VoiciRingPush(ringId: id, hint: hint, tag: tag)
    }
}

/// An alert-push call (no VoIP ringing on this device) reached the open app.
public enum VoiciCallEvents {
    public static let name = Notification.Name("flagship.voici-call")

    public static func post(_ call: VoiciCallPush) {
        NotificationCenter.default.post(name: name, object: nil, userInfo: ["call": call])
    }

    public static func call(from n: Notification) -> VoiciCallPush? { n.userInfo?["call"] as? VoiciCallPush }
}
