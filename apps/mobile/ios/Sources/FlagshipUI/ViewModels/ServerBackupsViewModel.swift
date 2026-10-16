import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// The server page's Backups section (docs/server-backup-and-clone.md,
/// "Backup policy" and "Scheduled backups"): the policy and the size limit it
/// sets, the schedule, the saved backups (download, delete), Back up now into
/// the list, and the copy this phone keeps. Changes are admin-only; reading
/// and downloading aren't.
@Observable
@MainActor
public final class ServerBackupsViewModel {
    public enum Load: Equatable {
        case loading
        case loaded
        /// The box has no saved backups (an older release): nothing to show.
        case unavailable
        case failed(String)
    }

    public enum DownloadState: Equatable {
        case downloading(Double)
        case done(URL)
        case failed(String)
    }

    public let serverFqdn: String
    public let isAdminDevice: Bool
    public private(set) var load: Load = .loading
    public private(set) var saved: SavedBackupsView?
    public private(set) var policy: BackupPolicyView?
    /// The box's sentence for the last refused action.
    public private(set) var actionError: String?
    public private(set) var policyError: String?
    public private(set) var scheduleError: String?
    public private(set) var approving = false
    public private(set) var startingRun = false
    public private(set) var savingSchedule = false
    public private(set) var savingPolicy = false
    public private(set) var downloads: [String: DownloadState] = [:]
    /// This phone's copy (phone-side policy).
    public private(set) var phoneCopy: PhoneBackupStore.Copy?
    public private(set) var phoneCopyURL: URL?
    public var keepCopyOnPhone: Bool {
        didSet {
            guard keepCopyOnPhone != oldValue else { return }
            phoneStore.setKeepsCopy(keepCopyOnPhone, for: serverFqdn)
            refreshPhoneCopy()
        }
    }

    private let clients: PodScreensClientFactory
    private let mintKeys: @Sendable (Int, String) async throws -> ([ArchiveKey], Curve25519.Signing.PrivateKey)
    private let canMintSilently: @Sendable () -> Bool
    private let policySigner: @Sendable (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64
    private let pollNs: UInt64
    private let directory: URL
    private let phoneStore: PhoneBackupStore
    private var pollTask: Task<Void, Never>?
    /// One silent deposit attempt per page open.
    private var triedSilentDeposit = false

    public static let adminOnly = AdminOrderGate.server
    public static let oneFileNote =
        "Each backup is one .flagship file. Import a backup on Home restores it. It opens on your own devices without a passcode."

    public init(
        serverFqdn: String,
        isAdminDevice: Bool,
        clients: PodScreensClientFactory,
        mintKeys: (@Sendable (Int, String) async throws -> ([ArchiveKey], Curve25519.Signing.PrivateKey))? = nil,
        canMintSilently: (@Sendable () -> Bool)? = nil,
        policySigner: (@Sendable (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
        pollNs: UInt64 = 2_000_000_000,
        directory: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("saved-backups", isDirectory: true),
        phoneStore: PhoneBackupStore = .shared
    ) {
        self.serverFqdn = serverFqdn.lowercased()
        self.isAdminDevice = isAdminDevice
        self.clients = clients
        self.mintKeys = mintKeys ?? { count, reason in
            let r = try await Keystore.mintServerArchiveKeys(count: count, reason: reason)
            return (r.keys, r.signer)
        }
        self.canMintSilently = canMintSilently ?? { Keystore.canMintServerArchiveKeysSilently }
        self.policySigner = policySigner ?? { reason in try await Keystore.sensitiveOrderSigningKey(reason: reason) }
        self.now = now
        self.pollNs = pollNs
        self.directory = directory
        self.phoneStore = phoneStore
        self.keepCopyOnPhone = phoneStore.keepsCopy(serverFqdn)
    }

    // MARK: Loading

    public func start() async {
        await reload()
        if isAdminDevice, !triedSilentDeposit, let s = saved, ArchiveKeys.shouldDeposit(isAdminDevice: true, keysWanted: s.keysWanted),
           canMintSilently() {
            triedSilentDeposit = true
            await depositKeys()
        }
    }

    public func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    public func reload() async {
        let c = await clients.client(forFqdn: serverFqdn)
        do {
            saved = try await c.savedBackups()
            load = .loaded
        } catch {
            if case ScreensClientError.http(404, _) = error {
                load = .unavailable
            } else if case ScreensClientError.notImplemented = error {
                load = .unavailable
            } else if saved == nil {
                load = .failed(BoxSentence.of(error))
            }
        }
        // An older box has no policy route: the section shows "Not chosen yet".
        if let p = try? await c.backupPolicy() { policy = p }
        rememberForPhone()
        refreshPhoneCopy()
        followRun()
    }

    private func followRun() {
        guard saved?.running != nil else { return }
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: self?.pollNs ?? 2_000_000_000)
                guard let self, !Task.isCancelled else { return }
                let c = await self.clients.client(forFqdn: self.serverFqdn)
                if let v = try? await c.savedBackups() { self.saved = v }
                if self.saved?.running == nil {
                    self.pollTask = nil
                    return
                }
            }
        }
    }

