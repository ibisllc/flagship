import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// "Backup/clone server" on a server's page (docs/server-backup-and-clone.md):
/// the user sets the backup's passcode, this device makes the content key and
/// its two key slots, the box seals the backup, and this device downloads the
/// two files for the user to save wherever they like.
@Observable
@MainActor
public final class ServerBackupViewModel {
    public enum Phase: Equatable {
        case checking
        /// Set the passcode (the suggested one, or the user's own).
        case passcode
        case building(label: String, fraction: Double)
        case ready(bytes: Int64)
        case downloading(fraction: Double)
        case saved([URL])
        case failed(String)
    }

    public private(set) var phase: Phase = .checking
    public let serverFqdn: String
    /// The suggested passcode (five groups of four).
    public let suggestedPasscode: String
    /// The user typed their own instead.
    public var useOwnPasscode = false
    public var ownPasscode = ""
    public var ownPasscodeAgain = ""
    /// "I've saved the passcode somewhere safe."
    public var passcodeSaved = false
    /// Apps the backup couldn't include (no source to rebuild from), by name.
    public var leftOut: [String] { status?.left?.map(\.name) ?? [] }

    private let clients: PodScreensClientFactory
    private let accountKek: @Sendable (String) async throws -> Data
    private let passcodeSlot: @Sendable (String, Data, String) async throws -> ServerBackupSlot
    private let pollNs: UInt64
    private let directory: URL
    private var status: ServerArchiveStatus?

    public init(
        serverFqdn: String,
        clients: PodScreensClientFactory,
        accountKek: (@Sendable (String) async throws -> Data)? = nil,
        passcodeSlot: (@Sendable (String, Data, String) async throws -> ServerBackupSlot)? = nil,
        suggestedPasscode: String = ServerBackupFormat.generatePasscode(),
        pollNs: UInt64 = 1_500_000_000,
        directory: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("server-backups", isDirectory: true)
    ) {
        self.serverFqdn = serverFqdn.lowercased()
        self.clients = clients
        self.accountKek = accountKek ?? { id in
            try await Keystore.deriveServerArchiveKey(archiveId: id, reason: "Back up \(serverFqdn)")
        }
        self.passcodeSlot = passcodeSlot ?? { id, key, passcode in
            try await Task.detached(priority: .userInitiated) {
                try ServerBackupPasscode.slot(archiveId: id, contentKey: key, passcode: passcode)
            }.value
        }
        self.suggestedPasscode = suggestedPasscode
        self.pollNs = pollNs
        self.directory = directory
    }

    public var isBusy: Bool {
        switch phase {
        case .building, .downloading, .checking: return true
        default: return false
        }
    }

    /// The passcode the backup gets, or nil while the user's own isn't good yet.
    public var chosenPasscode: String? {
        guard useOwnPasscode else { return suggestedPasscode }
        guard ServerBackupFormat.passcodeProblem(ownPasscode) == nil, ownPasscode == ownPasscodeAgain else { return nil }
        return ownPasscode
    }

    /// What's wrong with the user's own passcode, for the line under the fields.
    public var ownPasscodeHint: String? {
        guard useOwnPasscode else { return nil }
        if ownPasscode.isEmpty { return "At least 12 characters with three kinds (lowercase, uppercase, digits, symbols), or 20 of anything." }
        if let p = ServerBackupFormat.passcodeProblem(ownPasscode) { return p }
        if !ownPasscodeAgain.isEmpty && ownPasscodeAgain != ownPasscode { return "The two don't match." }
        return nil
    }

    public var canStart: Bool { phase == .passcode && chosenPasscode != nil && passcodeSaved }

    /// First look: a backup already being made (the sheet was closed and
    /// reopened) is followed, one already made is offered; otherwise ask for
    /// the passcode.
    public func load() async {
        let c = await clients.client(forFqdn: serverFqdn)
        let current = try? await c.serverArchiveStatus()
        if let current, current.state == "building" || current.state == "ready" {
            await follow(c)
        } else {
            phase = .passcode
        }
    }

