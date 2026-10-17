import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

// Where an app runs: choosing the server a new app is made on, a server's own
// list of apps, and an app page's "Runs on" (docs/app-placement.md §2–5).

public enum AppPlacementCopy {
    public static let runsOn = "Runs on"
    public static let runsOnSection = "Runs on"
    public static let runsOnNote = "Tick a server to copy this app there: its code, data and files as they are now. Each copy then runs on its own. Untick a server to remove the app from it."
    public static let runsOnReadOnly = "Only the account owner's phone can copy or remove apps."
    public static let pickerNote = "New apps go to your preferred server unless you pick another."
    public static let pinnedNote = "Made on this server."
    public static let serverAppsSection = "APPS"
    public static let noAppsHere = "No apps on this server yet."
    public static let createHere = "Create app here"
    public static let needsUpdate = "This server needs an update to receive copies."
    public static let unknown = "Can't reach this server right now"
    public static let notPaired = "This device isn't paired with this server"
    public static let checking = "Checking…"
    public static let noSource = "No server has a finished copy of this app to copy from."
    public static let adminOnlyRemove = AdminOrderGate.removeApp

    /// "Copying… 40%", "Installing…".
    public static func copying(state: String, progress: Double?) -> String {
        let word = state == "installing" ? "Installing…" : "Copying…"
        guard let pct = AppCopyProgress.percent(progress) else { return word }
        return "\(word) \(pct)%"
    }

    public static func lastCopy(_ app: String) -> String {
        "This is the only copy of \(app). To delete it, use Remove app."
    }

    public static func confirmRemoveTitle(_ app: String, _ server: String) -> String {
        "Remove \(app) from \(server)?"
    }

    public static func confirmRemoveMessage(_ server: String) -> String {
        "The app and its data on \(server) are deleted. The other copies keep running."
    }

    /// The box saw this exact signed order before: sign a fresh one.
    static func isUsedOrder(_ error: Error) -> Bool {
        guard case ScreensClientError.http(409, _) = error else { return false }
        return ScreensClientError.boxReason(error)?.contains("already used") == true
    }

    /// A copy landed but some env values couldn't come along.
    public static func pendingEnv(_ app: String, _ server: String, _ names: [String]) -> String {
        "\(app) is on \(server). Set \(names.count == 1 ? "this value" : "these values") there under Configure environment: \(names.joined(separator: ", "))."
    }

    public static func copyFailed(_ app: String, _ server: String, _ reason: String?) -> String {
        guard let reason, !reason.isEmpty else { return "Couldn't copy \(app) to \(server)." }
        return "Couldn't copy \(app) to \(server): \(reason)"
    }

    /// The target box's refusal of a copy, in plain words.
    public static func copyError(_ error: Error, app: String, server: String) -> String {
        if let e = error as? AppCopyOrder.Failure { return e.message }
        if case ScreensClientError.notImplemented = error { return needsUpdate }
        guard case let ScreensClientError.http(status, _) = error else {
            return ScreensClientError.userFacing(error)
        }
        let reason = ScreensClientError.boxReason(error)
        switch status {
        case 404:
            return needsUpdate
        case 409:
            return "\(app) is already on \(server), or a copy there is already underway."
        case 403:
            let r = reason?.lowercased() ?? ""
            if r.contains("stale") {
                return "Your phone's clock is too far off from the server's. Check the date and time, then try again."
            }
            if r.contains("different server") {
                return "This copy was signed for a different server. Reload the page and try again."
            }
            if r.contains("isn't one of this account's servers") {
                return "The server to copy from isn't one of your servers any more. Reload the page and try again."
            }
            if r.contains("companion") {
                return "Only the account owner's phone can copy apps."
            }
            return "\(server) didn't accept your signature. Only the account owner's phone can copy apps."
        case 400:
            return reason.map { "\(server) refused the copy: \($0)." } ?? "\(server) couldn't read the copy request."
        default:
            return ScreensClientError.plainLanguage(forStatus: status)
        }
    }