    // MARK: Keys

    /// The box wants keys and this device must ask for Face ID first: show the button.
    public var needsApproval: Bool {
        guard isAdminDevice, let s = saved else { return false }
        return ArchiveKeys.shouldDeposit(isAdminDevice: true, keysWanted: s.keysWanted)
    }

    /// Top the box's pool up: one approval for the whole batch.
    public func depositKeys() async {
        guard isAdminDevice, let s = saved, s.keysWanted > 0, !approving else { return }
        approving = true
        defer { approving = false }
        actionError = nil
        do {
            let count = ArchiveKeys.count(wanted: s.keysWanted)
            let (keys, signer) = try await mintKeys(count, "Approve backups for \(serverFqdn)")
            let deposit = try ArchiveKeys.deposit(serverDomain: serverFqdn, keys: keys, issuedAt: now())
            let sig = try signer.signature(for: try deposit.canonicalBytes())
            let c = await clients.client(forFqdn: serverFqdn)
            saved = try await c.savedBackupsDepositKeys(ArchiveKeysDepositRequest(deposit: deposit, signature: HexUtil.encode(sig), keys: keys))
        } catch is CancellationError {
        } catch {
            actionError = message(error)
        }
    }

    // MARK: Back up now

    public var canRun: Bool { isAdminDevice && saved?.running == nil && !startingRun }

    public func backUpNow() async {
        guard canRun else { return }
        startingRun = true
        defer { startingRun = false }
        actionError = nil
        let c = await clients.client(forFqdn: serverFqdn)
        do {
            _ = try await c.savedBackupsRun()
        } catch let e where BoxSentence.code(e) == "no-keys" && isAdminDevice {
            await depositKeys()
            guard actionError == nil else { return }
            do { _ = try await c.savedBackupsRun() } catch {
                actionError = message(error)
                return
            }
        } catch {
            actionError = message(error)
            return
        }
        if let v = try? await c.savedBackups() { saved = v }
        followRun()
    }

    // MARK: Schedule

    public struct ScheduleDraft: Equatable {
        public var frequency: String
        /// Local minute of the day.
        public var minute: Int
        /// Local weekday, 0 = Sunday.
        public var weekday: Int
        public var keepDaily: Int
        public var keepWeekly: Int
    }

    public func scheduleDraft(timeZone: TimeZone = .current) -> ScheduleDraft {
        let s = saved?.schedule ?? .boxDefault
        let local = BackupScheduleClock.toLocal(minuteOfDayUtc: s.minuteOfDayUtc, weekdayUtc: s.weekdayUtc, timeZone: timeZone,
                                                reference: Date(timeIntervalSince1970: Double(now()) / 1000))
        return ScheduleDraft(frequency: s.frequency, minute: local.minute, weekday: local.weekday, keepDaily: s.keepDaily, keepWeekly: s.keepWeekly)
    }

    /// What the box is sent for a draft made in local time.
    public func schedule(for d: ScheduleDraft, timeZone: TimeZone = .current) -> BackupSchedule {
        let u = BackupScheduleClock.toUtc(localMinute: d.minute, localWeekday: d.weekday, timeZone: timeZone,
                                          reference: Date(timeIntervalSince1970: Double(now()) / 1000))
        return BackupSchedule(frequency: d.frequency, minuteOfDayUtc: u.minuteOfDayUtc,
                              weekdayUtc: d.frequency == "weekly" ? u.weekdayUtc : (saved?.schedule.weekdayUtc ?? 0),
                              keepDaily: d.keepDaily, keepWeekly: d.keepWeekly)
    }

    @discardableResult
    public func saveSchedule(_ d: ScheduleDraft, timeZone: TimeZone = .current) async -> Bool {
        guard isAdminDevice else { return false }
        savingSchedule = true
        defer { savingSchedule = false }
        scheduleError = nil
        do {
            let c = await clients.client(forFqdn: serverFqdn)
            saved = try await c.savedBackupsSetSchedule(schedule(for: d, timeZone: timeZone))
            return true
        } catch {
            scheduleError = message(error)
            return false
        }
    }

