import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// The owner's Database section (docs/app-apis.md §6): an app's live tables,
/// rows and SQL. Owner only: hidden on a restricted profile and whenever the
/// box refuses (403, a companion) or doesn't have it (404, an older box).
public enum AppDbCopy {
    public static let sectionTitle = "DATABASE"
    public static let rowTitle = "Database"
    public static let rowSubtitle = "Browse tables and run SQL on the live data"
    public static let screenTitle = "Database"
    public static let intro = "Your app's live data. Reading is safe; anything that changes data asks for Face ID first."
    public static let noTables = "No tables yet."
    public static let runSql = "Run SQL"
    public static let run = "Run"
    public static let exportCsv = "Export CSV"
    public static let confirmWrite = "This changes data. Confirm with Face ID to run it."
    public static let confirmButton = "Confirm and run"
    public static let truncated = "Showing the first rows only: more matched than the server returns."
    public static let sqlPlaceholder = "SELECT * FROM …"

    public static func storeTitle(_ store: String) -> String { store == "default" ? "Tables" : "Store \(store)" }

    public static func tableCount(_ n: Int) -> String { n == 1 ? "1 table" : "\(n) tables" }

    /// "~1,234 rows · 48 KB", "view", or "size unknown".
    public static func tableDetail(_ t: AppDbTable) -> String {
        var parts: [String] = []
        if t.isView { parts.append("View") }
        if let rows = t.rows { parts.append("~\(number(rows)) \(rows == 1 ? "row" : "rows")") }
        if !t.isView || t.bytes > 0 { parts.append(bytes(t.bytes)) }
        return parts.joined(separator: " · ")
    }

    /// "Rows 101–200 of 1,234".
    public static func pageLabel(offset: Int, count: Int, total: Int64) -> String {
        guard count > 0 else { return total == 0 ? "No rows" : "No rows here (\(number(total)) in all)" }
        return "Rows \(number(Int64(offset + 1)))–\(number(Int64(offset + count))) of \(number(total))"
    }

    /// "UPDATE · 3 rows".
    public static func resultSummary(_ r: AppDbQueryResult) -> String {
        var parts = [r.command.isEmpty ? "Done" : r.command]
        if let n = r.rowCount { parts.append(n == 1 ? "1 row" : "\(number(n)) rows") }
        return parts.joined(separator: " · ")
    }

    public static func number(_ n: Int64) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US")
        return f.string(from: NSNumber(value: n)) ?? String(n)
    }

    public static func bytes(_ n: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: n, countStyle: .file)
    }

    /// The box's refusal in plain words. A Postgres error is shown as
    /// Postgres wrote it: the owner is looking at their own SQL.
    public static func message(for error: Error) -> String {
        if let e = error as? AppDbOrder.Failure { return e.message }
        guard case let ScreensClientError.http(status, body) = error else {
            return ScreensClientError.userFacing(error)
        }
        let reason = AppDbRefusal.decode(body)?.error ?? ScreensClientError.boxReason(error)
        switch status {
        case 400: return reason ?? "The server couldn't run that."
        case 403:
            let r = reason?.lowercased() ?? ""
            if r.contains("stale") { return "Your phone's clock is more than 10 minutes off. Check the date and time, then try again." }
            if r.contains("different server") { return "This was signed for a different server. Reload and try again." }
            if r.contains("not the one that was signed") { return "The statement changed after you confirmed it. Run it again." }
            if r.contains("signature") { return "Your server didn't accept your signature. Only the account owner's phone can change data." }
            return "Only the account owner can open this app's database."
        case 404: return reason.map { "Not found: \($0)." } ?? "This app or table isn't on the server any more."
        case 409: return "That confirmation was already used. Run it again to confirm once more."
        case 413: return reason ?? "That's too large for the server to send."
        case 503: return "The app's database isn't reachable right now. Try again in a moment."
        default: return ScreensClientError.plainLanguage(forStatus: status)
        }
    }

    /// The box doesn't offer the section here (older box, companion session,
    /// or a client without it).
    static func meansHidden(_ error: Error) -> Bool {
        switch error as? ScreensClientError {
        case .http(404, _)?, .http(403, _)?, .notImplemented?: return true
        default: return false
        }
    }

    /// A 400 that means "this would change data: sign it".
    static func needsGrant(_ error: Error) -> Bool {
        guard case let ScreensClientError.http(400, body) = error else { return false }
        return AppDbRefusal.decode(body)?.needsGrant == true
    }
}

/// Sign `flagship/app-db-write/v1` for one exact SQL text. `serverDomain` is
/// the box the request goes to (the paired box), never the leader.
public enum AppDbOrder {
    public struct Failure: Error, Equatable {
        public let message: String
    }

