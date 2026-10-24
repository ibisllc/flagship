import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// The words for app chats between owners (SECURITY-HARDENING-PLAN.md 17.6). The sender of an incoming
/// request is only a claim, never an identity, so it is always "a remote machine claiming to run …".
public enum ChatCopy {
    public static let sectionTitle = String(localized: "App chats")

    public static func ask(_ r: ChatRequest) -> String {
        if r.isIncoming {
            return String(localized: "A remote machine claiming to run \(r.claimedSender.label) wants to talk to your app \(r.receiverApp.slug).")
        }
        return String(localized: "Your app \(r.claimedSender.slug) wants to talk to \(r.receiverApp.label), an app on another owner's server.")
    }

    public static func phrase(_ p: String) -> String { String(localized: "Its note, written by the remote machine: “\(p)”") }

    public static func asked(_ n: Int) -> String? {
        n > 1 ? String(localized: "It has asked \(n) times.") : nil
    }

    public static func alwaysNote(_ r: ChatRequest) -> String {
        String(localized: "Always allow lets any remote machine reach \(r.receiverApp.slug) without asking. You can revoke it on this server's page.")
    }

    public static func answered(_ r: ChatRequest, decision: ChatApproval.Decision) -> String {
        switch (decision, r.isIncoming) {
        case (.deny, true): return String(localized: "Denied. Nothing from \(r.claimedSender.label) reaches \(r.receiverApp.slug).")
        case (.deny, false): return String(localized: "Denied. \(r.claimedSender.slug) won't talk to \(r.receiverApp.label).")
        case (.always, _): return String(localized: "\(r.receiverApp.slug) now takes chats from other owners' apps without asking.")
        case (.allow, true): return String(localized: "Allowed. \(r.claimedSender.label) can talk to \(r.receiverApp.slug).")
        case (.allow, false): return String(localized: "Allowed. \(r.claimedSender.slug) can talk to \(r.receiverApp.label).")
        }
    }

    public static func alwaysRow(_ app: ChatAppIdentity) -> String {
        String(localized: "\(app.slug) takes chats from other owners' apps without asking.")
    }

    public static func revoked(_ app: ChatAppIdentity) -> String {
        String(localized: "\(app.slug) asks you again from now on.")
    }

    public static func reason(_ r: ChatRequest) -> String {
        r.isIncoming ? String(localized: "Answer a chat request for \(r.receiverApp.slug)")
                     : String(localized: "Answer \(r.claimedSender.slug)'s chat request")
    }

    public static func message(for error: Error) -> String {
        if BiometricGate.GateError.from(error) == .userCancelled {
            return String(localized: "Nothing was answered.")
        }
        guard case let ScreensClientError.http(status, _) = error else { return ScreensClientError.userFacing(error) }
        let reason = ScreensClientError.boxReason(error)
        switch status {
        case 400 where reason == "stale answer":
            return String(localized: "Your phone's clock is too far off from the server's. Check the date and time, then try again.")
        case 403: return String(localized: "The server didn't accept your signature. Only an admin device of this account can answer.")
        case 404: return String(localized: "This request isn't waiting any more.")
        case 409: return String(localized: "This request was already answered.")
        default: return ScreensClientError.plainLanguage(forStatus: status)
        }
    }
}

/// Signs one `flagship/chat-approval/v1` answer with the sensitive-order key (one Face ID) and sends it.
public enum ChatAnswerOrder {
    public static func send(
        _ r: ChatRequest,
        decision: ChatApproval.Decision,
        client: any ScreensClient,
        fallbackServerDomain: String?,
        signer: AppAccessSigner,
        now: () -> Date = Date.init
    ) async throws {
        guard let domain = await client.boxDomain() ?? fallbackServerDomain,
              let kind = ChatApproval.Kind(rawValue: r.kind) else {
            throw ScreensClientError.http(status: 0, message: "")
        }
        let key = try await signer(ChatCopy.reason(r))
        let at = Int64(now().timeIntervalSince1970 * 1000)
        let approval = ChatApproval(serverDomain: domain, requestId: r.requestId, kind: kind, decision: decision, issuedAt: at)
        let sig = try key.signature(for: approval.canonicalBytes())
        try await client.chatAnswer(ChatAnswerRequest(requestId: r.requestId, kind: r.kind, decision: decision.rawValue,
                                                      issuedAt: at, signature: HexUtil.encode(sig)))
    }
}

/// App-wide "A remote machine claiming to run … wants to talk to …" sheets. A box raises a `chat-request`
/// frame on its screens socket and a content-free `generic` push; this asks every managed box for what
/// waits and shows one request at a time: Allow, Always allow (incoming only), Deny or Not now.
@Observable
@MainActor
public final class ChatRequestCenter {
    public struct Item: Identifiable, Equatable {
        public let serverDomain: String
        public let request: ChatRequest
        public var id: String { "\(serverDomain)|\(request.id)" }
    }

    public enum Stage: Equatable {
        case ask
        case working(ChatApproval.Decision)
        case done(ChatApproval.Decision)
        case failed(String)
    }

