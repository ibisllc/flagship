import CryptoKit
import Foundation

/// The published distribution manifest for a prebuilt VM appliance
/// (`/downloads/FlagshipVMAppliance-<arch>.json`): a compressed qcow2 split into
/// parts, plus the hash of the raw disk it expands to.
public struct ApplianceDistribution: Codable, Equatable, Sendable {
    public struct Part: Codable, Equatable, Sendable {
        public let name: String
        public let sizeBytes: UInt64
        public let sha256: String
    }
    public let version: Int
    public let arch: IsoArch
    public let installerGitRef: String
    public let format: String
    public let sha256: String
    public let sizeBytes: UInt64
    public let parts: [Part]
    public let rawSha256: String
    public let rawSizeBytes: UInt64

    /// R2 key prefix the factory workflow publishes the parts under.
    public var keyPrefix: String {
        let slug = String(installerGitRef.map { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" ? $0 : "-" })
        return "flagship-vm-appliance-\(arch.rawValue)-\(slug)-\(sha256.prefix(12)).qcow2"
    }

    func validate() throws {
        let hex64 = "^[0-9a-f]{64}$"
        let partNames = "^part-[0-9]{2}$"
        guard version == 1, format == "qcow2",
              sha256.range(of: hex64, options: .regularExpression) != nil,
              rawSha256.range(of: hex64, options: .regularExpression) != nil,
              !parts.isEmpty, rawSizeBytes > 0,
              parts.allSatisfy({
                  $0.name.range(of: partNames, options: .regularExpression) != nil
                      && $0.sha256.range(of: hex64, options: .regularExpression) != nil
                      && $0.sizeBytes > 0
              }),
              parts.reduce(0, { $0 + $1.sizeBytes }) == sizeBytes else {
            throw ApplianceCache.CacheError.invalidManifest
        }
    }
}

/// Downloads, verifies and expands the prebuilt appliance once per release, so
/// hosting a server needs no Debian installer ISO and no qemu-img. The trust
/// model matches the base-ISO manifest: `flagshipserver.com` names the image
/// over TLS, and every part, the whole archive and the expanded disk are
/// checked against that manifest before use.
public struct ApplianceCache: Sendable {
    public enum CacheError: LocalizedError, Equatable {
        case unavailable(IsoArch)
        case refMismatch(published: String, recipe: String)
        case invalidManifest
        case offline(String)
        case httpStatus(Int)
        case checksumMismatch(String)
        case insufficientSpace(neededBytes: UInt64, freeBytes: UInt64)

        public var errorDescription: String? {
            switch self {
            case .unavailable(let arch):
                return "No prebuilt \(arch.rawValue) server image is published yet."
            case .refMismatch(let published, let recipe):
                return "The prebuilt server image is for \(published), but this recipe installs \(recipe)."
            case .invalidManifest:
                return "The prebuilt server image's manifest is malformed."
            case .offline(let why):
                return "Couldn't download the prebuilt server image: \(why)"
            case .httpStatus(let code):
                return "The server returned HTTP \(code) for the prebuilt server image."
            case .checksumMismatch(let what):
                return "The prebuilt server image failed its integrity check (\(what))."
            case .insufficientSpace(let needed, let free):
                let gb = { (b: UInt64) in String(format: "%.1f GB", Double(b) / 1e9) }
                return "Not enough free disk space for the server image: needs \(gb(needed)), \(gb(free)) free."
            }
        }

        /// Failures that mean "use the installer ISO instead" rather than
        /// "something is wrong with what we downloaded".
        public var fallsBackToInstaller: Bool {
            switch self {
            case .unavailable, .refMismatch, .invalidManifest: return true
            default: return false
            }
        }
    }

    public enum Phase: Sendable, Equatable {
        case downloading(part: Int, of: Int)
        case verifying
        case expanding(Double)
        case ready(fromCache: Bool)
    }

    public let arch: IsoArch
    public let origin: URL
    public let cacheRoot: URL
    let fetch: @Sendable (URL) async throws -> (Data, Int)
    let download: @Sendable (URL, URL) async throws -> Int
    let freeBytes: @Sendable (URL) -> UInt64?
    let log: @Sendable (String) -> Void

    public init(arch: IsoArch,
                origin: URL = URL(string: "https://flagshipserver.com")!,
                cacheRoot: URL? = nil,
                log: @escaping @Sendable (String) -> Void = { _ in }) throws {
        self.init(arch: arch, origin: origin,
                  cacheRoot: try cacheRoot ?? IsoBaseCache.cacheDir(),
                  fetch: Self.liveFetch, download: Self.liveDownload,
                  freeBytes: Self.liveFreeBytes, log: log)
    }

    init(arch: IsoArch, origin: URL, cacheRoot: URL,
         fetch: @escaping @Sendable (URL) async throws -> (Data, Int),
         download: @escaping @Sendable (URL, URL) async throws -> Int,
         freeBytes: @escaping @Sendable (URL) -> UInt64?,
         log: @escaping @Sendable (String) -> Void) {
        self.arch = arch
        self.origin = origin
        self.cacheRoot = cacheRoot
        self.fetch = fetch
        self.download = download
        self.freeBytes = freeBytes
        self.log = log
    }

    var archRoot: URL { cacheRoot.appendingPathComponent("appliance-\(arch.rawValue)", isDirectory: true) }

    /// Returns a verified raw base disk with its runtime manifest beside it
    /// (`<base>.json`, the shape ApplianceProvisioner.load reads).
    public func ensure(installerGitRef: String,
                       progress: @escaping @Sendable (Phase) -> Void = { _ in }) async throws -> URL {
        let manifestURL = origin.appendingPathComponent("downloads/FlagshipVMAppliance-\(arch.rawValue).json")
        let dist: ApplianceDistribution
        do {
            let (data, status) = try await fetch(manifestURL)
            if status == 404 { throw CacheError.unavailable(arch) }
            guard (200...299).contains(status) else { throw CacheError.httpStatus(status) }
            guard let decoded = try? JSONDecoder().decode(ApplianceDistribution.self, from: data) else {
                throw CacheError.invalidManifest
            }
            dist = decoded
        } catch let error as CacheError {
            throw error
        } catch {
            if let cached = newestReadyBase(installerGitRef: installerGitRef) {
                log("appliance: offline (\(error.localizedDescription)); using cached \(cached.path)")
                progress(.ready(fromCache: true))
                return cached
            }
            throw CacheError.offline(error.localizedDescription)
        }
        try dist.validate()
        guard dist.arch == arch else { throw CacheError.invalidManifest }
        guard dist.installerGitRef == installerGitRef else {
            throw CacheError.refMismatch(published: dist.installerGitRef, recipe: installerGitRef)
        }

        let dir = archRoot.appendingPathComponent(String(dist.rawSha256.prefix(16)), isDirectory: true)
        let base = dir.appendingPathComponent("base.raw")
        if isReady(base: base, rawSha256: dist.rawSha256, rawSize: dist.rawSizeBytes) {
            log("appliance: cached \(base.path) sha256=\(dist.rawSha256)")
            prune(keeping: dir)
            progress(.ready(fromCache: true))
            return base
        }

        let fm = FileManager.default
        let partsDir = dir.appendingPathComponent("parts", isDirectory: true)
        try fm.createDirectory(at: partsDir, withIntermediateDirectories: true)
        // Parts are deleted once expanded; the raw disk allocates about as much
        // as the compressed archive (zero runs stay sparse), plus headroom.
        let needed = dist.sizeBytes * 2 + 2_000_000_000
        if let free = freeBytes(dir), free < needed {
            throw CacheError.insufficientSpace(neededBytes: needed, freeBytes: free)
        }

        var partURLs: [URL] = []
        for (index, part) in dist.parts.enumerated() {
            progress(.downloading(part: index + 1, of: dist.parts.count))
            let local = partsDir.appendingPathComponent(part.name)
            partURLs.append(local)
            if fileSize(local) == part.sizeBytes, try sha256(of: [local]) == part.sha256 { continue }
            try? fm.removeItem(at: local)
            let remote = origin.appendingPathComponent("build/iso/\(dist.keyPrefix).\(part.name)")
            let status: Int
            do {
                status = try await download(remote, local)
            } catch {
                throw CacheError.offline(error.localizedDescription)
            }
            guard (200...299).contains(status) else {
                try? fm.removeItem(at: local)
                throw CacheError.httpStatus(status)
            }
            guard fileSize(local) == part.sizeBytes, try sha256(of: [local]) == part.sha256 else {
                try? fm.removeItem(at: local)
                throw CacheError.checksumMismatch(part.name)
            }
        }

        progress(.verifying)
        guard try sha256(of: partURLs) == dist.sha256 else {
            throw CacheError.checksumMismatch("archive")
        }

        let partial = dir.appendingPathComponent("base.raw.partial")
        try? fm.removeItem(at: partial)
        let expanded = try Qcow2Expander.expand(source: MultiPartSource(parts: partURLs), to: partial) {
            progress(.expanding($0))
        }
        guard expanded.sha256 == dist.rawSha256, expanded.sizeBytes == dist.rawSizeBytes else {
            try? fm.removeItem(at: partial)
            throw CacheError.checksumMismatch("expanded disk")
        }
        try? fm.removeItem(at: base)
        try fm.moveItem(at: partial, to: base)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: base.path)
        let runtime = ApplianceBaseManifest(arch: arch, installerGitRef: dist.installerGitRef,
                                            sha256: dist.rawSha256, sizeBytes: dist.rawSizeBytes,
                                            virtualSizeBytes: dist.rawSizeBytes)
        try JSONEncoder().encode(runtime).write(to: URL(fileURLWithPath: base.path + ".json"), options: .atomic)
        try? fm.removeItem(at: partsDir)
        prune(keeping: dir)
        IsoBaseCache.pruneUnused(in: cacheRoot)
        log("appliance: expanded \(base.path) sha256=\(dist.rawSha256)")
        progress(.ready(fromCache: false))
        return base
    }

    // MARK: - Helpers

    func isReady(base: URL, rawSha256: String, rawSize: UInt64) -> Bool {
        guard fileSize(base) == rawSize,
              let data = try? Data(contentsOf: URL(fileURLWithPath: base.path + ".json")),
              let manifest = try? JSONDecoder().decode(ApplianceBaseManifest.self, from: data) else { return false }
        return manifest.sha256 == rawSha256
    }

    func newestReadyBase(installerGitRef: String) -> URL? {
        let fm = FileManager.default
        guard let dirs = try? fm.contentsOfDirectory(at: archRoot, includingPropertiesForKeys: [.contentModificationDateKey]) else {
            return nil
        }
        return dirs.compactMap { dir -> (URL, Date)? in
            let base = dir.appendingPathComponent("base.raw")
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: base.path + ".json")),
                  let m = try? JSONDecoder().decode(ApplianceBaseManifest.self, from: data),
                  m.installerGitRef == installerGitRef, fileSize(base) == m.sizeBytes else { return nil }
            let date = (try? dir.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            return (base, date ?? .distantPast)
        }.max { $0.1 < $1.1 }?.0
    }

