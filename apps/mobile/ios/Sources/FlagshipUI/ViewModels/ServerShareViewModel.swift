import Foundation
import Observation
import CryptoKit
import UIKit
import UserNotifications
import Flagship
import FlagshipAPI
import FlagshipCore

// Share this server (docs/share-a-server.md): the owner's "Shared with" card,
// the second account's "Shared with me" list, accept flow and server page.
// The protocol work lives in FlagshipCore (`ServerShareOwnerFlow`,
// `ServerShareMemberFlow`); this file binds it to the Keystore, the
// box-pinned session and the screens.

public enum ServerShareCopy {
    public static let sectionTitle = "SHARED WITH"
    public static let shareButton = "Share this server"
    public static let nobodyYet = "Only you can use this server. Share it to let another person see it or help run it."

    public static func levelName(_ l: ServerShareLevel) -> String { l == .view ? "Can view" : "Can manage" }
    public static func levelLine(_ l: ServerShareLevel) -> String {
        l == .view
            ? "Sees the server's status, monitoring and apps."
            : "Also builds apps with AI, accepts app updates, updates the server and changes apps' internet access."
    }

    public static let unlockTitle = "Approve start-ups"
    public static let unlockLine = "Their phone can unlock this server when it starts. That gives them a copy of its disk key."
    public static let unlockHouseKey = "Only give this to someone you'd give a house key. Ending the share deletes their copy, but they could have kept one."
    public static let dataTitle = "See app data"
    public static let dataLine = "They can read your apps' databases, and change data if they can manage."

    public static let notifyTitle = "Notify this device when it needs to start"
    public static let notifyNote = "Turning this on lets Flagship's service know this device helps with this server, so it can wake you. The notice itself names no server."
    /// The box counts an active share as a co-manager, at Manager rank in
    /// every app (AGENTS.md "Three ranks"), so no invite is needed.
    public static let membersOnlyHint = "Members only. As a co-manager you can open it."

    public static func updateButton(_ r: ReleaseEntry) -> String {
        "Update to \(r.tag.isEmpty ? String(r.commit.prefix(8)) : r.tag)"
    }
    public static func updateConfirm(_ name: String) -> String {
        "\(name) restarts on the new release. Only releases Flagship's maintainers endorsed will install."
    }
    public static func updating(_ name: String) -> String { "Updating \(name). It restarts in a few minutes." }

    public static func awaitingConfirm(_ label: String) -> String { "\(label) accepted. Does their phone show this code?" }
    public static func offered(_ label: String) -> String { "Waiting for \(label) to open the link" }
    public static let acceptanceInvalid = "This invitation's answer doesn't check out. Cancel it and share again."
    public static let startupKeyMissing = "Start-up approval isn't set up for them yet."
    public static let showInvitations = "Show invitations waiting for an answer"

    public static func activityLine(_ e: ShareActivityEntry) -> String {
        let who = e.actor.kind == "share" ? (e.actor.label ?? "Someone") : "You"
        let what: String
        switch e.action {
        case "share.signed-in": what = "opened the server"
        case "share.granted": what = "shared the server" + (e.target.map { " with \($0)" } ?? "")
        case "share.changed": what = "changed access" + (e.target.map { " for \($0)" } ?? "")
        case "share.revoked": what = "stopped sharing" + (e.target.map { " with \($0)" } ?? "")
        case "share.left": what = "left the server"
        case "ai.start": what = "started building an app with AI"
        case "ai.reply": what = "answered the AI builder"
        case "app.access.edit": what = "changed an app's internet access"
        case "app.access.dismiss": what = "ignored an app's internet request"
        case "app.update.accept": what = "accepted an app update"
        case "db.write": what = "changed app data"
        case "db.read": what = "read app data"
        case "server.update": what = "updated the server"
        default: what = e.action.replacingOccurrences(of: ".", with: " ")
        }
        return "\(who) · \(what)" + (e.ok ? "" : " (refused)")
    }

    public static func message(for error: Error) -> String {
        if let e = error as? ServerShareFlowError { return e.errorDescription ?? "Something went wrong." }
        if let e = error as? ShareUpdateRefusal { return e.message }
        if let e = error as? ServerShareHTTPError {
            switch e.status {
            case 0: return "Couldn't reach the server. Check your connection and try again."
            case 401: return "Your connection to this server expired. Open the server's page again."
            case 403 where e.error == "owner-only": return "Only the server's owner can do that."
            case 403: return "The server didn't accept your signature."
            case 404: return "That's gone. Pull to refresh."
            case 409: return "Something newer is already on file. Pull to refresh and try again."
            case 410: return "This share has ended."
            default: return ScreensClientError.plainLanguage(forStatus: e.status)
            }
        }
        if (error as NSError).domain == NSURLErrorDomain {
            return "Couldn't reach the server. Check your connection and try again."
        }
        return ScreensClientError.userFacing(error)
    }
}

