import Foundation
import Observation
import FlagshipAPI
import FlagshipCore

/// App-wide "<App> wants to reach <host>" alerts (docs/ai-privacy-and-staging.md
/// §3a). A `generic` push (`app-access` from an older box) and the box's
/// `access-request` event say only that something is waiting; this asks every box the phone manages
/// (`GET /api/screens/access-requests`, over each box's paired session) and
/// shows one sheet per request: Allow / Deny (sign the edited list) or Not now
/// (keeps the request on the box; this device doesn't ask about it again for
/// 24 hours). A suggested list (draft) comes first: "<App> suggests an access
/// list" with Review (the app's editor, prefilled with the draft; Save signs
/// it) or Not now. With push notifications switched off it shows no sheet at
/// all; requests still wait on each app's page.
@Observable
@MainActor
public final class AppAccessAlertCenter {
    /// One managed box: its FQDN and a client that talks to it.
    public struct Box {
        public let serverDomain: String
        public let client: any ScreensClient
        public init(serverDomain: String, client: any ScreensClient) {
            self.serverDomain = serverDomain
            self.client = client
        }
    }

    public struct Item: Identifiable, Equatable {
        public enum Entry: Equatable {
            case host(AppAccessRequest)
            case draft(AppAccessDraftEntry)
        }

        public let serverDomain: String
        public let entry: Entry

        public init(serverDomain: String, entry: Entry) {
            self.serverDomain = serverDomain
            self.entry = entry
        }

        public init(serverDomain: String, request: AppAccessRequest) {
            self.init(serverDomain: serverDomain, entry: .host(request))
        }

        /// A single waiting host, or nil for a suggested list.
        public var request: AppAccessRequest? {
            if case .host(let r) = entry { return r }
            return nil
        }

        /// A suggested list, or nil for a single host.
        public var draft: AppAccessDraftEntry? {
            if case .draft(let d) = entry { return d }
            return nil
        }

        public var serviceId: String {
            switch entry {
            case .host(let r): return r.serviceId
            case .draft(let d): return d.serviceId
            }
        }

        public var appName: String {
            switch entry {
            case .host(let r): return r.appName
            case .draft(let d): return d.appName
            }
        }

        /// A newer draft (another `createdAt`) is a new item, so Not now on
        /// an older one doesn't silence it.
        public var id: String {
            switch entry {
            case .host(let r): return "\(serverDomain)|\(r.serviceId)|\(r.host)"
            case .draft(let d): return "\(serverDomain)|\(d.serviceId)|draft|\(d.createdAt)"
            }
        }
    }

    public enum Stage: Equatable {
        case ask
        case working(AppAccessAction)
        case done(AppAccessAction)
        /// A reviewed draft was signed and sent.
        case saved
        /// Fetching the draft's list for Review.
        case opening
        case failed(String)
    }

    public private(set) var queue: [Item] = []
    public private(set) var stage: Stage = .ask
    /// The list editor opened from the confirmation ("View access list").
    public var editor: AppAccessEditorModel?
    public private(set) var isRefreshing = false

    public var current: Item? { queue.first }

    private let boxes: @MainActor () async -> [Box]
    private let isActive: @MainActor () -> Bool
    private let alertsEnabled: @MainActor () -> Bool
    private let signer: AppAccessSigner
    private var clients: [String: any ScreensClient] = [:]
    /// Not now (or swiped away while asking): request id → until when this
    /// device stays quiet about it. Kept in `defaults` so it survives a restart.
    public static let notNowInterval: TimeInterval = 24 * 60 * 60
    private static let snoozeKey = "flagship.appAccess.notNowUntil"
    private let defaults: UserDefaults
    private let now: () -> Date
    /// Answered or failed, then closed: not offered again in this run.
    private var answered: Set<String> = []
    private var observer: NSObjectProtocol?

    public init(boxes: @escaping @MainActor () async -> [Box],
                isActive: @escaping @MainActor () -> Bool = { true },
                alertsEnabled: @escaping @MainActor () -> Bool = { true },
                signer: AppAccessSigner? = nil,
                defaults: UserDefaults = .standard,
                now: @escaping () -> Date = Date.init) {
        self.boxes = boxes
        self.defaults = defaults
        self.now = now
        self.isActive = isActive
        self.alertsEnabled = alertsEnabled
        self.signer = signer ?? AppAccessOrder.defaultSigner
    }

