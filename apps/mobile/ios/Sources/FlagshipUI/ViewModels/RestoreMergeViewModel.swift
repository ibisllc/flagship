import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Restore a backup into a running server, app by app (docs/restore-into-server.md §7). The backup
/// is opened on the box under a signed stage order, the box says what each app is to this server,
/// the owner picks per app (the safe defaults are preselected), and a second signed order carries
/// exactly that plan. Admin devices only; every order is signed with the account's admin root.
@Observable
@MainActor
public final class RestoreMergeViewModel {
    public enum Source: Equatable {
        /// A backup saved on this server (no transfer).
        case saved(SavedBackup)
        /// A `.flagship` file picked on this device (or the phone's own copy).
        case file(URL)
    }

    public enum Phase: Equatable {
        case idle
        case opening
        case sending(Double)
        case checking
        case choosing
        case restoring
        case done
        case failed(String)
    }

    /// The owner's choice for one app.
    public struct Choice: Equatable {
        public var action: String
        public var copyName: String
        public var sameApp: Bool
    }

    public let serverFqdn: String
    public let isAdminDevice: Bool
    public private(set) var phase: Phase = .idle
    public private(set) var preview: RestoreMergePreview?
    public private(set) var run: RestoreMergeRun?
    public private(set) var undoPoints: [RestoreMergeUndoPoint] = []
    public private(set) var actionError: String?
    public private(set) var busyUndo: String?
    public var choices: [String: Choice] = [:]

    private let clients: PodScreensClientFactory
    private let signer: @Sendable (String) async throws -> Curve25519.Signing.PrivateKey
    private let accountKek: @Sendable (String) async throws -> Data
    private let now: () -> Int64
    private let pollNs: UInt64
    private var archiveId = ""
    private var dataSha256 = ""

    public static let adminOnly = String(localized: "Only an admin device of this account can restore a backup.")
    public static let chunkBytes = 4 * 1024 * 1024