/// Smoke-mode fixtures (`-smoke-mode -smoke-shares`): the share screens
/// render these with no backend, for screenshots and the gym.
/// `-smoke-share-route owner|sheet|accept|home|member` opens one screen.
public enum ServerShareDemo {
    private static var args: [String] { ProcessInfo.processInfo.arguments }

    public static var isOn: Bool { args.contains("-smoke-mode") && args.contains("-smoke-shares") }

    /// Gym-only (`-smoke-share-flows`): the transport the share flows run
    /// over instead of the network (GymShareTransport), so a smoke launch
    /// signs and sends real orders that the gym's mocks verify.
    public nonisolated(unsafe) static var gymTransport: (any ServerShareTransport)?
    /// The demo screens run the real flows (over `gymTransport`).
    public static var flowsOn: Bool { isOn && gymTransport != nil }
    /// The push token a smoke launch registers (no APNs on a simulator run).
    public static let gymPushToken = String(repeating: "9a", count: 32)

    public static var route: String? {
        guard isOn, let i = args.firstIndex(of: "-smoke-share-route"), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    /// Where Home opens for `-smoke-share-route`.
    public static func initialRoute(pods: [PodInfo]) -> HomeRoute? {
        switch route {
        case "owner", "sheet":
            return pods.first(where: { $0.status == .online }).map { .serverDetail(podId: $0.podId) }
        case "accept":
            return .acceptShare(shareId: nil, secretHex: nil)
        case "member":
            return entries().first.map { .sharedServer(shareId: $0.shareId) }
        default:
            return nil
        }
    }

    static let secretHex = String(repeating: "5e", count: 32)
    static let link = "https://flagshipserver.com/share#s=\(String(repeating: "ab", count: 16))&k=\(secretHex)"
    static let memberPub = String(repeating: "7c", count: 32)

    static func ownerRows(now: Int64 = ServerShareClock.nowMs()) -> [OwnerShareRow] {
        [
            OwnerShareRow(shareId: String(repeating: "a1", count: 16), label: "Alex", level: .view,
                          unlockAtBoot: false, seeAppData: false, status: .awaitingConfirm(sas: "482 913"),
                          memberPubHex: memberPub),
            OwnerShareRow(shareId: String(repeating: "b2", count: 16), label: "Sam", level: .manage,
                          unlockAtBoot: true, seeAppData: false, status: .active, memberPubHex: memberPub,
                          grantIssuedAt: now - 86_400_000 * 3, lastSeenAt: now - 3_600_000 * 2, startupKeyOnFile: true),
        ]
    }

    static func activity(now: Int64 = ServerShareClock.nowMs()) -> [ShareActivityEntry] {
        let sam = ShareActivityEntry.Actor(kind: "share", shareId: String(repeating: "b2", count: 16), label: "Sam")
        return [
            ShareActivityEntry(ts: now - 3_600_000 * 2, actor: sam, action: "app.access.edit", target: "bright-maple--plants"),
            ShareActivityEntry(ts: now - 3_600_000 * 2 - 60_000, actor: sam, action: "share.signed-in"),
            ShareActivityEntry(ts: now - 86_400_000 * 3, actor: .init(kind: "owner"), action: "share.granted", target: "Sam"),
        ]
    }

    static func entries() -> [SharedServerEntry] {
        [
            SharedServerEntry(entryId: String(repeating: "c3", count: 16), shareId: String(repeating: "d4", count: 16),
                              secretHex: secretHex, serverDomain: "garage.jordan-reyes.flagship.services",
                              serverName: "Garage", acceptedAt: 1),
            SharedServerEntry(entryId: String(repeating: "e5", count: 16), shareId: String(repeating: "f6", count: 16),
                              secretHex: secretHex, serverDomain: "photos.mina-park.flagship.services",
                              serverName: "Photos", acceptedAt: 0),
        ]
    }

    static func sessions() -> [String: ShareSessionResponse] {
        [
            String(repeating: "d4", count: 16): ShareSessionResponse(token: "fss_demo", expiresAt: Int64.max / 2, level: .manage,
                                                                     unlockAtBoot: true, seeAppData: true),
            String(repeating: "f6", count: 16): ShareSessionResponse(token: "fss_demo", expiresAt: Int64.max / 2, level: .view,
                                                                     unlockAtBoot: false, seeAppData: false),
        ]
    }

    static let invitation = ShareInvitation(
        shareId: String(repeating: "ab", count: 16), secretHex: secretHex,
        offer: ShareOfferPayload(serverDomain: "cabin.jordan-reyes.flagship.services", serverName: "Cabin",
                                 stkPubHex: memberPub, level: .view, unlockAtBoot: false, seeAppData: false,
                                 expiresAt: Int64.max / 2),
        state: "offered")

    static var startup: VerifiedShareStartup {
        VerifiedShareStartup(request: SecretRequest(serverDomain: "garage.jordan-reyes.flagship.services",
                                                    stkPub: Data(repeating: 7, count: 32), purpose: .unlockKey,
                                                    nonce: Data(repeating: 9, count: 32), issuedAt: 1),
                             expiresAt: nil)
    }
}

/// Sends over the network, or, in a smoke launch with the gym's share flows
/// (`ServerShareDemo.gymTransport`), to the gym's transport.
struct GymRoutedShareTransport: ServerShareTransport {
    let live: any ServerShareTransport

