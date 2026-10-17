import Foundation

/// One store's use and limit as the box sends it on app-detail and
/// server-detail (`storage`, docs/app-runtimes.md 5.3). `limitBytes` nil: no
/// limit but the disk.
public struct StoreUsage: Codable, Equatable, Sendable {
    public var usedBytes: Int64
    public var limitBytes: Int64?
    /// At its limit: new writes fail.
    public var full: Bool
    public var enforced: Bool
    /// Postgres: INSERT and UPDATE are refused.
    public var writesBlocked: Bool
    /// Postgres: it grew past its limit while blocked, so its database is
    /// closed until it is under again.
    public var stopped: Bool

    public init(usedBytes: Int64, limitBytes: Int64? = nil, full: Bool = false, enforced: Bool = false,
                writesBlocked: Bool = false, stopped: Bool = false) {
        self.usedBytes = usedBytes; self.limitBytes = limitBytes; self.full = full
        self.enforced = enforced; self.writesBlocked = writesBlocked; self.stopped = stopped
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        usedBytes = try c.decodeIfPresent(Int64.self, forKey: .usedBytes) ?? 0
        limitBytes = try c.decodeIfPresent(Int64.self, forKey: .limitBytes)
        full = try c.decodeIfPresent(Bool.self, forKey: .full) ?? false
        enforced = try c.decodeIfPresent(Bool.self, forKey: .enforced) ?? false
        writesBlocked = try c.decodeIfPresent(Bool.self, forKey: .writesBlocked) ?? false
        stopped = try c.decodeIfPresent(Bool.self, forKey: .stopped) ?? false
    }
}

public struct AppDiskUsage: Codable, Equatable, Sendable {
    public var files: StoreUsage?
    public var postgres: StoreUsage?
    public init(files: StoreUsage? = nil, postgres: StoreUsage? = nil) { self.files = files; self.postgres = postgres }
}

public struct AppStorageEntry: Codable, Equatable, Sendable {
    public var serviceId: String
    public var files: StoreUsage?
    public var postgres: StoreUsage?
    public init(serviceId: String, files: StoreUsage? = nil, postgres: StoreUsage? = nil) {
        self.serviceId = serviceId; self.files = files; self.postgres = postgres
    }
}

public struct ServerStorage: Codable, Equatable, Sendable {
    /// `off`, `on` (apps can't write more) or `hard` (their folders are read-only).
    public var brake: String
    public var capped: Bool
    public var apps: [AppStorageEntry]
    public init(brake: String = "off", capped: Bool = false, apps: [AppStorageEntry] = []) {
        self.brake = brake; self.capped = capped; self.apps = apps
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        brake = try c.decodeIfPresent(String.self, forKey: .brake) ?? "off"
        capped = try c.decodeIfPresent(Bool.self, forKey: .capped) ?? false
        apps = try c.decodeIfPresent([AppStorageEntry].self, forKey: .apps) ?? []
    }
}

/// An app's disk use and limits as lines, and the sentences shown while new
/// data is refused. MIRRORS the webapp's lib/appStorage.js and Android's
/// AppStorageText, word for word.
public enum AppStorageText {
    public static let fullSentence = "Full: new data is refused until you free space or raise the limit."
    public static let stoppedSentence = "Its database is closed until it is under its limit again."
    public static let alert = "An app on this server is full"

    public struct Line: Equatable, Sendable {
        public let label: String
        public let text: String
        public let full: Bool
        public let note: String
    }

    private static let gib: Int64 = 1_073_741_824

    static func gb(_ n: Int64) -> String {
        let v = Double(n) / Double(gib)
        return n < 10 * gib ? String(format: "%.1f GB", v) : String(format: "%.0f GB", v)
    }

    static func size(_ n: Int64) -> String {
        if n >= gib { return gb(n) }
        if n >= 1024 * 1024 { return "\(Int((Double(n) / (1024 * 1024)).rounded())) MB" }
        return "\(max(0, Int((Double(n) / 1024).rounded()))) KB"
    }

    private static func line(_ label: String, _ s: StoreUsage?) -> Line? {
        guard let s else { return nil }
        let of = s.limitBytes.map { " of \(size($0))" } ?? ""
        let full = s.full || s.writesBlocked
        return Line(label: label, text: "\(size(s.usedBytes))\(of)", full: full,
                    note: s.stopped ? stoppedSentence : full ? fullSentence : "")
    }

    /// The app page's lines, files then database.
    public static func appLines(_ storage: AppDiskUsage?) -> [Line] {
        [line("Files", storage?.files), line("Database", storage?.postgres)].compactMap { $0 }
    }

    /// The server page's notes about full apps and the disk brake.
    public static func serverNotes(_ storage: ServerStorage?, nameOf: (String) -> String = { $0 }) -> [String] {
        guard let storage else { return [] }
        var out: [String] = []
        switch storage.brake {
        case "hard": out.append("The server's disk is full: apps' folders are read-only until there's room.")
        case "on": out.append("The server's disk is nearly full: apps can't save more until there's room.")
        default: break
        }
        for a in storage.apps {
            let full = a.files?.full == true || (a.postgres.map { $0.full || $0.writesBlocked } ?? false)
            if full { out.append("\(nameOf(a.serviceId)) is full: new data is refused until you free space or raise the limit.") }
        }
        return out
    }
}