    /// A short display name for a server.
    static func serverName(_ pod: PodInfo) -> String {
        pod.name.isEmpty ? (pod.fqdn.split(separator: ".").first.map(String.init) ?? pod.fqdn) : pod.name
    }
}

/// Sign `flagship/app-copy/v1` with the sensitive-order key.
public enum AppCopyOrder {
    public struct Failure: Error, Equatable {
        public let message: String
    }

    public static func signed(sourceServer: String, targetServer: String, serviceId: String,
                              key: Curve25519.Signing.PrivateKey, issuedAt: Int64) throws -> AppCopyRequest {
        let grant = AppCopyGrant(sourceServer: sourceServer.lowercased(), targetServer: targetServer.lowercased(),
                                 serviceId: serviceId, issuedAt: issuedAt)
        let signature: Data
        do {
            signature = try key.signature(for: grant.canonicalBytes())
        } catch {
            throw Failure(message: "Couldn't sign the copy: \(error.localizedDescription)")
        }
        return AppCopyRequest(grant: grant, signature: HexUtil.encode(signature))
    }
}

// MARK: - Choosing where a new app runs (§2)

/// "Runs on: <server>" in the creation flow. Defaults to the leader (when it
/// is online); pinned to one server when the flow started from its page.
@Observable
@MainActor
public final class CreationTarget {
    public private(set) var choices: [PodInfo]
    public private(set) var pinnedFqdn: String?
    public private(set) var selectedFqdn: String?

    public init(pods: [PodInfo], leaderPodId: String?, pinnedFqdn: String? = nil) {
        let choices = Self.eligible(pods)
        self.choices = choices
        self.pinnedFqdn = pinnedFqdn?.lowercased()
        self.selectedFqdn = pinnedFqdn?.lowercased() ?? Self.defaultFqdn(choices: choices, leaderPodId: leaderPodId)
    }

    public var isPinned: Bool { pinnedFqdn != nil }
    public var showsPicker: Bool { !isPinned && choices.count > 1 }

    public var selected: PodInfo? {
        guard let selectedFqdn else { return nil }
        return choices.first(where: { $0.fqdn.lowercased() == selectedFqdn })
    }

    public var selectedName: String {
        if let selected { return AppPlacementCopy.serverName(selected) }
        return selectedFqdn?.split(separator: ".").first.map(String.init) ?? "No server"
    }

    public func select(_ pod: PodInfo) {
        guard !isPinned, choices.contains(where: { $0.podId == pod.podId }) else { return }
        selectedFqdn = pod.fqdn.lowercased()
    }

    /// The account's servers changed: keep a still-valid choice.
    public func refresh(pods: [PodInfo], leaderPodId: String?) {
        choices = Self.eligible(pods)
        guard !isPinned else { return }
        if selected == nil { selectedFqdn = Self.defaultFqdn(choices: choices, leaderPodId: leaderPodId) }
    }

    public static func eligible(_ pods: [PodInfo]) -> [PodInfo] {
        pods.filter { $0.status != .pending && !$0.isRevoked && !$0.fqdn.isEmpty }
    }

    /// The leader when it is online; else the first online server; else the
    /// leader; else the first.
    public static func defaultFqdn(choices: [PodInfo], leaderPodId: String?) -> String? {
        let leader = choices.first(where: { $0.podId == leaderPodId })
        if let leader, leader.status == .online { return leader.fqdn.lowercased() }
        if let online = choices.first(where: { $0.status == .online }) { return online.fqdn.lowercased() }
        return (leader ?? choices.first)?.fqdn.lowercased()
    }
}

// MARK: - A server's apps (§3)

@Observable
@MainActor
public final class ServerAppsController {
    public struct Row: Identifiable, Equatable, Sendable {
        public let serviceId: String
        public let name: String
        /// The app's address on this server (scheme stripped); nil while copying in.
        public let address: String?
        /// What this server says about the app (docs/app-placement.md §6).
        public let state: AppServerState
        public var running: Bool { state.isLive }
        /// Set while the app is still being copied onto this server.
        public let copying: AppCopying?
        public var id: String { serviceId }
        public var isCopying: Bool { copying != nil }
    }