    public init(
        serverFqdn: String,
        isAdminDevice: Bool,
        clients: PodScreensClientFactory,
        signer: (@Sendable (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        accountKek: (@Sendable (String) async throws -> Data)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        pollNs: UInt64 = 1_500_000_000
    ) {
        self.serverFqdn = serverFqdn.lowercased()
        self.isAdminDevice = isAdminDevice
        self.clients = clients
        self.signer = signer ?? { reason in try await Keystore.sensitiveOrderSigningKey(reason: reason) }
        self.accountKek = accountKek ?? { id in try await Keystore.deriveServerArchiveKey(archiveId: id, reason: String(localized: "Open the backup")) }
        self.now = now
        self.pollNs = pollNs
    }

    // MARK: Undo points

    public func loadUndoPoints() async {
        let c = await clients.client(forFqdn: serverFqdn)
        if let v = try? await c.restoreMergeStatus() {
            undoPoints = v.undo
            if run == nil { run = v.run?.state == "running" ? v.run : nil }
        }
    }

    public func undo(_ p: RestoreMergeUndoPoint, discard: Bool) async {
        guard isAdminDevice else { actionError = Self.adminOnly; return }
        busyUndo = p.id
        defer { busyUndo = nil }
        actionError = nil
        do {
            let order = RestoreMergeUndoOrder(serverDomain: serverFqdn, restoreId: p.restoreId, serviceId: p.serviceId, action: discard ? "discard" : "undo", issuedAt: now())
            let bytes = try ServerRestoreMerge.undoBytes(.init(serverDomain: order.serverDomain, restoreId: order.restoreId, serviceId: order.serviceId, action: order.action, issuedAt: order.issuedAt))
            let reason = discard ? String(localized: "Delete the earlier copy of \(p.name)") : String(localized: "Put \(p.name) back as it was")
            let sig = try await signer(reason).signature(for: bytes)
            let c = await clients.client(forFqdn: serverFqdn)
            try await c.restoreMergeUndo(RestoreMergeSigned(order: order, signatureHex: HexUtil.encode(sig)))
            await loadUndoPoints()
        } catch is CancellationError {
        } catch {
            actionError = Self.message(error)
        }
    }

    // MARK: Opening a backup

    public func start(_ source: Source) async {
        guard isAdminDevice else { phase = .failed(Self.adminOnly); return }
        phase = .opening
        actionError = nil
        do {
            let c = await clients.client(forFqdn: serverFqdn)
            let file: ServerBackupFormat.File
            var bundleURL: URL?
            var bundleLayout: ServerBackupBundle.Layout?
            switch source {
            case .saved(let b):
                let raw = try await c.savedBackupFile(archiveId: b.archiveId)
                file = try ServerBackupFormat.parse(raw)
            case .file(let url):
                let read = try Self.readBundle(url)
                file = read.file
                bundleURL = url
                bundleLayout = read.layout
            }
            let kek = try await accountKek(file.archiveId)
            guard let opened = try ServerBackupFormat.openWithAccountKey(file, kek: kek) else {
                throw RestoreMergeError.notThisAccount
            }
            archiveId = file.archiveId
            dataSha256 = opened.body.data.sha256
            let order = RestoreMergeStageOrder(serverDomain: serverFqdn, archiveId: archiveId, bytes: opened.body.data.bytes, sha256: dataSha256,
                                               source: bundleURL == nil ? "saved" : "upload", issuedAt: now())
            let stageBytes = try ServerRestoreMerge.stageBytes(.init(serverDomain: order.serverDomain, archiveId: order.archiveId, bytes: order.bytes,
                                                                     sha256: order.sha256, source: order.source, issuedAt: order.issuedAt))
            let sig = try await signer(String(localized: "Check the backup on \(serverFqdn)")).signature(for: stageBytes)
            let started = try await c.restoreMergeStage(RestoreMergeSigned(order: order, signatureHex: HexUtil.encode(sig)))
            if let bundleURL, let bundleLayout { try await send(bundleURL, layout: bundleLayout, from: started.received ?? 0, client: c) }
            phase = .checking
            try await c.restoreMergeCommit(keyHex: HexUtil.encode(opened.contentKey))
            try await waitForPreview(c)
        } catch is CancellationError {
            phase = .idle
        } catch {
            phase = .failed(Self.message(error))
        }
    }

    private nonisolated static func readBundle(_ url: URL) throws -> ServerBackupBundle.Opened {
        let ok = url.startAccessingSecurityScopedResource()
        defer { if ok { url.stopAccessingSecurityScopedResource() } }
        return try ServerBackupBundle.read(url)
    }

    private nonisolated static func readChunk(_ url: URL, layout: ServerBackupBundle.Layout, offset: Int64) throws -> Data {
        let ok = url.startAccessingSecurityScopedResource()
        defer { if ok { url.stopAccessingSecurityScopedResource() } }
        let fh = try FileHandle(forReadingFrom: url)
        defer { try? fh.close() }
        return try ServerBackupBundle.readData(fh, layout: layout, offset: offset, count: chunkBytes)
    }

    private func send(_ url: URL, layout: ServerBackupBundle.Layout, from: Int64, client c: any ScreensClient) async throws {
        var offset = from
        while offset < layout.dataLength {
            try Task.checkCancellation()
            let d = try Self.readChunk(url, layout: layout, offset: offset)
            try await c.restoreMergeChunk(offset: offset, data: d)
            offset += Int64(d.count)
            phase = .sending(layout.dataLength == 0 ? 1 : Double(offset) / Double(layout.dataLength))
        }
    }

    private func waitForPreview(_ c: any ScreensClient) async throws {
        while true {
            let v = try await c.restoreMergeStatus()
            if let p = v.preview, v.stage?.state == "previewed" {
                preview = p
                choices = Dictionary(uniqueKeysWithValues: p.apps.map { ($0.archivedServiceId, Choice(action: $0.recommended, copyName: Self.slug($0.copyServiceId ?? ""), sameApp: false)) })
                undoPoints = v.undo
                phase = .choosing
                return
            }
            if v.stage?.state == "failed" { throw RestoreMergeError.box(v.stage?.reason ?? String(localized: "The backup couldn't be opened.")) }
            try await Task.sleep(nanoseconds: pollNs)
        }
    }

    public func cancel() async {
        let c = await clients.client(forFqdn: serverFqdn)
        try? await c.restoreMergeCancel()
        preview = nil
        phase = .idle
    }

    // MARK: Choosing

    public enum Group: CaseIterable { case new, already, different }

    public func apps(in g: Group) -> [RestoreMergeApp] {
        (preview?.apps ?? []).filter {
            switch g {
            case .new: return $0.verdict == "new" || $0.verdict == "runs-elsewhere"
            case .already: return $0.verdict == "same"
            case .different: return $0.verdict == "clash" || $0.verdict == "clash-maybe"
            }
        }
    }

    public func choose(_ app: RestoreMergeApp, action: String) {
        guard app.allowed.contains(action) else { return }
        var c = choices[app.archivedServiceId] ?? Choice(action: app.recommended, copyName: Self.slug(app.copyServiceId ?? ""), sameApp: false)
        c.action = action
        c.sameApp = action == "replace" && app.verdict == "clash-maybe"
        choices[app.archivedServiceId] = c
    }

    public func setCopyName(_ app: RestoreMergeApp, _ name: String) {
        choices[app.archivedServiceId]?.copyName = name.lowercased()
    }

    /// Something other than keep and skip is chosen (Restore stays off otherwise).
    public var canRestore: Bool {
        isAdminDevice && phase == .choosing && choices.values.contains { $0.action != "keep" && $0.action != "skip" } && copyNamesValid
    }

    private var copyNamesValid: Bool {
        choices.values.filter { $0.action == "copy" }.allSatisfy { Self.validSlug($0.copyName) }
    }

    public static func validSlug(_ s: String) -> Bool {
        s.range(of: "^[a-z0-9](-?[a-z0-9]){0,29}$", options: .regularExpression) != nil
    }

    static func slug(_ serviceId: String) -> String {
        serviceId.components(separatedBy: "--").last ?? ""
    }

    private var account: String { serverFqdn.split(separator: ".").dropFirst().first.map(String.init) ?? "" }

    func lines() -> [RestoreMergeLine] {
        (preview?.apps ?? []).map { a in
            let c = choices[a.archivedServiceId] ?? Choice(action: a.recommended, copyName: "", sameApp: false)
            let guarded = c.action == "replace" || c.action == "replace-data"
            return RestoreMergeLine(
                archivedServiceId: a.archivedServiceId,
                action: c.action,
                targetServiceId: c.action == "copy" ? "\(account)--\(c.copyName)" : nil,
                sameApp: c.sameApp,
                guardCode: guarded ? a.guards?.guardCode : nil,
                guardSchema: guarded ? a.guards?.guardSchema : nil,
                guardGen: guarded ? a.guards?.guardGen : nil
            )
        }
    }

    public func restore() async {
        guard canRestore, let p = preview else { return }
        actionError = nil
        do {
            let lines = lines()
            let planSha = try ServerRestoreMerge.planSha256(lines.map {
                .init(archivedServiceId: $0.archivedServiceId, action: $0.action, targetServiceId: $0.targetServiceId, sameApp: $0.sameApp,
                      guardCode: $0.guardCode, guardSchema: $0.guardSchema, guardGen: $0.guardGen)
            })
            let issued = now()
            let order = RestoreMergePlanOrder(serverDomain: serverFqdn, restoreId: p.restoreId, archiveId: archiveId, sha256: dataSha256,
                                              planSha256: planSha, issuedAt: issued, expiresAt: issued + 6 * 3_600_000)
            let bytes = try ServerRestoreMerge.mergeBytes(.init(serverDomain: order.serverDomain, restoreId: order.restoreId, archiveId: order.archiveId,
                                                                sha256: order.sha256, planSha256: order.planSha256, issuedAt: order.issuedAt, expiresAt: order.expiresAt))
            let sig = try await signer(String(localized: "Restore apps into \(serverFqdn)")).signature(for: bytes)
            let c = await clients.client(forFqdn: serverFqdn)
            try await c.restoreMergePlan(RestoreMergeSigned(order: order, signatureHex: HexUtil.encode(sig), lines: lines))
            phase = .restoring
            while true {
                let v = try await c.restoreMergeStatus()
                run = v.run
                undoPoints = v.undo
                if v.run?.state == "done" { phase = .done; return }
                try await Task.sleep(nanoseconds: pollNs)
            }
        } catch is CancellationError {
        } catch {
            actionError = Self.message(error)
        }
    }

    // MARK: What the screen says

    /// One comparison line per app on this server.
    public static func comparison(_ a: RestoreMergeApp) -> String {
        guard let box = a.box else {
            return a.verdict == "runs-elsewhere"
                ? String(localized: "Runs on \(a.alsoOn.joined(separator: ", ")) (its data is likely newer)")
                : String(localized: "Not on this server")
        }
        switch a.code {
        case "same": return String(localized: "Same version as this server's: \(box.version)")
        case "backup-older": return a.codeByVersion
            ? String(localized: "The backup is probably older: \(a.backup.version) vs \(box.version)")
            : String(localized: "The backup is older: \(a.backup.version) vs \(box.version)")
        case "backup-newer": return a.codeByVersion
            ? String(localized: "The backup is probably newer: \(a.backup.version) vs \(box.version)")
            : String(localized: "The backup is newer: \(a.backup.version) vs \(box.version)")
        case "diverged": return String(localized: "Changed separately here and in the backup: \(a.backup.version) vs \(box.version)")
        default: return String(localized: "Backup \(a.backup.version), this server \(box.version)")
        }
    }

    public static func actionName(_ action: String) -> String {
        switch action {
        case "install": return String(localized: "Restore it")
        case "skip": return String(localized: "Leave it out")
        case "keep": return String(localized: "Keep this server's")
        case "replace": return String(localized: "Restore the backup's version")
        case "replace-data": return String(localized: "Use the backup's data with this server's version")
        case "copy": return String(localized: "Add as a separate app")
        default: return action
        }
    }

    /// What one action does, in one line.
    public static func consequence(_ action: String, _ a: RestoreMergeApp) -> String {
        switch action {
        case "install": return a.verdict == "runs-elsewhere"
            ? String(localized: "Comes back here too. Who can use it follows its list on your other servers.")
            : String(localized: "Comes back with its data. Nobody from the backup's list can use it until you approve.")
        case "skip": return String(localized: "Nothing changes on this server.")
        case "keep": return String(localized: "Nothing changes. This server's version and data stay.")
        case "replace": return String(localized: "This server's copy is kept for 7 days, so you can undo. Who can use it: unchanged.")
        case "replace-data": return String(localized: "This server's version runs on the backup's data. This server's copy is kept for 7 days. Who can use it: unchanged.")
        case "copy": return String(localized: "A new app with its own address. Nobody can use it until you invite them.")
        default: return ""
        }
    }

    /// Why the box doesn't offer an action for this app.
    public static func refusal(_ code: String) -> String {
        switch code {
        case "not-on-server": return String(localized: "It isn't on this server.")
        case "already-on-server": return String(localized: "It is already on this server.")
        case "different-app": return String(localized: "It is a different app with the same name.")
        case "schema-newer": return String(localized: "The backup's data is newer than this server's version can read.")
        case "schema-diverged": return String(localized: "The backup's data and this server's changed separately.")
        case "stores-differ": return String(localized: "The backup keeps its data differently from this server's version.")
        case "no-copy-name": return String(localized: "There is no free name for a copy.")
        case "busy": return String(localized: "It is being changed right now. Try again when that is done.")
        default: return String(localized: "Not possible for this app.")
        }
    }

    /// Notes shown with an app's choice: other servers, the address, jobs in its data.
    public static func notes(_ a: RestoreMergeApp, action: String) -> [String] {
        var out: [String] = []
        if !a.alsoOn.isEmpty && a.box != nil { out.append(String(localized: "Also runs on \(a.alsoOn.joined(separator: ", ")): not changed.")) }
        if a.addressMoves && action == "install" { out.append(String(localized: "Its address will move to this server (it is first in your server order).")) }
        if (action == "replace" || action == "replace-data" || action == "install") && a.backup.hasDatabase == true {
            out.append(String(localized: "Jobs saved in the backup may run again."))
        }
        if (action == "replace" || action == "replace-data") && a.backup.hasFiles == true {
            out.append(String(localized: "Files the app keeps are read as the backup left them."))
        }
        return out
    }

    public static func stepName(_ step: String) -> String {
        switch step {
        case "done": return String(localized: "Restored")
        case "kept": return String(localized: "Kept")
        case "skipped": return String(localized: "Left out")
        case "failed": return String(localized: "Couldn't restore. It is back as it was.")
        case "refused-changed": return String(localized: "Changed since you chose. Kept as it is.")
        case "waiting": return String(localized: "Waiting")
        default: return String(localized: "Restoring…")
        }
    }

    static func message(_ error: Error) -> String {
        if let e = error as? RestoreMergeError { return e.errorDescription ?? String(localized: "The restore didn't start.") }
        if case let ScreensClientError.http(_, body) = error,
           let d = body.data(using: .utf8),
           let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
           let s = o["error"] as? String {
            return s
        }
        return (error as? LocalizedError)?.errorDescription ?? String(localized: "The restore didn't start.")
    }
}

public enum RestoreMergeError: Error, LocalizedError, Equatable {
    case notThisAccount
    case box(String)

    public var errorDescription: String? {
        switch self {
        case .notThisAccount: return String(localized: "This backup wasn't made by this account, so it can't be opened here.")
        case .box(let s): return s
        }
    }
}