    // MARK: Delete

    public func delete(_ b: SavedBackup) async {
        guard isAdminDevice else { return }
        actionError = nil
        do {
            let c = await clients.client(forFqdn: serverFqdn)
            saved = try await c.savedBackupDelete(archiveId: b.archiveId)
            downloads[b.archiveId] = nil
        } catch {
            actionError = message(error)
        }
    }

    // MARK: Download (any device of the owner)

    public func download(_ b: SavedBackup) async {
        if case .downloading = downloads[b.archiveId] { return }
        downloads[b.archiveId] = .downloading(0)
        let total = b.fileBytes
        do {
            let c = await clients.client(forFqdn: serverFqdn)
            let url = try await ArchiveDownloader.downloadBundle(
                client: c, route: .saved(archiveId: b.archiveId), bytes: total, sha256: b.bundleSha256,
                fileName: b.fileName, into: directory.appendingPathComponent(b.archiveId, isDirectory: true),
                progress: { [weak self] received in
                    await MainActor.run {
                        guard let self, case .downloading = self.downloads[b.archiveId] else { return }
                        self.downloads[b.archiveId] = .downloading(total > 0 ? Double(received) / Double(total) : 1)
                    }
                })
            // The server keeps its copy: saved backups go by the schedule's retention.
            downloads[b.archiveId] = .done(url)
        } catch is CancellationError {
            downloads[b.archiveId] = nil
        } catch {
            downloads[b.archiveId] = .failed(message(error))
        }
    }

    // MARK: Policy

    public var policyKind: String { policy?.policy.policy ?? "unset" }

    /// The draft value the shared picker uses.
    public var policyDraft: CreateServerDraftStore.BackupPolicy {
        switch policyKind {
        case "peer": return .peer
        case "none": return .none
        default: return .phoneOnly
        }
    }

    @discardableResult
    public func changePolicy(to draft: CreateServerDraftStore.BackupPolicy, reserveBytes: Int64) async -> Bool {
        guard isAdminDevice else { return false }
        savingPolicy = true
        defer { savingPolicy = false }
        policyError = nil
        do {
            let order = BackupPolicyOrder.make(serverDomain: serverFqdn, draft: draft, reserveBytes: reserveBytes, issuedAt: now())
            let key = try await policySigner("Change the backup policy of \(serverFqdn)")
            let sig = try key.signature(for: try order.canonicalBytes())
            let c = await clients.client(forFqdn: serverFqdn)
            policy = try await c.setBackupPolicy(BackupPolicyRequest(order: order, signatureHex: HexUtil.encode(sig)))
            if let v = try? await c.savedBackups() { saved = v }
            rememberForPhone()
            return true
        } catch is CancellationError {
            return false
        } catch {
            policyError = message(error)
            return false
        }
    }

    // MARK: Lines the section shows