    public let serverFqdn: String
    public private(set) var state: LoadingState<[Row]> = .idle
    /// A copy onto this server that failed while the page was open.
    public private(set) var failureNote: String?

    private let clients: PodScreensClientFactory
    private var client: (any ScreensClient)?
    private var apps: [AppSummary] = []
    private var copies: [AppCopyEntry] = []
    /// The box answers the copies list (an older box 404s it).
    private var copiesSupported = true

    public init(serverFqdn: String, clients: PodScreensClientFactory) {
        self.serverFqdn = serverFqdn.lowercased()
        self.clients = clients
    }

    public var rows: [Row] { state.value ?? [] }
    public var hasCopying: Bool { rows.contains(where: \.isCopying) }

    private func boundClient() async -> any ScreensClient {
        if let client { return client }
        let c = await clients.client(forFqdn: serverFqdn)
        client = c
        return c
    }

    public func load() async {
        if state.value == nil { state = .loading }
        let c = await boundClient()
        do {
            apps = try await c.appsList().apps
        } catch {
            if state.value == nil { state = .failed(ScreensClientError.userFacing(error)) }
            return
        }
        await fetchCopies(c)
        rebuild()
    }

    /// One poll of the copies list. A copy that finished reloads the apps.
    public func pollCopies() async {
        let c = await boundClient()
        let before = Set(copies.filter(\.isUnderway).map(\.copyId))
        await fetchCopies(c)
        for entry in copies where before.contains(entry.copyId) && entry.state == "failed" {
            failureNote = AppPlacementCopy.copyFailed(entry.appName, serverFqdn, entry.reason)
        }
        // The apps list carries `copying` too, and shows a finished copy.
        if let fresh = try? await c.appsList().apps { apps = fresh }
        rebuild()
    }

    /// Poll every `interval` while any copy is underway; ends when none is,
    /// or when the calling task is cancelled (the page went away).
    public func pollWhileCopying(interval: Duration = .seconds(3)) async {
        while hasCopying, !Task.isCancelled {
            try? await Task.sleep(for: interval)
            if Task.isCancelled { return }
            await pollCopies()
        }
    }

    private func fetchCopies(_ c: any ScreensClient) async {
        guard copiesSupported else { return }
        do {
            copies = try await c.serviceCopies().copies
        } catch ScreensClientError.http(404, _) {
            copiesSupported = false
            copies = []
        } catch ScreensClientError.notImplemented {
            copiesSupported = false
            copies = []
        } catch {
            // Keep the last answer; the next poll tries again.
        }
    }

    private func rebuild() {
        var underway: [String: AppCopyEntry] = [:]
        for entry in copies where entry.isUnderway {
            if let seen = underway[entry.serviceId], seen.startedAt >= entry.startedAt { continue }
            underway[entry.serviceId] = entry
        }
        var out: [Row] = apps.map { a in
            let fromList = a.copying.flatMap { Self.isUnderway($0.state) ? $0 : nil }
            let fromCopies = underway[a.serviceId].map { AppCopying(state: $0.state, progress: $0.progress) }
            let copying = fromCopies ?? fromList
            let name = copying != nil ? (a.name ?? a.slug.capitalized) : a.slug.capitalized
            return Row(serviceId: a.serviceId, name: name, address: Self.stripScheme(a.url),
                       state: copying != nil ? .copying : AppServerState(a), copying: copying)
        }
        let listed = Set(apps.map(\.serviceId))
        for entry in underway.values.sorted(by: { $0.startedAt < $1.startedAt }) where !listed.contains(entry.serviceId) {
            out.append(Row(serviceId: entry.serviceId, name: Self.displayName(entry), address: nil,
                           state: .copying, copying: AppCopying(state: entry.state, progress: entry.progress)))
        }
        state = .loaded(out)
    }

