import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// The sensitive-order key (admin root when held, else the owner IRK), behind
/// Face ID. Injected so tests can sign with a fixed key.
public typealias AppAccessSigner = @MainActor (_ reason: String) async throws -> Curve25519.Signing.PrivateKey

public enum AppAccessCopy {
    public static let sectionTitle = "INTERNET ACCESS"
    public static let viewList = "View access list"
    public static let editorTitle = "Access list"
    public static let editorHelp = "One rule per line: allow or deny, then a host, *.host or all. The first rule that matches decides; anything no rule matches is blocked."

    public static func ruleCount(_ n: Int) -> String {
        switch n {
        case 0: return "No rules: this app can't reach the internet"
        case 1: return "1 rule"
        default: return "\(n) rules"
        }
    }

    public static func wantsToReach(app: String, host: String) -> String { "\(app) wants to reach \(host)" }

    // Suggested lists (drafts).
    public static let draftTitle = "This app suggests letting it reach these hosts"
    public static let draftNote = "Nothing opens until you review the list and save it."
    public static let review = "Review"
    public static let dismissDraft = "Dismiss"
    public static let draftEditorNote = "Suggested by the app. Change anything you like; nothing opens until you save."
    public static let draftGone = "This suggestion was already answered."
    public static func suggestsList(app: String) -> String { "\(app) suggests an access list" }

    /// The marker on the app list: a suggested list waits, or hosts do.
    public enum ListBadge: Equatable, Sendable {
        case draft
        case pending
    }

    public static func listBadge(access: AppAccessSummary?, egress: AppEgress?) -> ListBadge? {
        if access?.draft == true { return .draft }
        if access?.hasPending ?? (egress?.hasPending == true) { return .pending }
        return nil
    }

    /// Where the request came from: the gateway saw a connection, or the app
    /// declared the host at install.
    public static func source(_ source: String, attempts: Int) -> String {
        if source == "app" { return "Asked at install" }
        return attempts > 1 ? "Tried to connect \(attempts) times" : "Tried to connect"
    }

    public static func answered(app: String, host: String, action: AppAccessAction) -> String {
        action == .allow ? "\(app) can now reach \(host)" : "\(app) won't reach \(host)"
    }

    public static func lineError(_ e: AppAccessLineError) -> String { "Line \(e.line): \(e.message)" }

    /// The box's refusal in plain words.
    public static func message(for error: Error) -> String {
        if let e = error as? AppAccessOrder.Failure { return e.message }
        guard case let ScreensClientError.http(status, body) = error else {
            return ScreensClientError.userFacing(error)
        }
        let reason = ScreensClientError.boxReason(error)
        switch status {
        case 400:
            if let refusal = AppAccessRefusal.decode(body), let errors = refusal.errors, !errors.isEmpty {
                return "The server found mistakes in the list: " + errors.map(lineError).joined(separator: "; ")
            }
            return reason.map { "The server refused the list: \($0)." } ?? ScreensClientError.plainLanguage(forStatus: status)
        case 403:
            if reason?.contains("different server") == true {
                return "This change was signed for a different server. Reload the page and try again."
            }
            if reason?.contains("stale") == true || reason?.contains("issuedAt") == true || reason?.contains("clock") == true {
                return "Your phone's clock is too far off from the server's. Check the date and time, then try again."
            }
            return "The server didn't accept your signature. Only the account owner's phone can change this."
        case 404: return "This app isn't installed on the server any more."
        case 409: return "A newer access list is already on the server. Reload and try again."
        default: return ScreensClientError.plainLanguage(forStatus: status)
        }
    }

    /// The per-line errors of a 400, for the editor.
    public static func lineErrors(for error: Error) -> [AppAccessLineError] {
        guard case let ScreensClientError.http(400, body) = error else { return [] }
        return AppAccessRefusal.decode(body)?.errors ?? []
    }
}

/// Normalize → sign `flagship/app-access/v1` with the sensitive-order key →
/// POST. `serverDomain` is the box the client talks to (its own FQDN), so the
/// box finds its own name in the grant.
public enum AppAccessOrder {
    public struct Failure: Error, Equatable {
        public let message: String
    }