    func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
        if let gym = ServerShareDemo.gymTransport { return try await gym.send(request) }
        return try await live.send(request)
    }
}

/// The live clients and Keystore-backed keys.
public enum ServerShareServices {
    /// The box rides the same pinning as the screens client: a share token
    /// never goes to a box whose certificate doesn't match its pin.
    public static let pinnedSession: URLSession = BoxPinnedURLSession.make(
        pinFor: { CertPinRegistry.shared.pinFor(host: $0) }
    )

    public static let client = ServerShareClient(
        com: GymRoutedShareTransport(live: URLSessionShareTransport()),
        box: GymRoutedShareTransport(live: URLSessionShareTransport(session: pinnedSession))
    )

    public static func ownerKeys() -> ShareOwnerKeys {
        ShareOwnerKeys(
            sensitive: { reason in try await Keystore.sensitiveOrderSigningKey(reason: reason) },
            account: { try await Keystore.deriveIRK(reason: "Check who answered your invitations") },
            household: { try await Keystore.deriveHouseholdKey(reason: "Check who answered your invitations") },
            diskKeySeeds: { domain in
                let k = try await Keystore.deriveApprovalKeys(serverId: domain, reason: "Open the server's start-up key")
                return [k.bak.rawRepresentation, k.irk.rawRepresentation]
            }
        )
    }

    public static let umkSeed: @Sendable (String) async throws -> Data = { reason in
        let umk = try await Keystore.currentUMK(reason: reason)
        return umk.withUnsafeBytes { Data($0) }
    }

    /// This device's APNs token as hex, asking for notification permission
    /// and a token when the app has none yet.
    @MainActor
    public static func apnsTokenHex() async throws -> String {
        if let t = PushNotifications.latestTokenHex { return t }
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        guard granted else { throw ServerShareFlowError.noPushPermission }
        UIApplication.shared.registerForRemoteNotifications()
        for _ in 0..<40 {
            try await Task.sleep(for: .milliseconds(250))
            if let t = PushNotifications.latestTokenHex { return t }
        }
        throw ServerShareFlowError.noPushToken
    }

    /// True when this session already unlocked the account key, so reading
    /// it fires no Face ID.
    public static func keysUnlocked() -> Bool { Keystore.hasSessionKey() }

    /// A screens client for a shared server, signed in with the share token.
    public static func memberScreensClient(serverDomain: String, token: String) -> any ScreensClient {
        LiveScreensClient(
            urlSession: pinnedSession,
            store: PodScopedSessionStore(baseUrl: CompanionTicketURL.podBaseUrl(forFqdn: serverDomain), token: token)
        )
    }
}

// MARK: - Owner: the "Shared with" card

@Observable
@MainActor
public final class ShareServerCardModel {
    public let serverDomain: String
    public var serverName: String
    public var stkPubHex: String
    public private(set) var state: LoadingState<OwnerSharesSnapshot> = .idle
    /// The share id (or "create") an action is running for.
    public private(set) var busy: String?
    public var errorMessage: String?
    public var notice: String?
    public private(set) var activity: LoadingState<[ShareActivityEntry]> = .idle

    private let flow: ServerShareOwnerFlow?
    private let ownerToken: @MainActor () async -> String?
    private let keysUnlocked: @MainActor () -> Bool
    private let demo: Bool

