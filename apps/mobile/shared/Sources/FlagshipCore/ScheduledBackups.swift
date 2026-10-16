import Foundation
import CryptoKit
import FlagshipAPI

/// `flagship/server-archive-keys/v1` (packages/protocol/src/archiveKeys.ts):
/// an admin device's signed batch of archive ids and their account-slot keys,
/// so the box can seal its scheduled backups without ever holding the UMK.
/// Must pass packages/protocol/test-vectors/server-archive-keys/vectors.json.
public enum ArchiveKeys {
    /// The most keys one deposit may carry.
    public static let maxPerDeposit = 400

    public enum KeysError: Error, Equatable {
        case badKey
        case badDeposit
    }

    /// SHA-256 (lowercase hex) of the UTF-8 lines `<archiveId>:<kekHex>` joined with "\n", in order.
    public static func digest(_ keys: [ArchiveKey]) throws -> String {
        for k in keys where !ServerBackupFormat.isHex(k.archiveId, length: 32) || !ServerBackupFormat.isHex(k.kekHex, length: 64) {
            throw KeysError.badKey
        }
        let text = keys.map { "\($0.archiveId):\($0.kekHex)" }.joined(separator: "\n")
        return HexUtil.encode(Data(SHA256.hash(data: Data(text.utf8))))
    }

    /// `count` fresh random archive ids, each with `deriveServerArchiveKey(UMK, archiveId)`.
    public static func mint(umkSeed: Data, count: Int, random: (Int) -> Data = ServerBackupFormat.randomBytes) -> [ArchiveKey] {
        (0..<max(0, count)).compactMap { _ in
            let id = HexUtil.encode(random(16))
            return ServerArchive.deriveKey(umkSeed: umkSeed, archiveId: id).map { ArchiveKey(archiveId: id, kekHex: HexUtil.encode($0)) }
        }
    }

    /// The signed deposit for `keys` (the caller signs `canonicalBytes`).
    public static func deposit(serverDomain: String, keys: [ArchiveKey], issuedAt: Int64) throws -> ArchiveKeysDeposit {
        ArchiveKeysDeposit(serverDomain: serverDomain.lowercased(), count: keys.count, digest: try digest(keys), issuedAt: issuedAt)
    }

    /// How many keys to send: what the box asks for, at most a deposit's worth.
    public static func count(wanted: Int) -> Int { min(max(0, wanted), maxPerDeposit) }

    /// Top the box's pool up only from a device that may sign admin orders,
    /// and only when the box asks (never on every page open).
    public static func shouldDeposit(isAdminDevice: Bool, keysWanted: Int) -> Bool {
        isAdminDevice && keysWanted > 0
    }
}

extension ArchiveKeysDeposit {
    public var isValid: Bool {
        BackupPolicyOrder.isCanonicalField(serverDomain) && (1...ArchiveKeys.maxPerDeposit).contains(count)
            && ServerBackupFormat.isHex(digest, length: 64) && issuedAt >= 0
    }

    /// `flagship/server-archive-keys/v1|<serverDomain>|<count>|<digest>|<issuedAt>`
    public func canonicalBytes() throws -> Data {
        guard isValid else { throw ArchiveKeys.KeysError.badDeposit }
        return Data([Self.canonicalTag, serverDomain, String(count), digest, String(issuedAt)].joined(separator: "|").utf8)
    }
}

/// `flagship/backup-policy/v1` (packages/protocol/src/backupPolicy.ts): the
/// server's backup policy, signed with the sensitive-order key. Must pass
/// packages/protocol/test-vectors/backup-policy/vectors.json.
extension BackupPolicyOrder {
    public static let policies = ["phone", "peer", "none"]

    public struct Invalid: Error, Equatable {}

    static func isCanonicalField(_ s: String) -> Bool {
        !s.isEmpty && !s.unicodeScalars.contains(where: { $0 == "|" || $0.value <= 0x1f || $0.value == 0x7f })
    }

    public var isValid: Bool {
        Self.isCanonicalField(serverDomain) && Self.policies.contains(policy) && phoneReserveBytes >= 0
            && (policy == "phone" ? phoneReserveBytes > 0 : phoneReserveBytes == 0) && issuedAt >= 0
    }

    /// `flagship/backup-policy/v1|<serverDomain>|<policy>|<phoneReserveBytes>|<issuedAt>`
    public func canonicalBytes() throws -> Data {
        guard isValid else { throw Invalid() }
        return Data([Self.canonicalTag, serverDomain, policy, String(phoneReserveBytes), String(issuedAt)].joined(separator: "|").utf8)
    }