    /// Refresh whenever a push, socket frame or alert says a request waits.
    public func observeEvents() {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(
            forName: AppAccessEvents.requested, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
    }

    private var listeners: [String: Task<Void, Never>] = [:]

    /// While the app is in front: hold each box's events socket open and
    /// refresh on every `access-request` frame (a closed socket is reopened
    /// after a pause). The foreground refresh covers a box without one.
    public func startListening(retryAfter: Duration = .seconds(30)) async {
        guard alertsEnabled() else { return stopListening() }
        let current = await boxes()
        let domains = Set(current.map(\.serverDomain))
        for (domain, task) in listeners where !domains.contains(domain) {
            task.cancel()
            listeners[domain] = nil
        }
        for box in current where listeners[box.serverDomain] == nil {
            clients[box.serverDomain] = box.client
            listeners[box.serverDomain] = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    for await _ in box.client.accessRequestEvents() {
                        await self?.refresh()
                    }
                    try? await Task.sleep(for: retryAfter)
                }
            }
        }
    }

    public func stopListening() {
        listeners.values.forEach { $0.cancel() }
        listeners = [:]
    }

    /// Ask every managed box for waiting requests and queue the new ones.
    /// Alerts switched off: drop the queue (an answer in flight finishes).
    public func refresh() async {
        guard alertsEnabled() else {
            if case .working = stage { return }
            queue = []
            stage = .ask
            editor = nil
            return
        }
        guard isActive(), !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        var found: [Item] = []
        for box in await boxes() {
            clients[box.serverDomain] = box.client
            guard let r = try? await box.client.accessRequests() else { continue }
            // Drafts first, as the box lists them.
            found += r.drafts.map { Item(serverDomain: box.serverDomain, entry: .draft($0)) }
            found += r.requests.map { Item(serverDomain: box.serverDomain, entry: .host($0)) }
        }
        guard alertsEnabled() else { return }
        let known = Set(queue.map(\.id))
        let waiting = Set(found.map(\.id))
        // Requests answered elsewhere drop out, except the one on screen.
        queue = queue.filter { $0.id == current?.id || waiting.contains($0.id) }
        queue += found.filter { !known.contains($0.id) && !answered.contains($0.id) && !isSnoozed($0.id) }
    }

    private var snoozes: [String: Double] {
        get { defaults.dictionary(forKey: Self.snoozeKey) as? [String: Double] ?? [:] }
        set { defaults.set(newValue, forKey: Self.snoozeKey) }
    }

    private func isSnoozed(_ id: String) -> Bool {
        guard let until = snoozes[id] else { return false }
        return until > now().timeIntervalSince1970
    }

    private func snooze(_ id: String) {
        let t = now().timeIntervalSince1970
        var all = snoozes.filter { $0.value > t }
        all[id] = t + Self.notNowInterval
        snoozes = all
    }

    public func allow() async { await answer(.allow) }
    public func deny() async { await answer(.deny) }

    private func answer(_ action: AppAccessAction) async {
        guard let item = current, let request = item.request, let client = clients[item.serverDomain] else { return }
        if case .working = stage { return }
        stage = .working(action)
        do {
            _ = try await AppAccessOrder.answer(
                host: request.host, action: action, serviceId: request.serviceId,
                appName: request.appName, currentList: nil, client: client,
                fallbackServerDomain: item.serverDomain, signer: signer)
            stage = .done(action)
        } catch {
            stage = .failed(AppAccessCopy.message(for: error))
        }
    }

    /// Not now: the request stays on the box; this device asks again in a day.
    public func notNow() {
        guard let item = current else { return }
        snooze(item.id)
        next()
    }

    /// Close the confirmation (or a failure).
    public func close() {
        guard let item = current else { return }
        if case .ask = stage { snooze(item.id) } else { answered.insert(item.id) }
        next()
    }

    /// The current request's list, in the editor.
    public func viewAccessList() async {
        guard let item = current, let client = clients[item.serverDomain] else { return }
        let list = (try? await client.serviceAccess(serviceId: item.serviceId).list) ?? AppAccessList.defaultList
        let signer = self.signer
        editor = AppAccessEditorModel(appName: item.appName, initialList: list) { text in
            try await AppAccessOrder.send(
                list: text, serviceId: item.serviceId, client: client,
                fallbackServerDomain: item.serverDomain, signer: signer,
                reason: "Change \(item.appName)'s access list")
        }
    }

    /// Review a suggested list: that app's editor, prefilled with the draft.
    /// Save signs and sends it (which clears the draft on the box).
    public func reviewDraft() async {
        guard let item = current, item.draft != nil, let client = clients[item.serverDomain] else { return }
        if case .opening = stage { return }
        stage = .opening
        let draft: AppAccessDraft
        do {
            guard let d = try await client.serviceAccess(serviceId: item.serviceId).draft else {
                stage = .failed(AppAccessCopy.draftGone)
                return
            }
            draft = d
        } catch {
            stage = .failed(AppAccessCopy.message(for: error))
            return
        }
        guard current?.id == item.id else { return }
        stage = .ask
        let signer = self.signer
        editor = AppAccessEditorModel(appName: item.appName, initialList: draft.list,
                                      note: AppAccessCopy.draftEditorNote) { [weak self] text in
            let next = try await AppAccessOrder.send(
                list: text, serviceId: item.serviceId, client: client,
                fallbackServerDomain: item.serverDomain, signer: signer,
                reason: "Change \(item.appName)'s access list")
            if self?.current?.id == item.id { self?.stage = .saved }
            return next
        }
    }

    /// The editor closed. A draft's editor closed without saving goes back
    /// to its question; anything else closes the alert.
    public func editorClosed() {
        if current?.draft != nil, case .ask = stage, editor?.saved != true {
            editor = nil
            return
        }
        close()
    }

    /// The sheet for `id` went away. Swiped down: Not now while asking, Close
    /// after. Already moved on (Close / Not now / the next request): nothing.
    public func dismissed(id: String) {
        guard current?.id == id else { return }
        if case .working = stage { return }
        close()
    }

    private func next() {
        guard current != nil else { return }
        queue.removeFirst()
        stage = .ask
        editor = nil
    }
}