    public init(serverDomain: String, serverName: String, stkPubHex: String, flow: ServerShareOwnerFlow?,
                ownerToken: @escaping @MainActor () async -> String?,
                keysUnlocked: @escaping @MainActor () -> Bool = { ServerShareServices.keysUnlocked() },
                demo: Bool = false) {
        self.serverDomain = serverDomain.lowercased()
        self.serverName = serverName
        self.stkPubHex = stkPubHex
        self.flow = flow
        self.ownerToken = ownerToken
        self.keysUnlocked = keysUnlocked
        self.demo = demo
    }

    public var rows: [OwnerShareRow] { state.value?.rows ?? [] }
    public var invitationsRead: Bool { state.value?.invitationsRead ?? demo }

    /// `allowAuth`: the owner asked (pull to refresh, "Show invitations"), so
    /// reading the invitations may prompt Face ID.
    public func load(allowAuth: Bool = false) async {
        if demo {
            state = .loaded(OwnerSharesSnapshot(rows: ServerShareDemo.ownerRows(), invitationsRead: true, serverAnswered: true))
            return
        }
        guard let flow else { return }
        if state.value == nil { state = .loading }
        do {
            let snap = try await flow.load(serverDomain: serverDomain, ownerToken: await ownerToken(),
                                           readInvitations: allowAuth || keysUnlocked())
            state = .loaded(snap)
        } catch {
            if state.value == nil { state = .failed(ServerShareCopy.message(for: error)) }
            else { errorMessage = ServerShareCopy.message(for: error) }
        }
    }

    public func loadActivity() async {
        if demo {
            activity = .loaded(ServerShareDemo.activity())
            return
        }
        guard let flow, let token = await ownerToken() else { return }
        do {
            activity = .loaded(try await flow.activity(serverDomain: serverDomain, ownerToken: token))
        } catch {
            if activity.value == nil { activity = .failed(ServerShareCopy.message(for: error)) }
        }
    }

    public func create(_ draft: ShareDraft) async -> CreatedShare? {
        if demo { return CreatedShare(shareId: String(repeating: "ab", count: 16), link: ServerShareDemo.link, expiresAt: 0) }
        guard let flow, busy == nil else { return nil }
        busy = "create"
        errorMessage = nil
        defer { busy = nil }
        do {
            let created = try await flow.create(serverDomain: serverDomain, serverName: serverName,
                                                stkPubHex: stkPubHex, draft: draft)
            await load(allowAuth: true)
            return created
        } catch {
            errorMessage = ServerShareCopy.message(for: error)
            return nil
        }
    }

    public func confirm(_ row: OwnerShareRow) async {
        await run(row) { flow, token in
            guard let token else { throw ServerShareHTTPError(status: 401, error: nil, code: nil) }
            if try await !flow.confirm(row, serverDomain: self.serverDomain, serverName: self.serverName, ownerToken: token) {
                self.notice = "\(row.label) has access. Start-up approval couldn't be set up yet; try again below."
            }
        }
    }

    public func change(_ row: OwnerShareRow, level: ServerShareLevel? = nil, unlockAtBoot: Bool? = nil, seeAppData: Bool? = nil) async {
        await run(row) { flow, token in
            guard let token else { throw ServerShareHTTPError(status: 401, error: nil, code: nil) }
            let ok = try await flow.change(row, level: level ?? row.level, unlockAtBoot: unlockAtBoot ?? row.unlockAtBoot,
                                           seeAppData: seeAppData ?? row.seeAppData, serverDomain: self.serverDomain,
                                           serverName: self.serverName, ownerToken: token)
            if !ok { self.notice = "Saved. Start-up approval couldn't be updated yet; try again below." }
        }
    }

    public func end(_ row: OwnerShareRow) async {
        await run(row) { flow, token in
            try await flow.end(row, serverDomain: self.serverDomain, serverName: self.serverName, ownerToken: token)
        }
    }

    public func sendStartupKey(_ row: OwnerShareRow) async {
        await run(row) { flow, _ in
            try await flow.sendStartupKey(row, serverDomain: self.serverDomain, serverName: self.serverName)
        }
    }

    private func run(_ row: OwnerShareRow, _ body: (ServerShareOwnerFlow, String?) async throws -> Void) async {
        if demo { return }
        guard let flow, busy == nil else { return }
        busy = row.shareId
        errorMessage = nil
        notice = nil
        defer { busy = nil }
        do {
            try await body(flow, await ownerToken())
            await load(allowAuth: true)
        } catch {
            errorMessage = ServerShareCopy.message(for: error)
        }
    }
}