    public private(set) var queue: [Item] = []
    public private(set) var stage: Stage = .ask
    public var current: Item? { queue.first }

    private let boxes: @MainActor () async -> [AppAccessAlertCenter.Box]
    private let isActive: @MainActor () -> Bool
    private let alertsEnabled: @MainActor () -> Bool
    private let signer: AppAccessSigner
    private var clients: [String: any ScreensClient] = [:]
    /// Answered, or put off with Not now: not asked about again while the app runs.
    private var settled: Set<String> = []
    private var observers: [NSObjectProtocol] = []
    private var refreshing = false

    public init(boxes: @escaping @MainActor () async -> [AppAccessAlertCenter.Box],
                isActive: @escaping @MainActor () -> Bool = { true },
                alertsEnabled: @escaping @MainActor () -> Bool = { true },
                signer: AppAccessSigner? = nil) {
        self.boxes = boxes
        self.isActive = isActive
        self.alertsEnabled = alertsEnabled
        self.signer = signer ?? AppAccessOrder.defaultSigner
    }

    /// Refresh on a chat frame and on the content-free push, which is the same `generic` wake an access
    /// request sends.
    public func observeEvents() {
        guard observers.isEmpty else { return }
        for name in [ChatRequestEvents.requested, AppAccessEvents.requested] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in await self?.refresh() }
            })
        }
    }

    public func refresh() async {
        guard alertsEnabled() else {
            if case .working = stage { return }
            queue = []
            stage = .ask
            return
        }
        guard isActive(), !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        var found: [Item] = []
        for box in await boxes() {
            clients[box.serverDomain] = box.client
            guard let r = try? await box.client.chatRequests() else { continue }
            found += r.requests.map { Item(serverDomain: box.serverDomain, request: $0) }
        }
        let waiting = Set(found.map(\.id))
        let known = Set(queue.map(\.id))
        queue = queue.filter { $0.id == current?.id || waiting.contains($0.id) }
        queue += found.filter { !known.contains($0.id) && !settled.contains($0.id) }
    }

    public func allow() async { await answer(.allow) }
    public func alwaysAllow() async { await answer(.always) }
    public func deny() async { await answer(.deny) }

    private func answer(_ decision: ChatApproval.Decision) async {
        guard let item = current, let client = clients[item.serverDomain] else { return }
        if case .working = stage { return }
        if decision == .always && !item.request.isIncoming { return }
        stage = .working(decision)
        do {
            try await ChatAnswerOrder.send(item.request, decision: decision, client: client,
                                           fallbackServerDomain: item.serverDomain, signer: signer)
            stage = .done(decision)
        } catch {
            stage = .failed(ChatCopy.message(for: error))
        }
    }

    public func notNow() {
        guard current != nil else { return }
        next()
    }

    public func close() { next() }

    public func dismissed(id: String) {
        guard current?.id == id else { return }
        if case .working = stage { return }
        next()
    }

    private func next() {
        guard let item = current else { return }
        settled.insert(item.id)
        queue.removeFirst()
        stage = .ask
    }
}

/// One server's app chats, for its page: what waits, and the apps that take chats without asking.
@Observable
@MainActor
public final class ChatRequestsController {
    public private(set) var requests: [ChatRequest] = []
    public private(set) var always: [ChatAppIdentity] = []
    /// False until the box answered once (an older box has no chat screens: the card stays hidden).
    public private(set) var loaded = false
    public private(set) var busy: String?
    public private(set) var note: String?
    public private(set) var error: String?

    private let serverDomain: String
    private let client: any ScreensClient
    private let signer: AppAccessSigner

    public init(serverDomain: String, client: any ScreensClient, signer: AppAccessSigner? = nil) {
        self.serverDomain = serverDomain
        self.client = client
        self.signer = signer ?? AppAccessOrder.defaultSigner
    }

    public var isEmpty: Bool { requests.isEmpty && always.isEmpty }

    public func load() async {
        guard let r = try? await client.chatRequests() else { return }
        requests = r.requests
        always = r.always
        loaded = true
    }

    public func answer(_ r: ChatRequest, _ decision: ChatApproval.Decision) async {
        guard busy == nil else { return }
        busy = r.id
        error = nil
        note = nil
        defer { busy = nil }
        do {
            try await ChatAnswerOrder.send(r, decision: decision, client: client, fallbackServerDomain: serverDomain, signer: signer)
            note = ChatCopy.answered(r, decision: decision)
        } catch {
            self.error = ChatCopy.message(for: error)
        }
        await load()
    }

    /// Withdrawing an Always allow only narrows what is open, so it needs no signature.
    public func revoke(_ app: ChatAppIdentity) async {
        guard busy == nil else { return }
        busy = app.label
        error = nil
        note = nil
        defer { busy = nil }
        do {
            _ = try await client.chatRevokeAlways(app)
            note = ChatCopy.revoked(app)
        } catch {
            self.error = ChatCopy.message(for: error)
        }
        await load()
    }
}