    /// Make the backup with the chosen passcode.
    public func start() async {
        guard canStart, let passcode = chosenPasscode else { return }
        phase = .building(label: "Protecting the backup with its passcode…", fraction: 0)
        let c = await clients.client(forFqdn: serverFqdn)
        do {
            let id = ServerArchive.newArchiveId()
            var contentKey = ServerBackupFormat.randomBytes(32)
            defer { contentKey.resetBytes(in: 0..<contentKey.count) }
            let account = try ServerBackupFormat.wrapAccountSlot(
                archiveId: id, contentKey: contentKey, kek: try await accountKek(id), nonce: ServerBackupFormat.randomBytes(12)
            )
            let pass = try await passcodeSlot(id, contentKey, passcode)
            try await c.serverArchiveStart(ServerArchiveStartRequest(archiveId: id, key: HexUtil.encode(contentKey), slots: [pass, account]))
        } catch is CancellationError {
            phase = .passcode
            return
        } catch {
            phase = .failed(Self.message(error))
            return
        }
        await follow(c)
    }

    private func follow(_ c: any ScreensClient) async {
        do {
            while true {
                guard let s = try await c.serverArchiveStatus() else { throw BackupError.vanished }
                if s.state == "failed" { throw BackupError.failed(s.reason ?? "the backup couldn't be made") }
                if s.state == "ready" {
                    status = s
                    phase = .ready(bytes: s.bytes ?? 0)
                    return
                }
                let p = s.progress
                let total = max(p?.total ?? 0, 0)
                phase = .building(
                    label: total > 0 ? "Backing up \(p?.app ?? "apps") (\(min((p?.done ?? 0) + 1, total)) of \(total))…" : "Making the backup…",
                    fraction: total > 0 ? Double(p?.done ?? 0) / Double(total) : 0
                )
                try await Task.sleep(nanoseconds: pollNs)
            }
        } catch is CancellationError {
            phase = .passcode
        } catch {
            phase = .failed(Self.message(error))
        }
    }

    /// Download both files for the share sheet: the small backup file, and
    /// the data file in 4 MiB parts, several at once, resuming an interrupted
    /// download and checking the server's SHA-256.
    public func download() async {
        guard case .ready = phase, let s = status, let total = s.bytes else { return }
        phase = .downloading(fraction: 0)
        let c = await clients.client(forFqdn: serverFqdn)
        let fm = FileManager.default
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let stem = ServerArchive.fileStem(sourceServer: serverFqdn, createdAt: Date(timeIntervalSince1970: Double(s.startedAt) / 1000))
        let part = directory.appendingPathComponent("\(s.archiveId).part")
        let state = directory.appendingPathComponent("\(s.archiveId).json")
        let dataURL = directory.appendingPathComponent(s.dataFileName ?? "\(stem).\(ServerBackupFormat.dataExtension)")
        let backupURL = directory.appendingPathComponent(s.backupFileName ?? "\(stem).\(ServerBackupFormat.backupExtension)")
        do {
            let backupFile = try await c.serverArchiveBackupFile()
            try await ArchiveDownloader.download(
                total: total,
                sha256: s.sha256,
                to: part,
                stateFile: state,
                fetch: { offset in try await c.serverArchiveChunk(offset: offset) },
                progress: { [weak self] received in
                    await MainActor.run {
                        guard let self, case .downloading = self.phase else { return }
                        self.phase = .downloading(fraction: total > 0 ? Double(received) / Double(total) : 1)
                    }
                }
            )
            try? fm.removeItem(at: dataURL)
            try fm.moveItem(at: part, to: dataURL)
            try backupFile.write(to: backupURL, options: [.atomic, .completeFileProtection])
            try? await c.serverArchiveForget()
            phase = .saved([backupURL, dataURL])
        } catch is CancellationError {
            // The parts already in stay for the next try.
            phase = .ready(bytes: total)
        } catch {
            phase = .failed(Self.message(error))
        }
    }

    public func tryAgain() {
        phase = .passcode
    }

    private enum BackupError: Error, LocalizedError {
        case vanished
        case failed(String)
        var errorDescription: String? {
            switch self {
            case .vanished: return "The backup disappeared from the server."
            case .failed(let why): return "The backup failed: \(why)."
            }
        }
    }

    static func message(_ error: Error) -> String {
        if let e = error as? BackupError { return e.errorDescription ?? "The backup failed." }
        if let e = error as? ArchiveDownloader.DownloadError { return e.errorDescription ?? "The download didn't finish." }
        return ScreensClientError.userFacing(error)
    }
}