// MARK: - The second account: "Shared with me"

/// One row of Home's "Shared with me".
public struct SharedServerRow: Identifiable, Equatable, Sendable {
    public let shareId: String
    public let name: String
    public let owner: String
    /// Nil while the owner hasn't confirmed (or the server didn't answer).
    public let level: ServerShareLevel?
    public let waitingForOwner: Bool
    public var id: String { shareId }
}

@Observable
@MainActor
public final class SharedWithMeStore {
    public static let shared = SharedWithMeStore(
        flow: ServerShareMemberFlow(client: ServerShareServices.client, umkSeed: ServerShareServices.umkSeed),
        demo: ServerShareDemo.isOn
    )

    public enum Status: Equatable, Sendable {
        case unknown
        case ready
        case waitingForOwner
        case unreachable
    }

    public struct Item: Identifiable, Equatable, Sendable {
        public let entry: SharedServerEntry
        public var status: Status
        public var session: ShareSessionResponse?
        public var id: String { entry.shareId }
    }

    public private(set) var items: [Item] = []
    public private(set) var loaded = false
    public private(set) var loading = false
    public private(set) var errorMessage: String?

    public let flow: ServerShareMemberFlow?
    public let demo: Bool
    public let pushRegistry: SharePushRegistry
    private let keysUnlocked: @MainActor () -> Bool
    private let makeScreensClient: @MainActor (String, String) -> any ScreensClient
    private let pushToken: @MainActor () async throws -> String
    private var stks: [String: String] = [:]

    public init(flow: ServerShareMemberFlow?, demo: Bool = false,
                keysUnlocked: @escaping @MainActor () -> Bool = { ServerShareServices.keysUnlocked() },
                makeScreensClient: @escaping @MainActor (String, String) -> any ScreensClient = {
                    ServerShareServices.memberScreensClient(serverDomain: $0, token: $1)
                },
                pushRegistry: SharePushRegistry = SharePushRegistry(),
                pushToken: @escaping @MainActor () async throws -> String = { try await ServerShareServices.apnsTokenHex() }) {
        self.flow = flow
        self.demo = demo
        self.keysUnlocked = keysUnlocked
        self.makeScreensClient = makeScreensClient
        self.pushRegistry = pushRegistry
        self.pushToken = pushToken
        if demo {
            let sessions = ServerShareDemo.sessions()
            items = ServerShareDemo.entries().map { Item(entry: $0, status: .ready, session: sessions[$0.shareId]) }
            loaded = true
        }
    }

    public var rows: [SharedServerRow] {
        items.map {
            SharedServerRow(shareId: $0.entry.shareId, name: $0.entry.displayName, owner: $0.entry.ownerName,
                            level: $0.session?.level, waitingForOwner: $0.status == .waitingForOwner)
        }
    }

    public func item(_ shareId: String) -> Item? { items.first { $0.entry.shareId == shareId } }

    /// Actions go through the flow: always for real, and in smoke mode when
    /// the gym's share transport answers them.
    private var usesFlow: Bool { !demo || ServerShareDemo.flowsOn }

    /// Reads the inbox and signs in to each server to learn its level. Without
    /// `allowAuth` it runs only when the account key is already unlocked.
    public func load(allowAuth: Bool) async {
        if demo { return }
        guard let flow, !loading, allowAuth || keysUnlocked() else { return }
        loading = true
        defer { loading = false }
        do {
            let entries = try await flow.inbox()
            errorMessage = nil
            var next: [Item] = entries.map { e in
                item(e.shareId).map { Item(entry: e, status: $0.status, session: $0.session) }
                    ?? Item(entry: e, status: .unknown, session: nil)
            }
            for i in next.indices {
                await refreshSession(&next[i], flow: flow)
            }
            items = next.filter { !ended.contains($0.entry.shareId) }
            loaded = true
        } catch {
            errorMessage = ServerShareCopy.message(for: error)
        }
    }

    private func refreshSession(_ item: inout Item, flow: ServerShareMemberFlow) async {
        if let s = item.session, s.expiresAt > ServerShareClock.nowMs() + 60_000 { return }
        do {
            item.session = try await flow.signIn(item.entry)
            item.status = .ready
        } catch ServerShareFlowError.notConfirmedYet {
            item.status = .waitingForOwner
        } catch ServerShareFlowError.shareEnded {
            try? await flow.deleteInboxEntry(item.entry.entryId)
            pushRegistry.forget(item.entry.shareId)
            item.status = .unknown
            item.session = nil
            ended.insert(item.entry.shareId)
        } catch {
            item.status = .unreachable
        }
    }

