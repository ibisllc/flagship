import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// The words for an app's request to use the server's browser beyond its manifest (SEC-BROWSER-002).
/// Said from the box's structured fields, never from its English `meaning` lines.
public enum BrowserGrantCopy {
    public static let title = String(localized: "Browser access request")
    public static let sectionTitle = String(localized: "Browser access")
    public static let sites = String(localized: "Sites")
    public static let canHeader = String(localized: "It can:")
    public static let appSays = String(localized: "The app says:")
    public static let approvedAtInstall = String(localized: "Approved when you installed it")
    public static let denyNote = String(localized: "If you deny, the app has to wait before asking again.")
    public static let deny = String(localized: "Deny")

    public static func ask(app: String) -> String {
        String(localized: "\(app) wants to use this server's browser.")
    }

    /// A `*.example.com` pattern reaches every address under it; say so beside the exact pattern.
    public static func originNote(_ origin: String) -> String? {
        origin.hasPrefix("*.") ? String(localized: "and every address under it") : nil
    }

    public static func localNetwork(_ l: BrowserGrantLocalNetworkWire?) -> String? {
        switch l {
        case .none: return nil
        case .wholeLan?: return String(localized: "Every device on your local network")
        case .exact(let hosts)?:
            return String(localized: "These devices on your network: \(hosts.joined(separator: ", "))")
        }
    }

    public static func capability(_ c: String) -> String {
        switch c {
        case "navigate": return String(localized: "Open pages")
        case "read-dom": return String(localized: "Read page content")
        case "screenshot": return String(localized: "Take screenshots")
        case "input": return String(localized: "Type and click")
        case "download": return String(localized: "Download files")
        default: return c
        }
    }

    public static func duration(_ d: String) -> String {
        switch d {
        case "once": return String(localized: "For one visit")
        case "session": return String(localized: "Until this browser session ends")
        default: return String(localized: "Until you remove it")
        }
    }

    /// An Allow button names what the box will grant: the ask's duration or a shorter one the owner chose.
    public static func allow(_ d: String) -> String {
        switch d {
        case "once": return String(localized: "Allow once")
        case "session": return String(localized: "Allow for this session")
        default: return String(localized: "Always allow")
        }
    }

    public static func explanation(_ text: String) -> String { "“\(text)”" }

    /// Says what was granted: the owner may have chosen a shorter duration than the app asked for.
    public static func answered(app: String, allowed: Bool, duration: String) -> String {
        guard allowed else { return String(localized: "Denied. \(app) can't use the browser for this.") }
        switch duration {
        case "once": return String(localized: "Allowed. \(app) can use the browser for one visit.")
        case "session": return String(localized: "Allowed. \(app) can use the browser until this browser session ends.")
        default: return String(localized: "Allowed. \(app) can use the browser until you remove it.")
        }
    }

    public static func reason(app: String) -> String {
        String(localized: "Allow \(app) to use the browser")
    }

    // "Allowed by you": the grants the owner gave, each with Withdraw.
    public static let allowedByYou = String(localized: "Allowed by you")
    public static let withdraw = String(localized: "Withdraw")
    public static let withdrawn = String(localized: "Browser access withdrawn")
    public static let alreadyWithdrawn = String(localized: "That access was already withdrawn.")

    public static func withdrawReason(app: String) -> String {
        String(localized: "Withdraw \(app)'s browser access")
    }

    public static func withdrawMessage(for error: Error) -> String {
        if case ScreensClientError.http(404, _) = error { return alreadyWithdrawn }
        return message(for: error)
    }

    public static func message(for error: Error) -> String {
        if BiometricGate.GateError.from(error) == .userCancelled {
            return String(localized: "Nothing was answered.")
        }
        guard case let ScreensClientError.http(status, _) = error else { return ScreensClientError.userFacing(error) }
        switch status {
        case 403: return String(localized: "This device can't approve browser access. Use an admin device.")
        case 404: return String(localized: "That request is no longer waiting.")
        case 400 where ScreensClientError.boxReason(error) == "a signed answer with a current time is required":
            return String(localized: "Your phone's clock is too far off from the server's. Check the date and time, then try again.")
        default: return ScreensClientError.plainLanguage(forStatus: status)
        }
    }

