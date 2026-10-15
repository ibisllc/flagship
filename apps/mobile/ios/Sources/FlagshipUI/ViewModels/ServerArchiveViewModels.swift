import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// "Backup/clone server" on a server's page: the box seals a backup of all its
/// apps with a key this device derives, this device downloads it in chunks to a
/// file, and the user saves it wherever they like (docs/server-backup-and-clone.md).
@Observable
@MainActor
public final class ServerBackupViewModel {
    public enum Phase: Equatable {
        case idle
        case building(label: String, fraction: Double)
        case ready(bytes: Int64)
        case downloading(fraction: Double)
        case saved(URL)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    public let serverFqdn: String
    /// Apps the backup couldn't include (no source to rebuild from), by name.
    public var leftOut: [String] { status?.left?.map(\.name) ?? [] }

    private let clients: PodScreensClientFactory
    private let keyProvider: @Sendable (String) async throws -> Data
    private let pollNs: UInt64
    private let directory: URL
    private var status: ServerArchiveStatus?

    public init(
        serverFqdn: String,
        clients: PodScreensClientFactory,
        keyProvider: (@Sendable (String) async throws -> Data)? = nil,
        pollNs: UInt64 = 1_500_000_000,
        directory: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("server-backups", isDirectory: true)
    ) {
        self.serverFqdn = serverFqdn.lowercased()
        self.clients = clients
        self.keyProvider = keyProvider ?? { id in
            try await Keystore.deriveServerArchiveKey(archiveId: id, reason: "Back up \(serverFqdn)")
        }
        self.pollNs = pollNs
        self.directory = directory
    }

    public var isBusy: Bool {
        switch phase {
        case .building, .downloading: return true
        default: return false
        }
    }

    /// Ask the server to make the backup and wait for it.
    public func start() async {
        guard !isBusy else { return }
        phase = .building(label: "Making the backup…", fraction: 0)
        let c = await clients.client(forFqdn: serverFqdn)
        do {
            // One already being made (the sheet was closed and reopened): follow it.
            // One already made whose download was interrupted here: resume it.
            let current = try? await c.serverArchiveStatus()
            if let current, current.state == "ready", let bytes = current.bytes,
               FileManager.default.fileExists(atPath: directory.appendingPathComponent("\(current.archiveId).json").path) {
                status = current
                phase = .ready(bytes: bytes)
                return
            }
            if current?.state != "building" {
                let id = ServerArchive.newArchiveId()
                let key = try await keyProvider(id)
                try await c.serverArchiveStart(ServerArchiveStartRequest(archiveId: id, key: HexUtil.encode(key)))
            }
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
            phase = .idle
        } catch {
            phase = .failed(Self.message(error))
        }
    }

    /// Download the ready backup to a file the share sheet can save: 4 MiB
    /// parts, several at once, each written straight to the file; an
    /// interrupted download resumes from the parts already in, and the result
    /// is checked against the server's SHA-256.
    public func download() async {
        guard case .ready = phase, let s = status, let total = s.bytes else { return }
        phase = .downloading(fraction: 0)
        let c = await clients.client(forFqdn: serverFqdn)
        let fm = FileManager.default
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let part = directory.appendingPathComponent("\(s.archiveId).part")
        let state = directory.appendingPathComponent("\(s.archiveId).json")
        let final = directory.appendingPathComponent(
            ServerArchive.fileName(sourceServer: serverFqdn, createdAt: Date(timeIntervalSince1970: Double(s.startedAt) / 1000))
        )
        do {
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
            try? fm.removeItem(at: final)
            try fm.moveItem(at: part, to: final)
            try? await c.serverArchiveForget()
            phase = .saved(final)
        } catch is CancellationError {
            // The parts already in stay for the next try.
            phase = .ready(bytes: total)
        } catch {
            phase = .failed(Self.message(error))
        }
    }