    public static func send(
        list: String,
        serviceId: String,
        client: any ScreensClient,
        fallbackServerDomain: String?,
        signer: AppAccessSigner,
        reason: String,
        now: () -> Date = Date.init
    ) async throws -> AppAccessState {
        let normalized = AppAccessList.normalize(list)
        let parsed = AppAccessList.parse(normalized)
        guard parsed.isValid else {
            throw Failure(message: parsed.errors.map(AppAccessCopy.lineError).joined(separator: "; "))
        }
        let boxDomain = await client.boxDomain()
        guard let domain = boxDomain ?? fallbackServerDomain, !domain.isEmpty else {
            throw Failure(message: "No server to send this to.")
        }
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try await signer(reason)
        } catch {
            throw Failure(message: "Couldn't access your account key: \(error.localizedDescription)")
        }
        let grant = AppAccessGrant(serverDomain: domain, serviceId: serviceId, list: normalized,
                                   issuedAt: Int64(now().timeIntervalSince1970 * 1000))
        let signature: Data
        do {
            signature = try key.signature(for: grant.canonicalBytes())
        } catch {
            throw Failure(message: "Couldn't sign the change: \(error.localizedDescription)")
        }
        let r = try await client.serviceAccessSet(
            serviceId: serviceId,
            AppAccessSetRequest(list: normalized, grant: grant, signature: HexUtil.encode(signature)))
        return r.access ?? AppAccessState(list: normalized, listSha256: grant.listSha256)
    }

    /// Allow or Deny one host: the box's current list + `withRule`, signed
    /// and sent. A 409 (the list changed under us) re-reads it once.
    public static func answer(
        host: String,
        action: AppAccessAction,
        serviceId: String,
        appName: String,
        currentList: String?,
        client: any ScreensClient,
        fallbackServerDomain: String?,
        signer: AppAccessSigner
    ) async throws -> AppAccessState {
        let reason = action == .allow ? "Allow \(appName) to reach \(host)" : "Stop \(appName) reaching \(host)"
        var base: String
        if let currentList { base = currentList } else { base = try await client.serviceAccess(serviceId: serviceId).list }
        do {
            return try await send(list: AppAccessList.withRule(base, action: action, host: host),
                                  serviceId: serviceId, client: client,
                                  fallbackServerDomain: fallbackServerDomain, signer: signer, reason: reason)
        } catch ScreensClientError.http(let status, _) where status == 409 {
            base = try await client.serviceAccess(serviceId: serviceId).list
            return try await send(list: AppAccessList.withRule(base, action: action, host: host),
                                  serviceId: serviceId, client: client,
                                  fallbackServerDomain: fallbackServerDomain, signer: signer, reason: reason)
        }
    }

    public static let defaultSigner: AppAccessSigner = { reason in
        try await Keystore.sensitiveOrderSigningKey(reason: reason)
    }
}

/// The "Internet access" section of one app's page: the list, the waiting
/// requests, and the answers.
@Observable
@MainActor
public final class AppAccessController {
    public let serviceId: String
    public private(set) var appName: String
    public private(set) var state: LoadingState<AppAccessState> = .idle
    /// The host being answered or dismissed right now.
    public private(set) var busyHost: String?
    /// The suggested list is being dismissed.
    public private(set) var isDismissingDraft = false
    public private(set) var errorMessage: String?
    /// The last answer, for the confirmation line.
    public private(set) var lastAnswer: (host: String, action: AppAccessAction)?
    /// Answers and Save (off on a restricted profile or a non-admin device:
    /// the box refuses it).
    public let canChange: Bool
    /// Why `canChange` is off, shown under the list; nil shows nothing.
    public let readOnlyNote: String?

    private let client: any ScreensClient
    private let fallbackServerDomain: String?
    private let signer: AppAccessSigner

    public init(serviceId: String, appName: String, client: any ScreensClient, serverDomain: String?,
                canChange: Bool = true, readOnlyNote: String? = nil, signer: AppAccessSigner? = nil) {
        self.serviceId = serviceId
        self.appName = appName
        self.client = client
        self.fallbackServerDomain = serverDomain
        self.canChange = canChange
        self.readOnlyNote = canChange ? nil : readOnlyNote
        self.signer = signer ?? AppAccessOrder.defaultSigner
    }

    public var access: AppAccessState? { state.value }
    public var pending: [AppAccessPendingHost] { access?.pending ?? [] }
    /// The suggested list waiting for review, if any.
    public var draft: AppAccessDraft? { access?.draft }
    public var ruleCount: Int { access?.ruleCount ?? 0 }

    public func setAppName(_ name: String) { appName = name }