    /// Share ids that ended during this run (left, or ended by the owner).
    public private(set) var ended: Set<String> = []

    /// Called right after Accept: show the server at once.
    public func add(_ entry: SharedServerEntry, session: ShareSessionResponse? = nil) {
        let it = Item(entry: entry, status: session == nil ? .waitingForOwner : .ready, session: session)
        if let i = items.firstIndex(where: { $0.entry.shareId == entry.shareId }) { items[i] = it } else { items.insert(it, at: 0) }
        loaded = true
    }

    /// A live share token for this server: the cached one, else a fresh sign-in.
    public func session(for shareId: String, forceNew: Bool = false) async throws -> ShareSessionResponse {
        guard let i = items.firstIndex(where: { $0.entry.shareId == shareId }) else { throw ServerShareFlowError.shareEnded }
        if !forceNew, let s = items[i].session, s.expiresAt > ServerShareClock.nowMs() + 60_000 { return s }
        guard let flow, usesFlow else { throw ServerShareFlowError.notSignedIn }
        do {
            let s = try await flow.signIn(items[i].entry)
            if let j = items.firstIndex(where: { $0.entry.shareId == shareId }) {
                items[j].session = s
                items[j].status = .ready
            }
            return s
        } catch ServerShareFlowError.shareEnded {
            await forget(shareId)
            throw ServerShareFlowError.shareEnded
        } catch ServerShareFlowError.notConfirmedYet {
            if let j = items.firstIndex(where: { $0.entry.shareId == shareId }) { items[j].status = .waitingForOwner }
            throw ServerShareFlowError.notConfirmedYet
        }
    }

    public func screensClient(for shareId: String, forceNew: Bool = false) async throws -> any ScreensClient {
        if demo {
            let m = MockScreensClient()
            m.simulatedLatency = 0
            m.signingShareId = shareId
            m.membersOnlyApps = ["bright-maple--wiki"]
            m.mockBoxDomain = item(shareId)?.entry.serverDomain.lowercased()
            m.podContext = item(shareId).map { ServerShareNames.serverLabel(fromDomain: $0.entry.serverDomain) } ?? "garage"
            return m
        }
        let s = try await session(for: shareId, forceNew: forceNew)
        guard let it = item(shareId) else { throw ServerShareFlowError.shareEnded }
        return makeScreensClient(it.entry.serverDomain.lowercased(), s.token)
    }

    /// The share ended (the owner removed it): drop it here and from the inbox.
    public func forget(_ shareId: String) async {
        guard let it = item(shareId) else { return }
        items.removeAll { $0.entry.shareId == shareId }
        ended.insert(shareId)
        pushRegistry.forget(shareId)
        if usesFlow { try? await flow?.deleteInboxEntry(it.entry.entryId) }
    }

    public func leave(_ shareId: String) async throws {
        guard let it = item(shareId) else { return }
        if usesFlow { try await flow?.leave(it.entry) }
        items.removeAll { $0.entry.shareId == shareId }
        ended.insert(shareId)
        pushRegistry.forget(shareId)
    }

    /// The box's view of this share, with whether it may update the server.
    public func me(_ shareId: String) async throws -> ShareMeResponse {
        if demo {
            let s = item(shareId)?.session
            return ShareMeResponse(shareId: shareId, level: s?.level ?? .view, unlockAtBoot: s?.unlockAtBoot ?? false,
                                   seeAppData: s?.seeAppData ?? false, serverDomain: item(shareId)?.entry.serverDomain ?? "",
                                   canUpdate: s?.level == .manage)
        }
        guard let flow, let it = item(shareId) else { throw ServerShareFlowError.shareEnded }
        let s = try await session(for: shareId)
        return try await flow.client.boxMe(serverDomain: it.entry.serverDomain.lowercased(), shareToken: s.token)
    }

    /// Manage level: move the server to an endorsed release.
    public func orderUpdate(_ shareId: String, targetCommit: String, fromCommit: String) async throws {
        if !usesFlow { return }
        guard let flow, let it = item(shareId) else { throw ServerShareFlowError.shareEnded }
        let s = try await session(for: shareId)
        _ = try await flow.orderUpdate(it.entry, shareToken: s.token, targetCommit: targetCommit, fromCommit: fromCommit)
    }

    // MARK: Start-up notices (part of unlock at boot)

    public func startupNoticeOn(_ shareId: String) -> Bool { pushRegistry.registration(shareId) != nil }

