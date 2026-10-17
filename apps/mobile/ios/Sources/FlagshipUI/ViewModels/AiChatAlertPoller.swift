import Foundation
import FlagshipCore
import FlagshipAPI

/// #91 — AI-chat alerts: foreground long-poll → app-initiated LOCAL
/// notification → teal operations sliver.
///
/// The AI build chat (vibe-code / scratch) pauses when the model asks the
/// owner a question (`talkToUser`) or requests an env var (`requestEnvVar`).
/// The daemon queues a VALUE-FREE `ai-chat-needs-you` event on the
/// phone-pollable AlertInbox at that transition. This poller drains it on a 5s
/// foreground cadence (matching `BootApprovalWatcher`):
///
///   1. `GET /api/phone/alerts?since=<cursor>` over the paired-session pipe.
///   2. For each `ai-chat-needs-you` envelope: upsert a build op into the
///      `ActiveOperationsCenter` (deep-links to `.vibeCodeChat`), and raise a
///      LOCAL notification (once per session+tool).
///   3. ACK the drained range so the bounded queue doesn't re-deliver.
///
/// The real APNs/FCM push wake is owner-gated on store presence (TestFlight /
/// Play). This foreground poll is the always-on path that works today; the
/// notification + sliver feed are identical whether the wake came from a push
/// or this poll. The drain client + the notifier are injected so the whole
/// loop is unit-testable with no URLSession and no UNUserNotificationCenter.
@MainActor
@Observable
public final class AiChatAlertPoller {
    /// 5s between drains — a cheap paired-session GET, matching the
    /// boot-approval cadence so a paused build surfaces within a few seconds.
    public nonisolated static let pollInterval: UInt64 = 5_000_000_000

    private let operations: ActiveOperationsCenter
    private let client: any PhoneAlertClient
    /// Raise a LOCAL notification for a paused build, naming the server the
    /// alert came from (nil when the client can't say). Injected so tests
    /// don't touch UNUserNotificationCenter; the app wires `PushNotifications`.
    private let notify: @MainActor (_ sessionId: String, _ request: PhoneAlert.AiChatRequest, _ server: String?) -> Void
    /// Gate — only drain while this returns true (paired + unlocked). Mirrors
    /// the sliver's hide-under-lock so nothing surfaces over the lock screen.
    private let isActive: @MainActor () -> Bool
    /// An app on `server` reached its disk limit: say so once per app.
    private let notifyStorageFull: @MainActor (_ serviceId: String, _ server: String?) -> Void
    private var storageNotified: Set<String> = []
    private let pollIntervalNanos: UInt64

    private var task: Task<Void, Never>?
    private var wakeObserver: NSObjectProtocol?
    private var draining = false
    /// ACK cursor per server ("" when the client names none) — the highest
    /// alert id drained from it. Each box numbers its own alerts, so one
    /// server's cursor would skip another's.
    private var cursors: [String: Int] = [:]
    /// Dedup set so a re-drain (e.g. after a failed ACK) won't re-notify the
    /// same pending tool. Keyed by "<sessionId>|<toolUseId>".
    private var notified: Set<String> = []

    public init(
        operations: ActiveOperationsCenter,
        client: any PhoneAlertClient,
        isActive: @escaping @MainActor () -> Bool,
        notify: @escaping @MainActor (_ sessionId: String, _ request: PhoneAlert.AiChatRequest, _ server: String?) -> Void,
        notifyStorageFull: @escaping @MainActor (_ serviceId: String, _ server: String?) -> Void = { _, _ in },
        pollIntervalNanos: UInt64 = AiChatAlertPoller.pollInterval
    ) {
        self.notifyStorageFull = notifyStorageFull
        self.operations = operations
        self.client = client
        self.isActive = isActive
        self.notify = notify
        self.pollIntervalNanos = pollIntervalNanos
    }

    public func start() {
        stop()
        // A content-free `generic` push also means a build chat may wait on
        // the owner: drain at once rather than on the next tick.
        wakeObserver = NotificationCenter.default.addObserver(
            forName: PhoneAlertEvents.wake, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in await self?.drainOnWake() }
        }
        task = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if self.isActive() {
                    await self.drainOnce()
                }
                try? await Task.sleep(nanoseconds: self.pollIntervalNanos)
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
        if let wakeObserver { NotificationCenter.default.removeObserver(wakeObserver) }
        wakeObserver = nil
    }

    /// The drain a wake push asks for; skipped while locked or while another
    /// drain is in flight (that one fetches the same alerts).
    @discardableResult
    public func drainOnWake() async -> Int {
        guard isActive() else { return 0 }
        return await drainOnce()
    }

    /// One drain: fetch since the cursor, act on every `ai-chat-needs-you`
    /// envelope, ACK the range, advance the cursor. Best-effort: a transport
    /// blip leaves the cursor where it was so the next tick re-drains; the
    /// notifier is dedup-guarded so a re-drain won't double-notify. Returns the
    /// number of AI-chat alerts handled (for tests / pull-to-refresh).
    @discardableResult
    public func drainOnce() async -> Int {
        if draining { return 0 }
        draining = true
        defer { draining = false }
        let server = await client.boundServer()
        let key = server ?? ""
        let cursor = cursors[key] ?? 0
        let resp: PhoneAlertsResponse
        do {
            resp = try await client.fetchAlerts(since: cursor)
        } catch {
            return 0
        }
        if resp.events.isEmpty { return 0 }

        var maxId = cursor
        var handled = 0
        for env in resp.events {
            if env.id > maxId { maxId = env.id }
            if case .other(let kind) = env.alert,
               kind == AppAccessEvents.socketEvent || kind == AppAccessEvents.pushCategory {
                AppAccessEvents.post()
                continue
            }
            if case .appStorageFull(let serviceId, _) = env.alert {
                if storageNotified.insert("\(key)|\(serviceId)").inserted { notifyStorageFull(serviceId, server) }
                continue
            }
            guard let (sessionId, request, toolUseId) = env.alert.aiChat, !sessionId.isEmpty else {
                continue
            }
            // Surface in the operations sliver, deep-linking to the chat. Keyed
            // by the session so the live build feeder + this alert feeder
            // reconcile on the same op rather than dueling.
            // Name the server, so the chat opens there even after the owner
            // switched servers (the session lives on that box only).
            operations.upsertBuild(
                id: sessionId,
                subject: "AI build",
                onServer: nil,
                target: server.map { .vibeCodeChatOnServer(sessionId: sessionId, serverFqdn: $0) }
                    ?? .vibeCodeChat(sessionId: sessionId)
            )
            let dedupKey = "\(key)|\(sessionId)|\(toolUseId)"
            if !notified.contains(dedupKey) {
                notified.insert(dedupKey)
                notify(sessionId, request, server)
            }
            handled += 1
        }

        if maxId > cursor {
            cursors[key] = maxId
            // Best-effort ACK — a failure just means we re-drain next tick.
            try? await client.ackAlerts(throughId: maxId)
        }
        return handled
    }
}