    public static func domain(client: any ScreensClient, fallbackServerDomain: String?) async throws -> String {
        let boxDomain = await client.boxDomain()
        guard let domain = boxDomain ?? fallbackServerDomain, !domain.isEmpty else {
            throw Failure(message: "No server to send this to.")
        }
        return domain
    }

    public static func signed(sql: String, serviceId: String, store: String, serverDomain: String,
                              key: Curve25519.Signing.PrivateKey, issuedAt: Int64) throws -> AppDbQueryRequest {
        let grant = AppDbWriteGrant(serverDomain: serverDomain, serviceId: serviceId, store: store,
                                    sql: sql, issuedAt: issuedAt)
        let signature: Data
        do {
            signature = try key.signature(for: grant.canonicalBytes())
        } catch {
            throw Failure(message: "Couldn't sign the change: \(error.localizedDescription)")
        }
        return AppDbQueryRequest(sql: sql, grant: grant, signature: HexUtil.encode(signature))
    }
}

/// The Database screen: each store's tables. `load()` doubles as the probe
/// the app page uses to decide whether to show the entry at all.
@Observable
@MainActor
public final class AppDatabaseController {
    public let serviceId: String
    public private(set) var state: LoadingState<[AppDbStore]> = .idle
    /// The box has no Database section for this session: show nothing.
    public private(set) var isHidden = false

    private let client: any ScreensClient

    public init(serviceId: String, client: any ScreensClient) {
        self.serviceId = serviceId
        self.client = client
    }

    public var stores: [AppDbStore] { state.value ?? [] }
    public var tableCount: Int { stores.reduce(0) { $0 + $1.tables.count } }

    public func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await client.serviceDb(serviceId: serviceId).stores)
            isHidden = false
        } catch {
            if AppDbCopy.meansHidden(error) {
                isHidden = true
                state = .idle
            } else if state.value == nil {
                state = .failed(AppDbCopy.message(for: error))
            }
        }
    }
}

/// One table's rows, 100 at a time, plus Export CSV.
@Observable
@MainActor
public final class AppDbTableController {
    public static let pageSize = 100

    public let serviceId: String
    public let store: String
    public let table: String
    public private(set) var state: LoadingState<AppDbTableRows> = .idle
    public private(set) var offset = 0
    public private(set) var isExporting = false
    public private(set) var exportError: String?
    /// The CSV file written for the share sheet.
    public var exportedFile: URL?

    private let client: any ScreensClient
    private let exportDirectory: URL

    public init(serviceId: String, store: String, table: String, client: any ScreensClient,
                exportDirectory: URL = FileManager.default.temporaryDirectory.appendingPathComponent("db-export", isDirectory: true)) {
        self.serviceId = serviceId
        self.store = store
        self.table = table
        self.client = client
        self.exportDirectory = exportDirectory
    }

    public var page: AppDbTableRows? { state.value }
    public var total: Int64 { page?.total ?? 0 }
    public var hasPrevious: Bool { offset > 0 }
    public var hasNext: Bool { Int64(offset + (page?.rows.count ?? 0)) < total }
    public var pageLabel: String {
        AppDbCopy.pageLabel(offset: offset, count: page?.rows.count ?? 0, total: total)
    }

    public func load() async { await load(offset: offset) }
    public func next() async { if hasNext { await load(offset: offset + Self.pageSize) } }
    public func previous() async { if hasPrevious { await load(offset: max(0, offset - Self.pageSize)) } }

    private func load(offset: Int) async {
        state = .loading
        do {
            let r = try await client.serviceDbTableRows(serviceId: serviceId, store: store, table: table,
                                                        offset: offset, limit: Self.pageSize)
            self.offset = offset
            state = .loaded(r)
        } catch {
            state = .failed(AppDbCopy.message(for: error))
        }
    }

    /// Fetch the whole table as CSV and write it where the share sheet can
    /// hand it on (Files, AirDrop, Mail…).
    @discardableResult
    public func exportCsv() async -> URL? {
        guard !isExporting else { return nil }
        isExporting = true
        exportError = nil
        defer { isExporting = false }
        do {
            let data = try await client.serviceDbExportCsv(serviceId: serviceId, store: store, table: table)
            try FileManager.default.createDirectory(at: exportDirectory, withIntermediateDirectories: true)
            let url = exportDirectory.appendingPathComponent(Self.csvFilename(table))
            try? FileManager.default.removeItem(at: url)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            exportedFile = url
            return url
        } catch {
            exportError = AppDbCopy.message(for: error)
            return nil
        }
    }

    /// Delete the exported file once the share sheet is done with it.
    public func finishExport() {
        if let url = exportedFile { try? FileManager.default.removeItem(at: url) }
        exportedFile = nil
    }