/// Home → Add/Import a server → Import a backup, or a waiting server's "Send
/// the backup" (docs/server-backup-and-clone.md, "Restore a backup"): pick the
/// two files, open the backup (this account's key, else its passcode), check
/// the data file, pick a name, make the server with the existing create
/// screen, then wait for it and send it the backup.
@Observable
@MainActor
public final class ImportBackupViewModel {
    public enum Phase: Equatable {
        /// Pick the files (and say which one is still missing).
        case pick
        /// The account key didn't open it: ask for the passcode.
        case passcode
        case opening
        case checking(fraction: Double)
        /// A server of the account waits for this backup: send it there, or make a new one.
        case chooseTarget(fqdn: String)
        case name
        /// The create screen is up (`createTarget` holds what it needs).
        case creating
        case waiting(fqdn: String)
        case sending(fqdn: String, fraction: Double)
        case restoring(fqdn: String, apps: [ServerRestoreApp])
        case done(fqdn: String, apps: [ServerRestoreApp])
        /// `keepsWaiting`: the server stays waiting for its backup (send it again later).
        case failed(message: String, keepsWaiting: Bool)
    }

    /// What the create screen needs to make the server.
    public struct CreateTarget: Equatable, Sendable {
        public let name: String
        public let bootUnlockMode: String
        public let diskEncryption: String
        public let restore: CreateServerViewModel.RestoreTarget
    }

    public private(set) var phase: Phase = .pick
    public private(set) var backupFileName: String?
    public private(set) var dataFileName: String?
    public private(set) var dataFileSize: Int64?
    public private(set) var opened: ServerBackupFormat.Opened?
    public private(set) var fileError: String?
    public var passcode = ""
    public var name = ""
    public private(set) var createTarget: CreateTarget?
    public let targetFqdn: String?

    private let username: String
    private let takenNames: Set<String>
    private let waitingServers: [String: String]
    private let clients: PodScreensClientFactory
    private let accountKek: @Sendable (String) async throws -> Data
    private let openWithPasscode: @Sendable (ServerBackupFormat.File, String) async throws -> ServerBackupFormat.Opened
    private let onRestored: (String) -> Void
    private let pollNs: UInt64
    private var file: ServerBackupFormat.File?
    private var backupURL: URL?
    private var dataURL: URL?
    private var scoped: [URL] = []
    private var sendTask: Task<Void, Never>?

    /// - Parameters:
    ///   - takenNames: every server name the account uses (pending ones too).
    ///   - waitingServers: archive id → fqdn of the account's servers waiting for a backup.
    ///   - targetFqdn: opened from a waiting server's "Send the backup".
    ///   - onRestored: the server's backup is in (Home stops showing it waiting).
    public init(
        username: String,
        takenNames: Set<String>,
        waitingServers: [String: String] = [:],
        targetFqdn: String? = nil,
        clients: PodScreensClientFactory,
        accountKek: (@Sendable (String) async throws -> Data)? = nil,
        openWithPasscode: (@Sendable (ServerBackupFormat.File, String) async throws -> ServerBackupFormat.Opened)? = nil,
        onRestored: @escaping (String) -> Void = { _ in },
        pollNs: UInt64 = 5_000_000_000
    ) {
        self.username = username
        self.takenNames = Set(takenNames.map { $0.lowercased() })
        self.waitingServers = waitingServers
        self.targetFqdn = targetFqdn?.lowercased()
        self.clients = clients
        self.accountKek = accountKek ?? { id in
            try await Keystore.deriveServerArchiveKey(archiveId: id, reason: "Open the backup")
        }
        self.openWithPasscode = openWithPasscode ?? { file, passcode in
            try await ServerBackupPasscode.open(file, passcode: passcode)
        }
        self.onRestored = onRestored
        self.pollNs = pollNs
    }

    // MARK: Files