    private func when(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .abbreviated, time: .shortened)
    }

    public static func policyName(_ p: String) -> String {
        switch p {
        case "phone": return "Phone-side backups"
        case "peer": return "Peer-distributed backups"
        case "none": return "No backups"
        default: return "Not chosen yet"
        }
    }

    /// "Backup policy: Phone-side backups · up to 32 GB".
    public var policyLine: String {
        guard let p = policy else { return "Backup policy: Not chosen yet" }
        let name = Self.policyName(p.policy.policy)
        if let limit = p.cap.limitBytes { return "Backup policy: \(name) · up to \(ServerArchive.formatBytes(limit))" }
        return "Backup policy: \(name)"
    }

    /// "Apps use 3.2 GB of 32 GB", or nil before the box has measured.
    public var usageLine: String? {
        guard let p = policy, let used = p.cap.usedBytes else { return nil }
        let u = ServerArchive.formatBytes(used)
        guard let limit = p.cap.limitBytes else { return "Apps use \(u)" }
        let l = ServerArchive.formatBytes(limit)
        return p.policy.policy == "peer" ? "Apps use \(u) of \(l) (a third of this server's disk)" : "Apps use \(u) of \(l)"
    }

    public var usageFraction: Double? {
        guard let p = policy, let used = p.cap.usedBytes, let limit = p.cap.limitBytes, limit > 0 else { return nil }
        return min(1, Double(used) / Double(limit))
    }

    public var overLimitLine: String? {
        guard let p = policy, p.cap.overLimit else { return nil }
        return p.cap.overReason.map(BoxSentence.display)
    }

    public var peerLines: [String] {
        guard policyKind == "peer", let peer = policy?.peer else { return [] }
        var out = ["Peer backups: \(Self.peerState(peer.state))" + (peer.reason.map { ". \(BoxSentence.display($0))" } ?? "")]
        if let healthy = peer.healthyBricks, let total = peer.totalBricks { out.append("\(healthy) of \(total) pieces safe") }
        if let n = peer.holders { out.append("Kept on \(n) other server\(n == 1 ? "" : "s")") }
        if let at = peer.lastPlacedAt { out.append("Last placed \(when(at))") }
        if let hosting = peer.hostingBytes { out.append("Holds \(ServerArchive.formatBytes(hosting)) for other servers") }
        return out
    }

    static func peerState(_ s: String) -> String {
        switch s {
        case "waiting-for-peers": return "waiting for other servers"
        case "filling": return "making room"
        case "placing": return "placing pieces"
        case "protected": return "protected"
        case "at-risk": return "at risk"
        case "leaving": return "leaving"
        default: return "off"
        }
    }

    /// The schedule runs (it doesn't while the policy is "none").
    public var scheduleShown: Bool { (saved?.scheduleActive ?? true) && policyKind != "none" }

    public var statusLine: String {
        guard let s = saved else { return "" }
        if let r = s.running {
            let p = r.progress
            if p.total > 0 { return "Backing up… \(p.app.isEmpty ? "apps" : p.app) (\(p.done)/\(p.total))" }
            return "Backing up…"
        }
        if let b = s.backups.first { return "Last backup: \(when(b.createdAt)) · \(ServerArchive.formatBytes(b.fileBytes))" }
        return "No backups yet."
    }

    public var failedLine: String? {
        guard let r = saved?.lastRun, !r.ok, saved?.running == nil else { return nil }
        let why = (r.reason ?? "the backup couldn't be made").trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        return "The last backup failed: \(why)."
    }

    /// "Next backup: …", "Scheduled backups are off.", or the box's reason it can't run.
    public var nextLine: String? {
        guard let s = saved, scheduleShown else { return nil }
        if s.schedule.frequency == "off" { return "Scheduled backups are off." }
        if let at = s.nextRunAt { return "Next backup: \(when(at))" }
        if s.keysLeft == 0, !isAdminDevice, let why = s.waitingReason { return BoxSentence.display(why) }
        return nil
    }

    public func scheduleLine(timeZone: TimeZone = .current) -> String {
        BackupScheduleClock.summary(saved?.schedule ?? .boxDefault, timeZone: timeZone,
                                    reference: Date(timeIntervalSince1970: Double(now()) / 1000))
    }

    public func rowLine(_ b: SavedBackup) -> String {
        "\(when(b.createdAt)) · \(ServerArchive.formatBytes(b.fileBytes)) · \(b.trigger == "now" ? "Back up now" : "Scheduled") · \(b.apps.count) app\(b.apps.count == 1 ? "" : "s")"
    }

    public func leftLine(_ b: SavedBackup) -> String? {
        b.left.isEmpty ? nil : "Left out: \(b.left.map(\.name).joined(separator: ", "))"
    }

    // MARK: This phone's copy

    public var phoneCopyShown: Bool { policyKind == "phone" || policyKind == "unset" }

    public var phoneCopyLine: String? {
        guard let c = phoneCopy else { return phoneStore.skipSentence(serverFqdn) }
        return "On this phone: \(when(c.createdAt)) · \(ServerArchive.formatBytes(c.bytes))"
    }

    private func rememberForPhone() {
        guard let p = policy else {
            phoneStore.remember(.init(fqdn: serverFqdn, policy: "unset", reserveBytes: 0))
            return
        }
        phoneStore.remember(.init(fqdn: serverFqdn, policy: p.policy.policy, reserveBytes: p.policy.phoneReserveBytes))
    }

    private func refreshPhoneCopy() {
        let c = keepCopyOnPhone ? phoneStore.copies(serverFqdn).first : nil
        phoneCopy = c
        phoneCopyURL = c.map { phoneStore.url(of: $0, server: serverFqdn) }
    }

    private func message(_ error: Error) -> String {
        if let e = error as? ArchiveDownloader.DownloadError { return e.errorDescription ?? "The download didn't finish." }
        if let e = error as? ServerBackupBundle.BundleError { return e.errorDescription ?? "The backup file is damaged." }
        return BoxSentence.of(error)
    }
}