    /// The order for a choice: the draft's "phone-only" is the wire's "phone".
    public static func make(serverDomain: String, draft: CreateServerDraftStore.BackupPolicy, reserveBytes: Int64,
                            issuedAt: Int64) -> BackupPolicyOrder {
        let policy: String
        switch draft {
        case .phoneOnly: policy = "phone"
        case .peer: policy = "peer"
        case .none: policy = "none"
        }
        return BackupPolicyOrder(serverDomain: serverDomain.lowercased(), policy: policy,
                                 phoneReserveBytes: policy == "phone" ? max(1, reserveBytes) : 0, issuedAt: issuedAt)
    }
}

extension ServerBackupFormat {
    /// The pairing order's JSON with the signed backup policy beside it
    /// (`{request, signature, …, backupPolicy: {order, signatureHex}}`), like a restore order.
    public static func attachBackupPolicy(toPairingJson json: String, order: BackupPolicyOrder, signatureHex: String) -> String {
        guard json.hasSuffix("}") else { return json }
        let o = "{\"serverDomain\":\(PairingOrderEnvelope.jsonString(order.serverDomain)),"
            + "\"policy\":\"\(order.policy)\",\"phoneReserveBytes\":\(order.phoneReserveBytes),"
            + "\"issuedAt\":\(order.issuedAt)}"
        return String(json.dropLast()) + ",\"backupPolicy\":{\"order\":\(o),\"signatureHex\":\"\(signatureHex)\"}}"
    }
}

/// The schedule in the owner's local time. The box keeps it in UTC
/// (`minuteOfDayUtc`, `weekdayUtc`); the apps show and set it in local time.
public enum BackupScheduleClock {
    /// Local wall time (and, for weekly, local weekday 0 = Sunday) → the box's UTC minute and weekday.
    /// The local time is placed on the chosen weekday of the week around `reference`, so the
    /// offset in force then (DST included) is the one used.
    public static func toUtc(localMinute: Int, localWeekday: Int, timeZone: TimeZone, reference: Date = Date()) -> (minuteOfDayUtc: Int, weekdayUtc: Int) {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let startOfDay = cal.startOfDay(for: reference)
        let todayWeekday = cal.component(.weekday, from: startOfDay) - 1
        let day = cal.date(byAdding: .day, value: localWeekday - todayWeekday, to: startOfDay) ?? startOfDay
        var comps = cal.dateComponents([.year, .month, .day], from: day)
        comps.hour = localMinute / 60
        comps.minute = localMinute % 60
        let instant = cal.date(from: comps) ?? day
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let c = utc.dateComponents([.hour, .minute, .weekday], from: instant)
        return ((c.hour ?? 0) * 60 + (c.minute ?? 0), (c.weekday ?? 1) - 1)
    }

    /// The box's UTC minute and weekday → local minute and local weekday (0 = Sunday).
    public static func toLocal(minuteOfDayUtc: Int, weekdayUtc: Int, timeZone: TimeZone, reference: Date = Date()) -> (minute: Int, weekday: Int) {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let startOfDay = utc.startOfDay(for: reference)
        let todayWeekday = utc.component(.weekday, from: startOfDay) - 1
        let day = utc.date(byAdding: .day, value: weekdayUtc - todayWeekday, to: startOfDay) ?? startOfDay
        let instant = day.addingTimeInterval(TimeInterval(minuteOfDayUtc * 60))
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let c = cal.dateComponents([.hour, .minute, .weekday], from: instant)
        return ((c.hour ?? 0) * 60 + (c.minute ?? 0), (c.weekday ?? 1) - 1)
    }

    /// "3:00 AM" for a local minute of the day.
    public static func timeText(minute: Int, locale: Locale = .current) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let d = Date(timeIntervalSince1970: TimeInterval(minute * 60))
        let f = DateFormatter()
        f.locale = locale
        f.timeZone = cal.timeZone
        f.dateStyle = .none
        f.timeStyle = .short
        return f.string(from: d)
    }

    public static func weekdayName(_ weekday: Int, locale: Locale = .current) -> String {
        let f = DateFormatter()
        f.locale = locale
        let names = f.weekdaySymbols ?? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        return names[((weekday % 7) + 7) % 7]
    }

    /// "Daily at 3:00 AM · keeps 7 daily and 4 weekly" (or "Weekly on Sunday at …", or off).
    public static func summary(_ s: BackupSchedule, timeZone: TimeZone = .current, locale: Locale = .current, reference: Date = Date()) -> String {
        if s.frequency == "off" { return "Scheduled backups are off." }
        let local = toLocal(minuteOfDayUtc: s.minuteOfDayUtc, weekdayUtc: s.weekdayUtc, timeZone: timeZone, reference: reference)
        let when = s.frequency == "weekly"
            ? "Weekly on \(weekdayName(local.weekday, locale: locale)) at \(timeText(minute: local.minute, locale: locale))"
            : "Daily at \(timeText(minute: local.minute, locale: locale))"
        return "\(when) · keeps \(s.keepDaily) daily and \(s.keepWeekly) weekly"
    }
}