    /// The box's own rule: anything outside `[A-Za-z0-9._-]` becomes `_`.
    static func csvFilename(_ table: String) -> String {
        var out = ""
        var lastWasUnderscore = false
        for s in table.unicodeScalars {
            let ok = ("A"..."Z").contains(s) || ("a"..."z").contains(s) || ("0"..."9").contains(s)
                || s == "." || s == "_" || s == "-"
            if ok {
                out.unicodeScalars.append(s)
                lastWasUnderscore = false
            } else if !lastWasUnderscore {
                out += "_"
                lastWasUnderscore = true
            }
        }
        let name = String(out.prefix(80))
        return (name.isEmpty ? "table" : name) + ".csv"
    }
}

/// Run SQL on one store. Unsigned runs are read-only; a write (the box's 400
/// `needsGrant`) asks to confirm with Face ID, then resends with the signed
/// order. A 409 (that order was already used) re-signs with a new
/// `issuedAt` and sends once more.
@Observable
@MainActor
public final class AppDbQueryController {
    public enum Phase: Equatable {
        case idle
        case running
        /// The statement changes data: waiting for the owner to confirm.
        case needsConfirm
        case signing
        case done(AppDbQueryResult)
        case failed(String)
    }

    public let serviceId: String
    public let store: String
    public let appName: String
    public var sql: String = "" {
        didSet { if sql != oldValue, phase == .needsConfirm { phase = .idle } }
    }
    public private(set) var phase: Phase = .idle
    /// The exact text the box asked to have signed.
    private var pendingSql: String?

    /// Writes need the admin root on an admin-pinned box: off, a write is
    /// refused here with `AdminOrderGate.dataWrite` instead of asking Face ID.
    public let canWrite: Bool

    private let client: any ScreensClient
    private let fallbackServerDomain: String?
    private let signer: AppAccessSigner
    private let now: () -> Date
    private var lastIssuedAt: Int64 = 0

    public init(serviceId: String, store: String, appName: String, client: any ScreensClient,
                serverDomain: String?, canWrite: Bool = true, signer: AppAccessSigner? = nil,
                now: @escaping () -> Date = Date.init) {
        self.canWrite = canWrite
        self.serviceId = serviceId
        self.store = store
        self.appName = appName
        self.client = client
        self.fallbackServerDomain = serverDomain
        self.signer = signer ?? AppAccessOrder.defaultSigner
        self.now = now
    }

    public var isBusy: Bool { phase == .running || phase == .signing }
    public var canRun: Bool { !isBusy && !sql.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    public var result: AppDbQueryResult? {
        if case .done(let r) = phase { return r }
        return nil
    }

    /// Run unsigned (read-only).
    public func run() async {
        guard canRun else { return }
        let text = sql
        phase = .running
        pendingSql = nil
        do {
            phase = .done(try await client.serviceDbQuery(serviceId: serviceId, store: store, AppDbQueryRequest(sql: text)))
        } catch {
            if AppDbCopy.needsGrant(error) {
                if canWrite {
                    pendingSql = text
                    phase = .needsConfirm
                } else {
                    phase = .failed(AdminOrderGate.dataWrite)
                }
            } else {
                phase = .failed(AppDbCopy.message(for: error))
            }
        }
    }

    /// Not now: back to the editor without running anything.
    public func cancelConfirm() {
        guard phase == .needsConfirm else { return }
        pendingSql = nil
        phase = .idle
    }

    /// Face ID → sign the exact statement → resend. A 409 re-signs once.
    public func confirmWrite() async {
        guard phase == .needsConfirm, let text = pendingSql else { return }
        phase = .signing
        do {
            let domain = try await AppDbOrder.domain(client: client, fallbackServerDomain: fallbackServerDomain)
            let key: Curve25519.Signing.PrivateKey
            do {
                key = try await signer("Change \(appName)'s data")
            } catch {
                throw AppDbOrder.Failure(message: "Couldn't access your account key: \(error.localizedDescription)")
            }
            var attempt = 0
            while true {
                let req = try AppDbOrder.signed(sql: text, serviceId: serviceId, store: store,
                                                serverDomain: domain, key: key, issuedAt: nextIssuedAt())
                do {
                    let r = try await client.serviceDbQuery(serviceId: serviceId, store: store, req)
                    pendingSql = nil
                    phase = .done(r)
                    return
                } catch ScreensClientError.http(409, _) where attempt == 0 {
                    attempt += 1
                }
            }
        } catch {
            pendingSql = nil
            phase = .failed(AppDbCopy.message(for: error))
        }
    }

    /// Unix ms, strictly after the last order this screen signed.
    private func nextIssuedAt() -> Int64 {
        let t = max(Int64(now().timeIntervalSince1970 * 1000), lastIssuedAt + 1)
        lastIssuedAt = t
        return t
    }
}