    public func setStartupNotice(_ shareId: String, on: Bool) async throws {
        if !usesFlow { return }
        guard let flow, let it = item(shareId) else { throw ServerShareFlowError.shareEnded }
        if on {
            let token = ServerShareDemo.flowsOn ? ServerShareDemo.gymPushToken : try await pushToken()
            let reg = try await flow.registerStartupPush(it.entry, platform: .apns, providerToken: token)
            pushRegistry.save(reg, for: shareId)
        } else if let reg = pushRegistry.registration(shareId) {
            try await flow.unregisterStartupPush(it.entry, reg)
            pushRegistry.forget(shareId)
        }
    }

    // MARK: Start-up approval

    public func pendingStartups(_ shareId: String) async throws -> [VerifiedShareStartup] {
        if demo { return ServerShareDemo.route == "member" ? [ServerShareDemo.startup] : [] }
        guard let flow, let it = item(shareId), keysUnlocked() else { return [] }
        let stk: String
        if let s = stks[shareId] { stk = s } else {
            stk = try await flow.pinnedStk(it.entry)
            stks[shareId] = stk
        }
        return try await flow.pendingStartups(it.entry, stkPubHex: stk)
    }

    public func approveStartup(_ shareId: String, _ startup: VerifiedShareStartup) async throws {
        if demo { return }
        guard let flow, let it = item(shareId), let stk = stks[shareId] else { throw ServerShareFlowError.noStartupWaiting }
        try await flow.approveStartup(it.entry, startup: startup, stkPubHex: stk)
    }
}

// MARK: - The second account: accepting a link

@Observable
@MainActor
public final class ShareAcceptModel {
    public enum Phase: Equatable {
        case entry
        case opening
        case invitation(ShareInvitation)
        case accepting(ShareInvitation)
        /// The code to read to the owner; waiting for their confirmation.
        case code(AcceptedShare, owner: String)
        case done(SharedServerEntry)
        case failed(String)
    }

    public private(set) var phase: Phase = .entry
    private let flow: ServerShareMemberFlow?
    private let store: SharedWithMeStore
    private let demo: Bool
    private let pollEvery: Duration

    public init(store: SharedWithMeStore, flow: ServerShareMemberFlow?, demo: Bool = false, pollEvery: Duration = .seconds(4)) {
        self.store = store
        self.flow = flow
        self.demo = demo
        self.pollEvery = pollEvery
    }

    /// Pasted or scanned text. Returns false when it isn't a share link.
    @discardableResult
    public func open(text: String) async -> Bool {
        guard let parts = ServerShare.parseShareLink(text) else { return false }
        await open(shareId: parts.shareId, secretHex: parts.secretHex)
        return true
    }

    public func open(shareId: String, secretHex: String) async {
        if demo {
            phase = ServerShareDemo.route == "accept"
                ? .code(AcceptedShare(entry: ServerShareDemo.entries()[0], sas: "482 913"), owner: ServerShareDemo.invitation.ownerName)
                : .invitation(ServerShareDemo.invitation)
            return
        }
        guard let flow else { return }
        phase = .opening
        do {
            phase = .invitation(try await flow.open(shareId: shareId, secretHex: secretHex))
        } catch {
            phase = .failed(ServerShareCopy.message(for: error))
        }
    }

    public func accept() async {
        guard case .invitation(let inv) = phase, let flow, !demo else { return }
        phase = .accepting(inv)
        do {
            let accepted = try await flow.accept(inv)
            store.add(accepted.entry)
            phase = .code(accepted, owner: inv.ownerName)
        } catch {
            phase = .failed(ServerShareCopy.message(for: error))
        }
    }

    /// Tries to sign in until the owner confirms (or the view goes away).
    public func waitForConfirmation() async {
        guard case .code(let accepted, _) = phase, !demo else { return }
        while !Task.isCancelled {
            do {
                _ = try await store.session(for: accepted.entry.shareId, forceNew: true)
                phase = .done(accepted.entry)
                return
            } catch ServerShareFlowError.shareEnded {
                phase = .failed(ServerShareFlowError.shareEnded.errorDescription ?? "")
                return
            } catch {
            }
            try? await Task.sleep(for: pollEvery)
        }
    }
}

// MARK: - The second account: the server page