    /// The app's verified name from the box's own list, else its id.
    public static func appName(_ serviceId: String, in apps: [AppSummary]) -> String {
        guard let a = apps.first(where: { $0.serviceId == serviceId }) else { return serviceId }
        if let n = a.name, !n.isEmpty { return n }
        return a.slug
    }
}

/// Signs one `flagship/browser-grant/v1` allow (one Face ID) for the duration the owner chose (the
/// asked one or shorter), or sends a denial, which needs no signature.
public enum BrowserGrantAnswerOrder {
    public static func send(
        _ r: BrowserGrantRequest,
        allow: Bool,
        duration: String? = nil,
        appName: String,
        client: any ScreensClient,
        fallbackServerDomain: String?,
        signer: AppAccessSigner,
        now: () -> Date = Date.init
    ) async throws {
        let at = Int64(now().timeIntervalSince1970 * 1000)
        guard allow else {
            try await client.browserGrantAnswer(BrowserGrantAnswerRequest(requestId: r.requestId, decision: "deny", issuedAt: at))
            return
        }
        guard let domain = await client.boxDomain() ?? fallbackServerDomain else {
            throw ScreensClientError.http(status: 0, message: "")
        }
        let granted = duration ?? r.duration
        // Never sign more than was asked: the box refuses it anyway.
        guard BrowserGrantAnswer.within(ask: BrowserGrantOrder.scope(of: r), answer: BrowserGrantOrder.scope(of: r, duration: granted)) else {
            throw ScreensClientError.http(status: 400, message: #"{"error":"an answer can grant the request or less, never more"}"#)
        }
        let key = try await signer(BrowserGrantCopy.reason(app: appName))
        let order = BrowserGrantOrder.answer(for: r, serverDomain: domain, decision: "allow", duration: granted, issuedAt: at)
        let sig = try key.signature(for: order.canonicalBytes())
        try await client.browserGrantAnswer(BrowserGrantAnswerRequest(requestId: r.requestId, decision: "allow",
                                                                      issuedAt: at, signature: HexUtil.encode(sig),
                                                                      duration: granted))
    }
}

/// Signs one `flagship/browser-grant-revoke/v1` (one Face ID): the box drops the grant at once.
public enum BrowserGrantRevokeOrder {
    public static func send(
        _ g: OwnerBrowserGrant,
        appName: String,
        client: any ScreensClient,
        fallbackServerDomain: String?,
        signer: AppAccessSigner,
        now: () -> Date = Date.init
    ) async throws {
        guard let domain = await client.boxDomain() ?? fallbackServerDomain else {
            throw ScreensClientError.http(status: 0, message: "")
        }
        let at = Int64(now().timeIntervalSince1970 * 1000)
        let key = try await signer(BrowserGrantCopy.withdrawReason(app: appName))
        let order = BrowserGrantRevoke(serverDomain: domain, serviceId: g.serviceId, grantId: g.grantId, issuedAt: at)
        let sig = try key.signature(for: order.canonicalBytes())
        try await client.browserGrantRevoke(BrowserGrantRevokeRequest(serviceId: g.serviceId, grantId: g.grantId,
                                                                      issuedAt: at, signature: HexUtil.encode(sig)))
    }
}

/// App-wide "Browser access request" sheets, in the same inbox as access and chat requests: asks every
/// managed box what waits on the same wakes and shows one request at a time.
@Observable
@MainActor
public final class BrowserGrantCenter {
    public struct Item: Identifiable, Equatable {
        public let serverDomain: String
        public let request: BrowserGrantRequest
        public let appName: String
        public var id: String { "\(serverDomain)|\(request.requestId)" }
    }

    public enum Stage: Equatable {
        case ask
        case working(allow: Bool)
        /// `duration` is what the box granted: the ask's own, or the shorter one the owner chose.
        case done(allow: Bool, duration: String)
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