    nonisolated static func isUnderway(_ state: String) -> Bool { state != "done" && state != "failed" }

    private static func displayName(_ entry: AppCopyEntry) -> String {
        if entry.appName != entry.serviceId, !entry.appName.isEmpty { return entry.appName }
        return ServicesSlug.slug(of: entry.serviceId).capitalized
    }

    static func stripScheme(_ s: String) -> String {
        var out = s
        for p in ["https://", "http://"] where out.hasPrefix(p) { out = String(out.dropFirst(p.count)) }
        while out.hasSuffix("/") { out.removeLast() }
        return out
    }
}

/// The slug half of a `<creator>--<slug>` service id.
enum ServicesSlug {
    static func slug(of serviceId: String) -> String {
        serviceId.range(of: "--").map { String(serviceId[$0.upperBound...]) } ?? serviceId
    }
}

// MARK: - Runs on, honestly (§4)

@Observable
@MainActor
public final class AppRunsOnController {
    public enum Presence: Equatable, Sendable {
        case checking
        case installed
        case copying(state: String, progress: Double?)
        case absent
        /// The server couldn't say (unreachable, or no session): never ticked.
        case unknown(String)
    }

    public struct Row: Identifiable, Equatable, Sendable {
        public let pod: PodInfo
        public var presence: Presence
        /// That server's state of the app (docs/app-placement.md §6); nil
        /// unless it's installed there.
        public var state: AppServerState? = nil
        public var id: String { pod.podId }
        public var fqdn: String { pod.fqdn.lowercased() }
        public var name: String { AppPlacementCopy.serverName(pod) }
        /// Ticked = the server has the app (or is receiving it).
        public var isTicked: Bool {
            switch presence {
            case .installed, .copying: return true
            default: return false
            }
        }
        public var isCopying: Bool {
            if case .copying = presence { return true }
            return false
        }
    }

    public let serviceId: String
    public private(set) var appName: String
    public private(set) var rows: [Row]
    /// The last refusal or failure, for the line under the list.
    public private(set) var message: String?
    /// The server being copied to or removed from right now.
    public private(set) var busyFqdn: String?
    /// The app was removed from the server this page talks to.
    public private(set) var removedFromPage = false
    public let canChange: Bool
    /// Unticking (uninstalling) is an admin device's alone.
    public let canUninstall: Bool
    /// The line under the list when `canChange` is off.
    public let readOnlyNote: String

    private let pageFqdn: String
    private let clients: PodScreensClientFactory
    private let uninstallClient: any ServiceUninstallClient
    private let signer: AppAccessSigner
    private let irkSigner: AppAccessSigner
    private let now: () -> Date
    private var clientCache: [String: any ScreensClient] = [:]
    private var lastIssuedAt: Int64 = 0

    public init(serviceId: String, appName: String, pods: [PodInfo], pageFqdn: String,
                clients: PodScreensClientFactory, uninstallClient: any ServiceUninstallClient,
                canChange: Bool = true, canUninstall: Bool = true,
                readOnlyNote: String = AppPlacementCopy.runsOnReadOnly,
                signer: AppAccessSigner? = nil, irkSigner: AppAccessSigner? = nil,
                now: @escaping () -> Date = Date.init) {
        self.canUninstall = canUninstall
        self.readOnlyNote = readOnlyNote
        self.serviceId = serviceId
        self.appName = appName
        self.rows = CreationTarget.eligible(pods).map { Row(pod: $0, presence: .checking) }
        self.pageFqdn = pageFqdn.lowercased()
        self.clients = clients
        self.uninstallClient = uninstallClient
        self.canChange = canChange
        self.signer = signer ?? AppAccessOrder.defaultSigner
        self.irkSigner = irkSigner ?? AppAccessOrder.defaultSigner
        self.now = now
    }

    public func setAppName(_ name: String) { appName = name }