    /// Keep one release per arch. Servers already created hold their own APFS
    /// clone, so deleting an old base doesn't touch them.
    func prune(keeping keep: URL) {
        let fm = FileManager.default
        guard let dirs = try? fm.contentsOfDirectory(at: archRoot, includingPropertiesForKeys: nil) else { return }
        for dir in dirs where dir.standardizedFileURL != keep.standardizedFileURL {
            try? fm.removeItem(at: dir)
        }
    }

    func fileSize(_ url: URL) -> UInt64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.uint64Value ?? 0
    }

    func sha256(of files: [URL]) throws -> String {
        var hasher = SHA256()
        for url in files {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            while let chunk = try handle.read(upToCount: 4 << 20), !chunk.isEmpty {
                hasher.update(data: chunk)
            }
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Live transport

    static let liveFetch: @Sendable (URL) async throws -> (Data, Int) = { url in
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    static let liveDownload: @Sendable (URL, URL) async throws -> Int = { remote, local in
        let (tmp, response) = try await URLSession.shared.download(for: URLRequest(url: remote))
        try FileManager.default.moveItem(at: tmp, to: local)
        return (response as? HTTPURLResponse)?.statusCode ?? 0
    }

    static let liveFreeBytes: @Sendable (URL) -> UInt64? = { url in
        let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage.map { UInt64(max(0, $0)) }
    }
}
