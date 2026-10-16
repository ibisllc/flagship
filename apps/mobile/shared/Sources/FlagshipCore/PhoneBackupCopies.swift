import Foundation
import FlagshipAPI

/// The copies of each server's newest backup this phone keeps
/// (docs/server-backup-and-clone.md, "Backup policy": phone-side). One
/// `.flagship` file per backup under `<root>/<server>/<archiveId>/`, kept out
/// of iCloud/device backups, readable after the first unlock so the
/// background fetch can write while the phone is locked and charging. A copy
/// is only ever downloaded: nothing is opened here, so no key is needed.
public final class PhoneBackupStore: @unchecked Sendable {
    public static let shared = PhoneBackupStore()

    public struct Copy: Codable, Equatable, Sendable {
        public let archiveId: String
        public let createdAt: Int64
        public let bytes: Int64
        public let fileName: String
    }

    /// What the phone knows of a server it keeps copies for.
    public struct Server: Codable, Equatable, Sendable {
        public var fqdn: String
        /// `unset` | `phone` | `peer` | `none`
        public var policy: String
        public var reserveBytes: Int64
        public init(fqdn: String, policy: String, reserveBytes: Int64) {
            self.fqdn = fqdn
            self.policy = policy
            self.reserveBytes = reserveBytes
        }
        /// Only phone-side servers (and those with no policy yet) have a copy here.
        public var wantsCopy: Bool { policy == "phone" || policy == "unset" }
    }

    public let root: URL
    private let defaults: UserDefaults
    private let lock = NSLock()
    private static let serversKey = "flagship.phoneBackup.servers"
    private static let offKey = "flagship.phoneBackup.off"
    private static let skipKey = "flagship.phoneBackup.skip"

    public init(root: URL? = nil, defaults: UserDefaults = .standard) {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Backups", isDirectory: true)
        self.defaults = defaults
    }

    // MARK: Servers and settings

    public var servers: [Server] {
        lock.withLock {
            (defaults.data(forKey: Self.serversKey)).flatMap { try? JSONDecoder().decode([Server].self, from: $0) } ?? []
        }
    }

    /// Remember a server and its policy (the Backups section calls this each time it loads).
    public func remember(_ server: Server) {
        lock.withLock {
            var list = (defaults.data(forKey: Self.serversKey)).flatMap { try? JSONDecoder().decode([Server].self, from: $0) } ?? []
            let key = server.fqdn.lowercased()
            list.removeAll { $0.fqdn.lowercased() == key }
            list.append(Server(fqdn: key, policy: server.policy, reserveBytes: server.reserveBytes))
            defaults.set(try? JSONEncoder().encode(list), forKey: Self.serversKey)
        }
    }

    /// "Keep a copy on this phone" (on unless turned off).
    public func keepsCopy(_ fqdn: String) -> Bool {
        !(defaults.stringArray(forKey: Self.offKey) ?? []).contains(fqdn.lowercased())
    }

    public func setKeepsCopy(_ on: Bool, for fqdn: String) {
        var off = Set(defaults.stringArray(forKey: Self.offKey) ?? [])
        if on { off.remove(fqdn.lowercased()) } else { off.insert(fqdn.lowercased()) }
        defaults.set(Array(off).sorted(), forKey: Self.offKey)
        if !on { try? FileManager.default.removeItem(at: dir(fqdn)) }
    }

    /// Why the last run kept no new copy (e.g. not enough space), or nil.
    public func skipSentence(_ fqdn: String) -> String? {
        (defaults.dictionary(forKey: Self.skipKey) as? [String: String])?[fqdn.lowercased()]
    }

    func setSkipSentence(_ s: String?, for fqdn: String) {
        var map = (defaults.dictionary(forKey: Self.skipKey) as? [String: String]) ?? [:]
        map[fqdn.lowercased()] = s
        defaults.set(map, forKey: Self.skipKey)
    }

    // MARK: Copies

    func dir(_ fqdn: String) -> URL { root.appendingPathComponent(fqdn.lowercased(), isDirectory: true) }
    func dir(_ fqdn: String, _ archiveId: String) -> URL { dir(fqdn).appendingPathComponent(archiveId, isDirectory: true) }

    /// The finished copies of a server's backups, newest first.
    public func copies(_ fqdn: String) -> [Copy] {
        let fm = FileManager.default
        guard let ids = try? fm.contentsOfDirectory(atPath: dir(fqdn).path) else { return [] }
        return ids.compactMap { id -> Copy? in
            guard let data = fm.contents(atPath: dir(fqdn, id).appendingPathComponent("copy.json").path),
                  let c = try? JSONDecoder().decode(Copy.self, from: data),
                  fm.fileExists(atPath: dir(fqdn, id).appendingPathComponent(c.fileName).path) else { return nil }
            return c
        }.sorted { $0.createdAt > $1.createdAt }
    }

    public func url(of copy: Copy, server fqdn: String) -> URL {
        dir(fqdn, copy.archiveId).appendingPathComponent(copy.fileName)
    }

