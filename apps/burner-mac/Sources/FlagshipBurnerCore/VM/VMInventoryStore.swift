import Foundation

/// One persisted hosted server: its spec + last known lifecycle state.
public struct VMRecord: Codable, Sendable, Equatable {
    public var config: VMConfig
    public var state: VMState
    public var createdAt: Date
    public var tier: ServerTier

    public init(config: VMConfig,
                state: VMState = .created,
                createdAt: Date,
                tier: ServerTier = .hostedVM) {
        self.config = config
        self.state = state
        self.createdAt = createdAt
        self.tier = tier
    }
}

/// The on-disk layout of one VM bundle under the inventory root:
///
///     <root>/<name>/config.json     — VMRecord (spec + state)
///     <root>/<name>/disk.img        — the guest's main disk (sparse)
///     <root>/<name>/installer.iso   — the remastered installer (install phase only)
///     <root>/<name>/efi-vars.bin    — EFI variable store (VZEFIVariableStore)
///     <root>/<name>/console.log     — serial output (debug-enabled VMs only)
public struct VMBundleLayout: Sendable, Equatable {
    public let root: URL

    public init(root: URL) {
        self.root = root
    }

    /// Production default: ~/Library/Application Support/FlagshipBurner/VMs.
    public static func defaultRoot() -> URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory,
                                                  in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support")
        return appSupport.appendingPathComponent("FlagshipBurner/VMs", isDirectory: true)
    }

    public func bundleDir(_ name: String) -> URL {
        root.appendingPathComponent(name, isDirectory: true)
    }
    public func configURL(_ name: String) -> URL {
        bundleDir(name).appendingPathComponent("config.json")
    }
    public func diskImageURL(_ name: String) -> URL {
        bundleDir(name).appendingPathComponent("disk.img")
    }
    public func installerISOURL(_ name: String) -> URL {
        bundleDir(name).appendingPathComponent("installer.iso")
    }
    public func efiVariableStoreURL(_ name: String) -> URL {
        bundleDir(name).appendingPathComponent("efi-vars.bin")
    }
    public func consoleLogURL(_ name: String) -> URL {
        bundleDir(name).appendingPathComponent("console.log")
    }
}

public enum VMStoreError: LocalizedError, Equatable {
    case invalidName(String)
    case alreadyExists(String)
    case notFound(String)

    public var errorDescription: String? {
        switch self {
        case .invalidName(let n): return "'\(n)' is not a valid server name."
        case .alreadyExists(let n): return "A hosted server named '\(n)' already exists."
        case .notFound(let n): return "No hosted server named '\(n)'."
        }
    }
}

/// Inventory of hosted VMs under an injected filesystem root — the app passes
/// `VMBundleLayout.defaultRoot()`, tests a temp dir. Multi-server per spec:
/// each bundle is an independent appliance (different owners per VM are fine —
/// each guest phones its own owner).
public final class VMInventoryStore {
    public let layout: VMBundleLayout
    private let fm = FileManager.default

    public init(layout: VMBundleLayout) {
        self.layout = layout
    }

    /// All persisted records, sorted by name. Entries whose config.json is
    /// missing or unreadable are skipped (never fatal to the rest).
    public func list() -> [VMRecord] {
        guard let names = try? fm.contentsOfDirectory(atPath: layout.root.path) else { return [] }
        return names.sorted().compactMap { try? load(name: $0) }
    }

    public func load(name: String) throws -> VMRecord {
        let url = layout.configURL(name)
        guard fm.fileExists(atPath: url.path) else { throw VMStoreError.notFound(name) }
        let data = try Data(contentsOf: url)
        return try Self.decoder().decode(VMRecord.self, from: data)
    }

    /// Create the bundle directory + initial config.json. Refuses to clobber.
    public func create(_ record: VMRecord) throws {
        let name = record.config.name
        try Self.validate(name: name)
        let dir = layout.bundleDir(name)
        if fm.fileExists(atPath: dir.path) { throw VMStoreError.alreadyExists(name) }
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        try write(record)
    }

    /// Persist an updated record (state changes etc.). The bundle must exist.
    public func save(_ record: VMRecord) throws {
        let name = record.config.name
        guard fm.fileExists(atPath: layout.bundleDir(name).path) else {
            throw VMStoreError.notFound(name)
        }
        try write(record)
    }

    /// Remove the whole bundle (disk image included).
    public func delete(name: String) throws {
        let dir = layout.bundleDir(name)
        guard fm.fileExists(atPath: dir.path) else { throw VMStoreError.notFound(name) }
        try fm.removeItem(at: dir)
    }

    private func write(_ record: VMRecord) throws {
        let data = try Self.encoder().encode(record)
        try data.write(to: layout.configURL(record.config.name), options: [.atomic])
    }

    /// Bundle names are server FQDNs — plain hostnames. Reject anything that
    /// could escape the root or collide with the filesystem.
    static func validate(name: String) throws {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789.-")
        guard !name.isEmpty, name != ".", name != "..",
              !name.hasPrefix("."),
              name.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
            throw VMStoreError.invalidName(name)
        }
    }

    static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .prettyPrinted]
        e.dateEncodingStrategy = .iso8601
        return e
    }

    static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}