    /// The user picked one or both files (security-scoped URLs from the file importer).
    public func choose(_ urls: [URL]) async {
        fileError = nil
        for url in urls {
            let ok = url.startAccessingSecurityScopedResource()
            let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
            let head = (try? FileHandle(forReadingFrom: url)).flatMap { fh -> Data? in
                defer { try? fh.close() }
                return try? fh.read(upToCount: 64)
            } ?? Data()
            switch ServerBackupFormat.classify(head: head, size: size) {
            case .backup:
                do {
                    let parsed = try ServerBackupFormat.parse(try Data(contentsOf: url))
                    file = parsed
                    opened = nil
                    backupURL = url
                    backupFileName = url.lastPathComponent
                } catch {
                    fileError = (error as? LocalizedError)?.errorDescription ?? "That backup file couldn't be read."
                }
                if ok { scoped.append(url) }
            case .data:
                dataURL = url
                dataFileName = url.lastPathComponent
                dataFileSize = size
                if ok { scoped.append(url) }
            case nil:
                if ok { url.stopAccessingSecurityScopedResource() }
                fileError = "\(url.lastPathComponent) isn't a Flagship backup file or data file."
            }
        }
        await advance()
    }

    /// The line under the picker: what's picked, and what's still missing.
    public var filesSummary: String {
        let b = backupFileName.map { "Backup file: \($0)" } ?? "Backup file: not picked yet"
        let want = opened?.body.data.fileName
        let d = dataFileName.map { "Data file: \($0) (\(ServerArchive.formatBytes(dataFileSize ?? 0)))" }
            ?? "Data file: not picked yet\(want.map { " (\($0))" } ?? "")"
        return "\(b)\n\(d)"
    }

    /// One line on what the backup holds, once it is open.
    public var summary: String? {
        guard let body = opened?.body else { return nil }
        let when = Date(timeIntervalSince1970: Double(body.createdAt) / 1000).formatted(date: .abbreviated, time: .shortened)
        let apps = body.apps.isEmpty ? "no apps" : body.apps.map(\.name).joined(separator: ", ")
        let left = body.left.isEmpty ? "" : " Not in this backup: \(body.left.map(\.name).joined(separator: ", "))."
        return "From \(body.server.domain), saved \(when): \(apps).\(left)"
    }

    /// What the new server copies from the backup.
    public var settingsLine: String? {
        guard let s = opened?.body.server else { return nil }
        let unlock = s.bootUnlockMode == "approve" ? "asks your phone at every start" : "unlocks on its own after the first start"
        let disk = s.diskEncryption == "none" ? "disk not encrypted" : "disk encrypted"
        return "Copied from the backup: \(unlock), \(disk)."
    }

    private func advance() async {
        guard let file else { phase = .pick; return }
        if opened == nil {
            phase = .opening
            if let key = try? await accountKek(file.archiveId),
               let o = try? ServerBackupFormat.openWithAccountKey(file, kek: key) {
                opened = o
            } else {
                phase = .passcode
                return
            }
        }
        await checkData()
    }

    /// Open with the passcode the user typed.
    public func unlock() async {
        guard let file, phase == .passcode, !passcode.isEmpty else { return }
        fileError = nil
        phase = .opening
        do {
            opened = try await openWithPasscode(file, passcode)
            passcode = ""
            await checkData()
        } catch {
            fileError = (error as? LocalizedError)?.errorDescription ?? "That passcode doesn't open this backup."
            phase = .passcode
        }
    }

    private func checkData() async {
        guard let opened else { return }
        guard let dataURL else {
            phase = .pick
            return
        }
        phase = .checking(fraction: 0)
        let total = Double(max(opened.body.data.bytes, 1))
        do {
            try await ServerBackupFormat.checkDataFile(dataURL, against: opened.body.data) { [weak self] read in
                await MainActor.run { self?.phase = .checking(fraction: Double(read) / total) }
            }
        } catch {
            self.dataURL = nil
            dataFileName = nil
            fileError = (error as? LocalizedError)?.errorDescription ?? "The data file couldn't be checked."
            phase = .pick
            return
        }
        if let fqdn = targetFqdn ?? waitingServers[opened.file.archiveId] {
            phase = .chooseTarget(fqdn: fqdn)
        } else {
            showName()
        }
    }

    // MARK: Name and create

    /// The name the form starts with: the saved server's, unless the account uses it.
    public static func suggestedName(saved: String, taken: Set<String>) -> String {
        let n = saved.lowercased()
        return ServerLabel.isValid(n) && !taken.contains(n) ? n : ""
    }