    public var installedCount: Int { rows.filter { $0.presence == .installed }.count }
    public var hasCopying: Bool { rows.contains(where: \.isCopying) }

    public func row(_ fqdn: String) -> Row? { rows.first(where: { $0.fqdn == fqdn.lowercased() }) }

    /// Ask every server for its apps list, all at once.
    public func load() async {
        var targets: [(String, any ScreensClient)] = []
        for row in rows { targets.append((row.fqdn, await client(row.fqdn))) }
        let serviceId = self.serviceId
        let answers = await withTaskGroup(of: (String, Probe).self) { group in
            for (fqdn, c) in targets {
                group.addTask { (fqdn, await Self.probe(of: serviceId, on: c)) }
            }
            var out: [String: Probe] = [:]
            for await (fqdn, p) in group { out[fqdn] = p }
            return out
        }
        for i in rows.indices {
            if let p = answers[rows[i].fqdn] {
                rows[i].presence = p.presence
                rows[i].state = p.state
            }
        }
    }

    /// One server's answer: whether it has the app, and its state there.
    struct Probe: Sendable {
        let presence: Presence
        var state: AppServerState? = nil
    }

    nonisolated static func probe(of serviceId: String, on client: any ScreensClient) async -> Probe {
        do {
            let apps = try await client.appsList().apps
            guard let app = apps.first(where: { $0.serviceId == serviceId }) else { return Probe(presence: .absent) }
            if let cp = app.copying, ServerAppsController.isUnderway(cp.state) {
                return Probe(presence: .copying(state: cp.state, progress: cp.progress))
            }
            return Probe(presence: .installed, state: AppServerState(app))
        } catch ScreensClientError.noSessionToken {
            return Probe(presence: .unknown(AppPlacementCopy.notPaired))
        } catch ScreensClientError.notPaired {
            return Probe(presence: .unknown(AppPlacementCopy.notPaired))
        } catch {
            return Probe(presence: .unknown(AppPlacementCopy.unknown))
        }
    }

    /// Why a server can't be unticked here, or nil.
    public func untickRefusal(_ fqdn: String) -> String? {
        guard let row = row(fqdn), row.presence == .installed else { return nil }
        if !canUninstall { return AppPlacementCopy.adminOnlyRemove }
        return installedCount <= 1 ? AppPlacementCopy.lastCopy(appName) : nil
    }

    /// Tick: copy the app onto `fqdn` (Face ID → signed order → the target).
    @discardableResult
    public func tick(_ fqdn: String) async -> Bool {
        guard canChange, busyFqdn == nil, let target = row(fqdn), target.presence == .absent else { return false }
        guard let source = sourceFqdn() else {
            message = AppPlacementCopy.noSource
            return false
        }
        busyFqdn = target.fqdn
        defer { busyFqdn = nil }
        message = nil
        do {
            let key: Curve25519.Signing.PrivateKey
            do {
                key = try await signer("Copy \(appName) to \(target.name)")
            } catch {
                throw AppCopyOrder.Failure(message: "Couldn't access your account key: \(error.localizedDescription)")
            }
            let boxClient = await client(target.fqdn)
            do {
                _ = try await boxClient.serviceCopy(
                    AppCopyOrder.signed(sourceServer: source, targetServer: target.fqdn, serviceId: serviceId,
                                        key: key, issuedAt: nextIssuedAt()))
            } catch where AppPlacementCopy.isUsedOrder(error) {
                _ = try await boxClient.serviceCopy(
                    AppCopyOrder.signed(sourceServer: source, targetServer: target.fqdn, serviceId: serviceId,
                                        key: key, issuedAt: nextIssuedAt()))
            }
            set(target.fqdn, .copying(state: "copying", progress: 0))
            return true
        } catch {
            message = AppPlacementCopy.copyError(error, app: appName, server: target.name)
            return false
        }
    }