@Observable
@MainActor
public final class SharedServerModel {
    public let shareId: String
    public private(set) var session: ShareSessionResponse?
    public private(set) var detail: LoadingState<ServerDetailResponse> = .idle
    public private(set) var apps: LoadingState<[AppSummary]> = .idle
    public private(set) var metrics: ServerMetricsViewModel?
    public private(set) var client: (any ScreensClient)?
    public private(set) var startups: [VerifiedShareStartup] = []
    public private(set) var approving = false
    public private(set) var ended = false
    public var errorMessage: String?
    public var notice: String?
    public private(set) var me: ShareMeResponse?
    public private(set) var catalog: ReleaseCatalogResponse?
    public private(set) var updating = false
    public var updateNotice: String?
    public var updateError: String?
    public private(set) var notifyOn = false
    public private(set) var notifyBusy = false
    public var notifyError: String?

    private let store: SharedWithMeStore

    public init(shareId: String, store: SharedWithMeStore) {
        self.shareId = shareId
        self.store = store
        self.notifyOn = store.startupNoticeOn(shareId)
    }

    public var entry: SharedServerEntry? { store.item(shareId)?.entry }
    public var level: ServerShareLevel? { session?.level }
    public var canManage: Bool { session?.level == .manage }
    /// Manage level on a box that can update itself.
    public var canUpdate: Bool { canManage && me?.canUpdate == true }
    /// The release the Update button moves to, when one is newer.
    public var latestRelease: ReleaseEntry? { catalog?.latest }

    public func load(forceNew: Bool = false) async {
        guard let entry else { ended = true; return }
        if detail.value == nil { detail = .loading }
        do {
            let c = try await store.screensClient(for: shareId, forceNew: forceNew)
            client = c
            session = store.item(shareId)?.session
            if metrics == nil {
                metrics = ServerMetricsViewModel(podId: PodInfo.podId(forFqdn: entry.serverDomain), client: c)
            }
            async let d = c.serverDetail()
            async let a = c.appsList()
            detail = .loaded(try await d)
            apps = .loaded((try? await a)?.apps ?? [])
            me = try? await store.me(shareId)
            if canUpdate { catalog = try? await c.serverUpdates(refresh: false) }
            await metrics?.load()
        } catch ServerShareFlowError.shareEnded {
            ended = true
        } catch ScreensClientError.http(let status, _) where status == 401 && !forceNew {
            await load(forceNew: true)
        } catch ScreensClientError.http(let status, let body) where status == 403 && body.contains("share-ended") {
            await store.forget(shareId)
            ended = true
        } catch {
            if detail.value == nil { detail = .failed(ServerShareCopy.message(for: error)) }
        }
    }

    /// Polled while the page is open: start-up requests this share may answer.
    public func refreshStartups() async {
        guard session?.unlockAtBoot ?? true else { startups = []; return }
        startups = (try? await store.pendingStartups(shareId)) ?? startups
    }

    public func approve(_ startup: VerifiedShareStartup) async {
        guard !approving else { return }
        approving = true
        errorMessage = nil
        defer { approving = false }
        do {
            try await store.approveStartup(shareId, startup)
            startups.removeAll { $0.id == startup.id }
            notice = "Unlocking. The server will be back in a minute or two."
        } catch {
            errorMessage = ServerShareCopy.message(for: error)
        }
    }

    public func update(to release: ReleaseEntry) async {
        guard !updating, canUpdate, let from = detail.value?.currentCommit else { return }
        updating = true
        updateError = nil
        updateNotice = nil
        defer { updating = false }
        do {
            try await store.orderUpdate(shareId, targetCommit: release.commit, fromCommit: from)
            updateNotice = ServerShareCopy.updating(entry?.displayName ?? "The server")
        } catch {
            updateError = ServerShareCopy.message(for: error)
        }
    }

    public func setNotify(_ on: Bool) async {
        guard !notifyBusy, on != notifyOn else { return }
        notifyBusy = true
        notifyError = nil
        defer { notifyBusy = false }
        do {
            try await store.setStartupNotice(shareId, on: on)
            notifyOn = on
        } catch {
            notifyError = ServerShareCopy.message(for: error)
        }
    }

    public func dismiss(_ startup: VerifiedShareStartup) {
        startups.removeAll { $0.id == startup.id }
    }

    public func leave() async -> Bool {
        do {
            try await store.leave(shareId)
            ended = true
            return true
        } catch {
            errorMessage = ServerShareCopy.message(for: error)
            return false
        }
    }

    /// Signs `app-access/v1` and `app-db-write/v1` with this share's member key.
    public var memberSigner: AppAccessSigner {
        let flow = store.flow
        let shareId = shareId
        return { reason in
            guard let flow else { throw ServerShareFlowError.notSignedIn }
            return try await flow.memberKey(shareId: shareId, reason: reason)
        }
    }
}