    /// Why `name` can't be used, or nil (checked as the user types).
    public var nameProblem: String? {
        let n = name.trimmingCharacters(in: .whitespaces).lowercased()
        if n.isEmpty {
            if let saved = opened?.body.server.name, takenNames.contains(saved.lowercased()) {
                return "You already have a server called \"\(saved)\": pick another name."
            }
            return nil
        }
        if let e = ServerLabel.errorMessage(n) { return e }
        if takenNames.contains(n) { return "You already have a server called \"\(n)\"." }
        return nil
    }

    public var canCreate: Bool {
        phase == .name && !name.trimmingCharacters(in: .whitespaces).isEmpty && nameProblem == nil
    }

    public var previewFqdn: String {
        Endpoints.serverFqdn(server: ServerLabel.normalized(name.isEmpty ? "home" : name), user: username)
    }

    public func showName() {
        guard let opened else { return }
        if name.isEmpty { name = Self.suggestedName(saved: opened.body.server.name, taken: takenNames) }
        phase = .name
    }

    /// Hand over to the create screen with the backup's settings.
    public func create() {
        guard canCreate, let opened else { return }
        createTarget = CreateTarget(
            name: ServerLabel.normalized(name),
            bootUnlockMode: opened.body.server.bootUnlockMode,
            diskEncryption: opened.body.server.diskEncryption,
            restore: .init(archiveId: opened.file.archiveId, bytes: opened.body.data.bytes, sha256: opened.body.data.sha256)
        )
        phase = .creating
    }

    /// Back from the create screen without a server.
    public func cancelCreate() {
        createTarget = nil
        phase = .name
    }

    // MARK: Send

    /// The recipe is out (or the user chose a waiting server): wait for the
    /// server, then send it the backup. Runs until it ends or `stop()`.
    public func send(to fqdn: String) {
        sendTask?.cancel()
        let target = fqdn.lowercased()
        if case .creating = phase {} else { phase = .waiting(fqdn: target) }
        sendTask = Task { await self.run(target) }
    }

    /// Show the progress of a send that started under the create screen.
    public func leaveCreate(fqdn: String) {
        createTarget = nil
        if case .creating = phase { phase = .waiting(fqdn: fqdn.lowercased()) }
    }

    public func stop() {
        sendTask?.cancel()
        sendTask = nil
        for url in scoped { url.stopAccessingSecurityScopedResource() }
        scoped = []
    }

    private func setPhase(_ p: Phase) {
        // While the create screen is up its delivered page stays visible; the
        // send carries on underneath and shows once the user taps Done.
        if case .creating = phase, case .waiting = p { return }
        phase = p
    }

    private func run(_ fqdn: String) async {
        guard let opened, let dataURL else { return }
        let c = await clients.client(forFqdn: fqdn)
        do {
            // Wait for the server to come online, pair with this device, and say
            // it waits for this backup.
            while true {
                try Task.checkCancellation()
                if let st = try? await c.serverRestoreStatus() {
                    if st.waiting?.archiveId == opened.file.archiveId {
                        if let r = st.restore, ["checking", "restoring"].contains(r.state) { break }
                        try await upload(c, fqdn: fqdn, dataURL: dataURL, opened: opened)
                        try await c.serverRestoreCommit(ServerRestoreCommitRequest(key: HexUtil.encode(opened.contentKey)))
                        break
                    }
                    if st.waiting == nil, st.restore?.state == "done" { break }
                    if let w = st.waiting, w.archiveId != opened.file.archiveId {
                        throw ImportError.otherBackup
                    }
                }
                setPhase(.waiting(fqdn: fqdn))
                try await Task.sleep(nanoseconds: pollNs)
            }
            setPhase(.restoring(fqdn: fqdn, apps: []))
            while true {
                try Task.checkCancellation()
                let st = try await c.serverRestoreStatus()
                guard let r = st.restore else { throw ImportError.vanished }
                if r.state == "failed" { throw ImportError.failed(r.reason ?? "unknown reason") }
                if r.state == "done" {
                    onRestored(fqdn)
                    phase = .done(fqdn: fqdn, apps: r.apps)
                    return
                }
                setPhase(.restoring(fqdn: fqdn, apps: r.apps))
                try await Task.sleep(nanoseconds: min(pollNs, 2_000_000_000))
            }
        } catch is CancellationError {
            return
        } catch {
            phase = .failed(message: Self.message(error), keepsWaiting: true)
        }
    }