    private enum BackupError: Error, LocalizedError {
        case vanished, empty, wrongSize
        case failed(String)
        var errorDescription: String? {
            switch self {
            case .vanished: return "The backup disappeared from the server."
            case .empty: return "The server sent an empty piece of the backup."
            case .wrongSize: return "The backup arrived with the wrong size."
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

/// Home → Add/Import a server → Import a backup: pick the file, pick the
/// server to import onto, send it, and watch the apps come back.
@Observable
@MainActor
public final class ImportBackupViewModel {
    public struct Target: Identifiable, Equatable, Sendable {
        public let fqdn: String
        public let label: String
        public var id: String { fqdn }
        public init(fqdn: String, label: String) {
            self.fqdn = fqdn
            self.label = label
        }
    }

    public enum Phase: Equatable {
        case picking
        case chosen(ServerArchive.Header, bytes: Int64)
        case uploading(fraction: Double)
        case restoring([ServerRestoreApp])
        case done([ServerRestoreApp])
        case failed(String)
    }

    public private(set) var phase: Phase = .picking
    public let targets: [Target]
    public var selectedFqdn: String?
    public private(set) var fileError: String?

    private let clients: PodScreensClientFactory
    private let keyProvider: @Sendable (String) async throws -> Data
    private let pollNs: UInt64
    private var fileURL: URL?

    public init(
        targets: [Target],
        clients: PodScreensClientFactory,
        keyProvider: (@Sendable (String) async throws -> Data)? = nil,
        pollNs: UInt64 = 2_000_000_000
    ) {
        self.targets = targets
        self.selectedFqdn = targets.first?.fqdn
        self.clients = clients
        self.keyProvider = keyProvider ?? { id in
            try await Keystore.deriveServerArchiveKey(archiveId: id, reason: "Import a server backup")
        }
        self.pollNs = pollNs
    }

    public var canImport: Bool {
        if case .chosen = phase, selectedFqdn != nil { return true }
        return false
    }

    public var isBusy: Bool {
        switch phase {
        case .uploading, .restoring: return true
        default: return false
        }
    }

    /// The user picked a file (a security-scoped URL from the file importer).
    public func choose(_ url: URL) {
        fileError = nil
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let fh = try FileHandle(forReadingFrom: url)
            defer { try? fh.close() }
            let head = try fh.read(upToCount: ServerArchive.headerMaxBytes) ?? Data()
            let header = try ServerArchive.parseHeader(head)
            let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
            fileURL = url
            phase = .chosen(header, bytes: size)
        } catch let e as ServerArchive.HeaderError {
            fileError = e.errorDescription
            phase = .picking
        } catch {
            fileError = "That file couldn't be read."
            phase = .picking
        }
    }

    public func startImport() async {
        guard canImport, case .chosen(let header, let size) = phase, let fqdn = selectedFqdn, let url = fileURL else { return }
        phase = .uploading(fraction: 0)
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let c = await clients.client(forFqdn: fqdn)
        do {
            try await c.serverRestoreStart(ServerRestoreStartRequest(archiveId: header.archiveId, bytes: size))
            let fh = try FileHandle(forReadingFrom: url)
            defer { try? fh.close() }
            var offset: Int64 = 0
            while offset < size {
                guard let chunk = try fh.read(upToCount: ServerArchive.uploadChunkBytes), !chunk.isEmpty else { break }
                try await c.serverRestoreChunk(offset: offset, data: chunk)
                offset += Int64(chunk.count)
                phase = .uploading(fraction: Double(offset) / Double(size))
            }
            guard offset == size else { throw ImportError.unreadable }
            let key = try await keyProvider(header.archiveId)
            try await c.serverRestoreCommit(ServerRestoreCommitRequest(key: HexUtil.encode(key)))
            phase = .restoring([])
            while true {
                try await Task.sleep(nanoseconds: pollNs)
                guard let s = try await c.serverRestoreStatus() else { throw ImportError.vanished }
                if s.state == "failed" { throw ImportError.failed(s.reason ?? "unknown reason") }
                if s.state == "done" {
                    phase = .done(s.apps)
                    return
                }
                phase = .restoring(s.apps)
            }
        } catch is CancellationError {
            phase = .chosen(header, bytes: size)
        } catch {
            phase = .failed(Self.message(error))
        }
    }

    /// Back to the chosen file after a failure, so the user can retry.
    public func retry() {
        fileError = nil
        phase = .picking
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
        case unreadable, vanished
        case failed(String)
        var errorDescription: String? {
            switch self {
            case .unreadable: return "The backup file couldn't be read all the way through."
            case .vanished: return "The import disappeared from the server."
            case .failed(let why): return "The import failed: \(why)."
            }
        }
    }

    static func message(_ error: Error) -> String {
        if let e = error as? ImportError { return e.errorDescription ?? "The import failed." }
        return ScreensClientError.userFacing(error)
    }
}

/// The browser download page's QR: approve downloading that server's backup in
/// that browser. Shows the page's 6-digit code; Face ID unlocks the
/// sensitive-order key that signs `flagship/archive-download/v1`, which the
/// server checks before it serves the file (docs/server-backup-and-clone.md).
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