    /// Prepare the folders (out of device backups: the server holds the originals).
    func prepare(_ fqdn: String, _ archiveId: String) throws -> URL {
        let fm = FileManager.default
        let d = dir(fqdn, archiveId)
        try fm.createDirectory(at: d, withIntermediateDirectories: true,
                               attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var r = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? r.setResourceValues(values)
        return d
    }

    func commit(_ copy: Copy, server fqdn: String) throws {
        let d = dir(fqdn, copy.archiveId)
        try JSONEncoder().encode(copy).write(to: d.appendingPathComponent("copy.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// Keep the newest copy, and the one before only while both fit the reserve; drop the rest
    /// (and any unfinished download of a backup that is no longer the newest).
    func prune(_ fqdn: String, reserveBytes: Int64?, keepingDownload: String?) {
        let fm = FileManager.default
        let all = copies(fqdn)
        let keep = PhoneBackupRetention.keep(all.map { .init(archiveId: $0.archiveId, createdAt: $0.createdAt, bytes: $0.bytes) },
                                             reserveBytes: reserveBytes)
        let ids = (try? fm.contentsOfDirectory(atPath: dir(fqdn).path)) ?? []
        for id in ids where !keep.contains(id) && id != keepingDownload {
            try? fm.removeItem(at: dir(fqdn, id))
        }
    }

    /// Free space on the volume holding the copies (the phone passes its
    /// "important usage" figure where it has one).
    public func freeBytes() -> Int64 {
        let probe = FileManager.default.fileExists(atPath: root.path) ? root : root.deletingLastPathComponent()
        let v = try? probe.resourceValues(forKeys: [.volumeAvailableCapacityKey])
        return Int64(v?.volumeAvailableCapacity ?? 0)
    }
}

/// One background pass (the BGProcessingTask): for each phone-side server,
/// fetch its newest saved backup if this phone doesn't have it yet, resuming
/// an interrupted download, and keep at most two copies within the reserve.
public enum PhoneBackupFetcher {
    public enum Outcome: Equatable, Sendable {
        case upToDate
        case downloaded(archiveId: String)
        case skipped(String)
        case off
        case failed(String)
    }

    public static func runOnce(
        store: PhoneBackupStore = .shared,
        clients: PodScreensClientFactory,
        freeBytes: (() -> Int64)? = nil
    ) async -> [String: Outcome] {
        var out: [String: Outcome] = [:]
        for server in store.servers {
            if Task.isCancelled { break }
            out[server.fqdn] = await runOne(server, store: store, clients: clients, freeBytes: freeBytes ?? store.freeBytes)
        }
        return out
    }

    public static func runOne(
        _ remembered: PhoneBackupStore.Server,
        store: PhoneBackupStore,
        clients: PodScreensClientFactory,
        freeBytes: () -> Int64
    ) async -> Outcome {
        let fqdn = remembered.fqdn
        guard store.keepsCopy(fqdn) else { return .off }
        let client = await clients.client(forFqdn: fqdn)
        var server = remembered
        if let p = try? await client.backupPolicy() {
            server.policy = p.policy.policy
            server.reserveBytes = p.policy.phoneReserveBytes
            store.remember(server)
        }
        guard server.wantsCopy else { return .off }
        let view: SavedBackupsView
        do { view = try await client.savedBackups() } catch { return .failed(BoxSentence.of(error)) }
        guard let newest = view.backups.first else { return .upToDate }
        let reserve: Int64? = server.policy == "phone" && server.reserveBytes > 0 ? server.reserveBytes : nil
        if store.copies(fqdn).contains(where: { $0.archiveId == newest.archiveId }) {
            store.prune(fqdn, reserveBytes: reserve, keepingDownload: nil)
            return .upToDate
        }
        guard PhoneBackupRetention.fits(bytes: newest.fileBytes, freeBytes: freeBytes()) else {
            let s = PhoneBackupRetention.needsSpaceSentence(bytes: newest.fileBytes)
            store.setSkipSentence(s, for: fqdn)
            return .skipped(s)
        }
        do {
            let d = try store.prepare(fqdn, newest.archiveId)
            _ = try await ArchiveDownloader.downloadBundle(
                client: client, route: .saved(archiveId: newest.archiveId), bytes: newest.fileBytes,
                sha256: newest.bundleSha256, fileName: newest.fileName, into: d,
                protection: .completeUntilFirstUserAuthentication)
            try store.commit(.init(archiveId: newest.archiveId, createdAt: newest.createdAt, bytes: newest.fileBytes,
                                   fileName: newest.fileName), server: fqdn)
            store.setSkipSentence(nil, for: fqdn)
            store.prune(fqdn, reserveBytes: reserve, keepingDownload: nil)
            return .downloaded(archiveId: newest.archiveId)
        } catch is CancellationError {
            // The parts already in stay for the next run.
            return .failed("Stopped; it goes on next time.")
        } catch {
            store.prune(fqdn, reserveBytes: reserve, keepingDownload: newest.archiveId)
            if let e = error as? LocalizedError, let d = e.errorDescription, !(error is ScreensClientError) { return .failed(d) }
            return .failed(BoxSentence.of(error))
        }
    }
}