    private func upload(_ c: any ScreensClient, fqdn: String, dataURL: URL, opened: ServerBackupFormat.Opened) async throws {
        let size = opened.body.data.bytes
        guard let fh = try? FileHandle(forReadingFrom: dataURL) else { throw ImportError.unreadable }
        defer { try? fh.close() }
        var offset = try await c.serverRestoreStart(ServerRestoreStartRequest(archiveId: opened.file.archiveId, bytes: size)).received
        var retries = 0
        setPhase(.sending(fqdn: fqdn, fraction: Double(offset) / Double(max(size, 1))))
        while offset < size {
            try Task.checkCancellation()
            let chunk: Data
            do {
                try fh.seek(toOffset: UInt64(offset))
                guard let d = try fh.read(upToCount: ServerArchive.uploadChunkBytes), !d.isEmpty else { throw ImportError.unreadable }
                chunk = d
            } catch {
                throw ImportError.unreadable
            }
            do {
                try await c.serverRestoreChunk(offset: offset, data: chunk)
                offset += Int64(chunk.count)
                retries = 0
            } catch {
                // Ask the server where it has got to and go on from there.
                retries += 1
                if retries > 5 { throw error }
                try await Task.sleep(nanoseconds: 1_000_000_000)
                offset = try await c.serverRestoreStart(ServerRestoreStartRequest(archiveId: opened.file.archiveId, bytes: size)).received
            }
            setPhase(.sending(fqdn: fqdn, fraction: Double(offset) / Double(max(size, 1))))
        }
    }

    public static func describe(_ a: ServerRestoreApp) -> String {
        switch a.state {
        case "done": return "\(a.name): restored"
        case "skipped": return "\(a.name): skipped (\(a.reason ?? "already here"))"
        case "failed": return "\(a.name): couldn't be restored (\(a.reason ?? "unknown reason"))"
        case "restoring": return "\(a.name): restoring…"
        default: return "\(a.name): waiting"
        }
    }

    private enum ImportError: Error, LocalizedError {
        case unreadable, vanished, otherBackup
        case failed(String)
        var errorDescription: String? {
            switch self {
            case .unreadable: return "The data file can't be read any more (was its drive removed?)."
            case .vanished: return "The restore disappeared from the server."
            case .otherBackup: return "That server is waiting for a different backup."
            case .failed(let why): return "The restore failed: \(why)."
            }
        }
    }

    static func message(_ error: Error) -> String {
        if let e = error as? ImportError { return e.errorDescription ?? "The restore failed." }
        return ScreensClientError.userFacing(error)
    }
}

/// The browser download page's QR: approve downloading that server's backup in
/// that browser. Shows the page's 6-digit code; Face ID unlocks the
/// sensitive-order key that signs `flagship/archive-download/v1`, which the
/// server checks before it serves the files (docs/server-backup-and-clone.md).
@Observable
@MainActor
public final class BackupDownloadApprovalViewModel {
    public enum Phase: Equatable {
        case idle
        case working
        case approved
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    public let serverFqdn: String
    public let archiveId: String
    public let requestId: String
    public var code: String { ArchiveDownloadApproval.code(requestId: requestId) }

    private let clients: PodScreensClientFactory
    private let signer: @Sendable (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64

    public init(
        serverFqdn: String,
        archiveId: String,
        requestId: String,
        clients: PodScreensClientFactory,
        signer: (@Sendable (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.serverFqdn = serverFqdn.lowercased()
        self.archiveId = archiveId
        self.requestId = requestId
        self.clients = clients
        self.signer = signer ?? { reason in try await Keystore.sensitiveOrderSigningKey(reason: reason) }
        self.now = now
    }

    public func approve() async {
        guard phase != .working, phase != .approved else { return }
        phase = .working
        do {
            let key = try await signer("Approve downloading the backup of \(serverFqdn)")
            let approval = ArchiveDownloadApproval(serverDomain: serverFqdn, archiveId: archiveId, requestId: requestId, issuedAt: now())
            let signature = try key.signature(for: approval.canonicalBytes())
            let c = await clients.client(forFqdn: serverFqdn)
            try await c.serverArchiveApprove(ServerArchiveApproveRequest(approval: approval, signature: HexUtil.encode(signature)))
            phase = .approved
        } catch {
            phase = .failed(ScreensClientError.userFacing(error))
        }
    }
}