    public func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await client.serviceAccess(serviceId: serviceId))
        } catch {
            if state.value == nil { state = .failed(ScreensClientError.userFacing(error)) }
        }
    }

    @discardableResult
    public func answer(host: String, action: AppAccessAction) async -> Bool {
        guard canChange, busyHost == nil else { return false }
        busyHost = host
        errorMessage = nil
        defer { busyHost = nil }
        do {
            let next = try await AppAccessOrder.answer(
                host: host, action: action, serviceId: serviceId, appName: appName,
                currentList: access?.list, client: client,
                fallbackServerDomain: fallbackServerDomain, signer: signer)
            apply(next, answered: host, dropDraft: true)
            lastAnswer = (host, action)
            return true
        } catch {
            errorMessage = AppAccessCopy.message(for: error)
            return false
        }
    }

    /// Ignore: forget the request; the list stays as it is.
    @discardableResult
    public func ignore(host: String) async -> Bool {
        guard busyHost == nil else { return false }
        busyHost = host
        errorMessage = nil
        defer { busyHost = nil }
        do {
            if let next = try await client.serviceAccessDismiss(serviceId: serviceId, host: host) {
                apply(next, answered: host)
            } else if let a = access {
                state = .loaded(AppAccessState(list: a.list, listSha256: a.listSha256,
                                               pending: a.pending.filter { $0.host != host }, draft: a.draft))
            }
            return true
        } catch {
            errorMessage = AppAccessCopy.message(for: error)
            return false
        }
    }

    /// Dismiss: discard the suggested list (unsigned: it opened nothing).
    @discardableResult
    public func dismissDraft() async -> Bool {
        guard canChange, draft != nil, !isDismissingDraft else { return false }
        isDismissingDraft = true
        errorMessage = nil
        defer { isDismissingDraft = false }
        do {
            let next = try await client.serviceAccessDraftDismiss(serviceId: serviceId)
            if let next {
                apply(next, answered: nil, dropDraft: true)
            } else if let a = access {
                state = .loaded(AppAccessState(list: a.list, listSha256: a.listSha256, pending: a.pending, draft: nil))
            }
            return true
        } catch {
            errorMessage = AppAccessCopy.message(for: error)
            return false
        }
    }

    /// Review: the editor prefilled with the suggested list. Saving signs and
    /// sends it like any list, which clears the draft on the box.
    public func makeDraftEditor() -> AppAccessEditorModel? {
        guard let draft else { return nil }
        return makeEditor(initialList: draft.list, note: AppAccessCopy.draftEditorNote)
    }

    /// An editor on the current list; saving it updates this section.
    public func makeEditor() -> AppAccessEditorModel {
        makeEditor(initialList: access?.list ?? AppAccessList.defaultList, note: nil)
    }

    private func makeEditor(initialList: String, note: String?) -> AppAccessEditorModel {
        AppAccessEditorModel(appName: appName, initialList: initialList, note: note,
                             canSave: canChange) { [weak self] list in
            guard let self else { throw AppAccessOrder.Failure(message: "This page was closed.") }
            let next = try await AppAccessOrder.send(
                list: list, serviceId: self.serviceId, client: self.client,
                fallbackServerDomain: self.fallbackServerDomain, signer: self.signer,
                reason: "Change \(self.appName)'s access list")
            self.apply(next, answered: nil, dropDraft: true)
            return next
        }
    }

    /// `dropDraft`: a signed list was just applied (or the draft dismissed),
    /// so the draft is gone on the box whatever an older answer says.
    private func apply(_ next: AppAccessState, answered host: String?, dropDraft: Bool = false) {
        // An answered host is no longer waiting, whatever an older box says.
        let pending = next.pending.filter { p in
            p.host != host && AppAccessList.decide(next.list, host: p.host).rule == nil
        }
        state = .loaded(AppAccessState(list: next.list, listSha256: next.listSha256, pending: pending,
                                       draft: dropDraft ? nil : next.draft))
    }
}

/// The list editor: parses as the owner types, shows each error by line, and
/// keeps Save off while there are any.
@Observable
@MainActor
public final class AppAccessEditorModel: Identifiable {
    public nonisolated let id = UUID()
    public let appName: String
    /// A line above the editor (e.g. that this is the app's suggestion).
    public let note: String?
    public var text: String {
        didSet { if text != refusedText { serverErrors = [] } }
    }
    public private(set) var original: String
    public private(set) var isSaving = false
    public private(set) var errorMessage: String?
    public private(set) var saved = false
    public let canSaveAtAll: Bool
    private var serverErrors: [AppAccessLineError] = []
    private var refusedText: String?
    private let send: @MainActor (String) async throws -> AppAccessState

    public init(appName: String, initialList: String, note: String? = nil, canSave: Bool = true,
                send: @escaping @MainActor (String) async throws -> AppAccessState) {
        self.appName = appName
        self.note = note
        self.text = initialList
        self.original = initialList
        self.canSaveAtAll = canSave
        self.send = send
    }

    public var parsed: AppAccessParse { AppAccessList.parse(text) }
    /// The parser's errors, plus any the box sent back for this exact text.
    public var lineErrors: [AppAccessLineError] {
        let local = parsed.errors
        return local.isEmpty ? serverErrors : local
    }
    public var ruleCount: Int { parsed.rules.count }
    public var hasChanges: Bool { AppAccessList.normalize(text) != AppAccessList.normalize(original) }
    public var canSave: Bool { canSaveAtAll && !isSaving && parsed.isValid && serverErrors.isEmpty }

    @discardableResult
    public func save() async -> Bool {
        guard canSave else { return false }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let next = try await send(text)
            text = next.list
            original = next.list
            saved = true
            return true
        } catch {
            let lines = AppAccessCopy.lineErrors(for: error)
            if !lines.isEmpty {
                serverErrors = lines
                refusedText = text
            }
            errorMessage = AppAccessCopy.message(for: error)
            return false
        }
    }
}