    /// Untick: the signed uninstall to that server. The caller confirms first.
    @discardableResult
    public func untick(_ fqdn: String) async -> Bool {
        guard canChange, busyFqdn == nil, let target = row(fqdn), target.presence == .installed else { return false }
        if let refusal = untickRefusal(fqdn) {
            message = refusal
            return false
        }
        guard let delim = serviceId.range(of: "--") else {
            message = "Couldn't identify the app to remove."
            return false
        }
        let creator = String(serviceId[..<delim.lowerBound])
        let slug = String(serviceId[delim.upperBound...])
        busyFqdn = target.fqdn
        defer { busyFqdn = nil }
        message = nil
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await irkSigner("Remove \(appName) from \(target.name)")
        } catch {
            message = "Couldn't access your account key: \(error.localizedDescription)"
            return false
        }
        let order = UninstallServiceOrder(serverId: target.fqdn, creator: creator, slug: slug,
                                          issuedAt: nextIssuedAt())
        do {
            let env = order.envelope(signatureHex: HexUtil.encode(try order.sign(with: key)))
            try await uninstallClient.uninstallService(
                serverDomain: target.fqdn, serviceId: serviceId,
                request: env["request"] as! [String: Any], signatureHex: env["signature"] as! String)
        } catch let e as ScreensClientError {
            message = e.errorDescription ?? "That didn't work. Try again in a moment."
            return false
        } catch {
            message = "Couldn't reach \(target.name). Check your connection and try again."
            return false
        }
        set(target.fqdn, .absent)
        if target.fqdn == pageFqdn { removedFromPage = true }
        return true
    }

    /// One poll of each receiving server's copies list.
    public func pollCopies() async {
        for row in rows where row.isCopying {
            let c = await client(row.fqdn)
            let entry: AppCopyEntry?
            do {
                entry = try await c.serviceCopies().copies
                    .filter { $0.serviceId == serviceId }
                    .max(by: { $0.startedAt < $1.startedAt })
            } catch {
                set(row.fqdn, await Self.probe(of: serviceId, on: c))
                continue
            }
            guard let entry else {
                set(row.fqdn, await Self.probe(of: serviceId, on: c))
                continue
            }
            switch entry.state {
            case "done":
                set(row.fqdn, await Self.probe(of: serviceId, on: c))
                if !entry.pendingEnv.isEmpty {
                    message = AppPlacementCopy.pendingEnv(appName, row.name, entry.pendingEnv)
                }
            case "failed":
                set(row.fqdn, .absent)
                message = AppPlacementCopy.copyFailed(appName, row.name, entry.reason)
            default:
                set(row.fqdn, .copying(state: entry.state, progress: entry.progress))
            }
        }
    }

    public func pollWhileCopying(interval: Duration = .seconds(3)) async {
        while hasCopying, !Task.isCancelled {
            try? await Task.sleep(for: interval)
            if Task.isCancelled { return }
            await pollCopies()
        }
    }

    /// Copy from the page's own server when it has a finished copy, else the
    /// first server that does.
    private func sourceFqdn() -> String? {
        if row(pageFqdn)?.presence == .installed { return pageFqdn }
        return rows.first(where: { $0.presence == .installed })?.fqdn
    }

    private func set(_ fqdn: String, _ presence: Presence) {
        set(fqdn, Probe(presence: presence))
    }

    private func set(_ fqdn: String, _ probe: Probe) {
        guard let i = rows.firstIndex(where: { $0.fqdn == fqdn }) else { return }
        rows[i].presence = probe.presence
        rows[i].state = probe.state
    }

    private func client(_ fqdn: String) async -> any ScreensClient {
        if let c = clientCache[fqdn] { return c }
        let c = await clients.client(forFqdn: fqdn)
        clientCache[fqdn] = c
        return c
    }

    /// Unix ms, strictly after the last order this page signed.
    private func nextIssuedAt() -> Int64 {
        let t = max(Int64(now().timeIntervalSince1970 * 1000), lastIssuedAt + 1)
        lastIssuedAt = t
        return t
    }
}