/// The copies of a server's backups this phone keeps (phone-side policy).
public enum PhoneBackupRetention {
    public struct Copy: Equatable, Sendable {
        public let archiveId: String
        public let createdAt: Int64
        public let bytes: Int64
        public init(archiveId: String, createdAt: Int64, bytes: Int64) {
            self.archiveId = archiveId
            self.createdAt = createdAt
            self.bytes = bytes
        }
    }

    /// Which copies to keep: the newest always, the one before it only while
    /// both fit in `reserveBytes` (no reserve: both), never more than two.
    public static func keep(_ copies: [Copy], reserveBytes: Int64?) -> Set<String> {
        let sorted = copies.sorted { $0.createdAt > $1.createdAt }
        guard let newest = sorted.first else { return [] }
        var out: Set<String> = [newest.archiveId]
        if sorted.count > 1 {
            let previous = sorted[1]
            if reserveBytes.map({ newest.bytes + previous.bytes <= $0 }) ?? true { out.insert(previous.archiveId) }
        }
        return out
    }

    /// The default reserve a phone offers: a quarter of its free space,
    /// rounded down to a whole GB, at least 2 GB.
    public static func defaultReserveBytes(freeBytes: Int64) -> Int64 {
        let gb: Int64 = 1 << 30
        return max(2, (freeBytes / 4) / gb) * gb
    }

    /// Room the phone keeps free beside a new copy.
    public static let headroomBytes: Int64 = 1 << 30

    /// Whether a copy of `bytes` fits beside the headroom.
    public static func fits(bytes: Int64, freeBytes: Int64) -> Bool {
        freeBytes >= bytes + headroomBytes
    }

    public static func needsSpaceSentence(bytes: Int64) -> String {
        "This phone needs about \(ServerArchive.formatBytes(bytes + headroomBytes)) free to keep a copy."
    }
}

/// The box's own sentences, shown as they are (first letter capitalised, a
/// full stop added): never a generic one.
public enum BoxSentence {
    public static func display(_ s: String) -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = t.first else { return t }
        let capped = first.uppercased() + t.dropFirst()
        return [".", "!", "?"].contains(where: capped.hasSuffix) ? capped : capped + "."
    }

    /// The box's `{error}` of a refused request, else the plain-language one.
    public static func of(_ error: Error) -> String {
        if let r = ScreensClientError.boxReason(error) { return display(r) }
        return ScreensClientError.userFacing(error)
    }

    /// The `code` of a refusal (`no-keys`, `over-backup-limit`, ...), if any.
    public static func code(_ error: Error) -> String? {
        guard case let ScreensClientError.http(_, message) = error,
              let obj = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any] else { return nil }
        return obj["code"] as? String
    }
}

extension ArchiveDownloader {
    /// Download a backup's one `.flagship` file into `directory` (4 MiB parts,
    /// several at once, resumable, the whole file's SHA-256 checked) and
    /// return its URL. The finished part file is renamed into place.
    public static func downloadBundle(
        client: any ScreensClient,
        route: ServerArchiveRoute,
        bytes: Int64,
        sha256: String?,
        fileName: String,
        into directory: URL,
        protection: FileProtectionType = .complete,
        progress: @escaping @Sendable (_ received: Int64) async -> Void = { _ in }
    ) async throws -> URL {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let part = directory.appendingPathComponent("\(fileName).part")
        let state = directory.appendingPathComponent("\(fileName).part.json")
        let out = directory.appendingPathComponent(fileName)
        try await download(total: bytes, sha256: sha256, to: part, stateFile: state, protection: protection,
                           fetch: { offset in try await client.serverArchiveBundle(route, offset: offset) },
                           progress: progress)
        try? fm.removeItem(at: out)
        try fm.moveItem(at: part, to: out)
        return out
    }
}