    /// Refresh on the box's own `browser-grant-request` frame, and on the inbox's other wakes (the
    /// content-free `generic` push is the same one an access request sends).
    public func observeEvents() {
        guard observers.isEmpty else { return }
        for name in [BrowserGrantEvents.requested, ChatRequestEvents.requested, AppAccessEvents.requested] {
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
            guard let r = try? await box.client.browserGrantRequests(), !r.requests.isEmpty else { continue }
            let apps = (try? await box.client.appsList().apps) ?? []
            found += r.requests.map { Item(serverDomain: box.serverDomain, request: $0,
                                           appName: BrowserGrantCopy.appName($0.serviceId, in: apps)) }
        }
        let waiting = Set(found.map(\.id))
        let known = Set(queue.map(\.id))
        queue = queue.filter { $0.id == current?.id || waiting.contains($0.id) }
        queue += found.filter { !known.contains($0.id) && !settled.contains($0.id) }
    }

    /// `duration` nil = the ask's own; otherwise a shorter one the owner chose.
    public func allow(duration: String? = nil) async { await answer(allow: true, duration: duration) }
    public func deny() async { await answer(allow: false, duration: nil) }

    private func answer(allow: Bool, duration: String?) async {
        guard let item = current, let client = clients[item.serverDomain] else { return }
        if case .working = stage { return }
        stage = .working(allow: allow)
        do {
            try await BrowserGrantAnswerOrder.send(item.request, allow: allow, duration: duration, appName: item.appName,
                                                   client: client, fallbackServerDomain: item.serverDomain, signer: signer)
            stage = .done(allow: allow, duration: duration ?? item.request.duration)
        } catch {
            stage = .failed(BrowserGrantCopy.message(for: error))
        }
    }

    public func notNow() { next() }
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

/// One app's browser access, for its page: what its manifest was approved for, what it asks now, and
/// what the owner allowed beyond the manifest (each with Withdraw).
@Observable
@MainActor
public final class BrowserGrantsController {
    public private(set) var requests: [BrowserGrantRequest] = []
    public private(set) var grants: [OwnerBrowserGrant] = []
    public private(set) var busy: String?
    public private(set) var note: String?
    public private(set) var error: String?

    public let serviceId: String
    public let appName: String
    private let serverDomain: String?
    private let client: any ScreensClient
    private let signer: AppAccessSigner

    public init(serviceId: String, appName: String, serverDomain: String?, client: any ScreensClient, signer: AppAccessSigner? = nil) {
        self.serviceId = serviceId
        self.appName = appName
        self.serverDomain = serverDomain
        self.client = client
        self.signer = signer ?? AppAccessOrder.defaultSigner
    }

    public func load() async {
        if let r = try? await client.browserGrantRequests() {
            requests = r.requests.filter { $0.serviceId == serviceId }
        }
        if let g = try? await client.browserGrants(serviceId: serviceId) {
            grants = g.grants.filter { $0.serviceId == serviceId }
        }
    }

    /// `duration` nil = the ask's own; otherwise a shorter one the owner chose.
    public func answer(_ r: BrowserGrantRequest, allow: Bool, duration: String? = nil) async {
        guard busy == nil else { return }
        busy = r.requestId
        error = nil
        note = nil
        defer { busy = nil }
        do {
            try await BrowserGrantAnswerOrder.send(r, allow: allow, duration: duration, appName: appName, client: client,
                                                   fallbackServerDomain: serverDomain, signer: signer)
            note = BrowserGrantCopy.answered(app: appName, allowed: allow, duration: duration ?? r.duration)
        } catch {
            self.error = BrowserGrantCopy.message(for: error)
        }
        await load()
    }

    /// Withdraw one grant the owner gave (signed, one Face ID); the box drops it at once.
    public func withdraw(_ g: OwnerBrowserGrant) async {
        guard busy == nil else { return }
        busy = g.grantId
        error = nil
        note = nil
        defer { busy = nil }
        do {
            try await BrowserGrantRevokeOrder.send(g, appName: appName, client: client,
                                                   fallbackServerDomain: serverDomain, signer: signer)
            note = BrowserGrantCopy.withdrawn
        } catch {
            self.error = BrowserGrantCopy.withdrawMessage(for: error)
        }
        await load()
    }
}
