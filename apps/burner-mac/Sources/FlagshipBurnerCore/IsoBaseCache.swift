import Foundation
import CryptoKit

/// Manifest-driven base-ISO cache for the "Simple" mode. Unlike the old
/// hardcoded Alpine cache, this one holds NO pinned version/sha/url constants:
/// the SERVER decides. On every `ensure()` the burner inspects whatever ISO it
/// has cached (computing its sha256), reports `{version, sha256}` (or nil) to
/// the ISO-manifest endpoint, and OBEYS the reply — either downloading a
/// specific URL (stream-verifying the bytes against the server-quoted sha256
/// and storing it) or keeping the cache. The client never compares shas itself.
///
/// The Debian netinst base lands at
///   ~/Library/Caches/flagship-burner/flagship-base-<version>.iso
/// and is then remastered with a preseed via the shared Advanced path.
///
/// The cache is keyed PER-ARCH: amd64 (the burn default) keeps the legacy
/// un-tagged filename so existing caches stay valid, while other arches are
/// namespaced `flagship-base-<arch>-<version>.iso` — an amd64 burn base and
/// an arm64 host base coexist, and each arch's inspect/prune only ever sees
/// its own entry.
public struct IsoBaseCache {

    public enum CacheError: LocalizedError {
        case offline(String)
        case httpStatus(Int)
        case checksumMismatch(expected: String, got: String)
        case noCacheDir
        case noBaseAvailable(IsoArch)

        public var errorDescription: String? {
            switch self {
            case .offline(let why):
                return "Couldn't download the base image — check your internet connection. (\(why))"
            case .httpStatus(let code):
                return "Base-image download failed (HTTP \(code))."
            case .checksumMismatch(let e, let g):
                return "Base image failed its integrity check (expected \(e.prefix(12))…, got \(g.prefix(12))…). It was discarded — try again."
            case .noCacheDir:
                return "Couldn't open the cache directory."
            case .noBaseAvailable(let arch):
                switch arch {
                case .amd64:
                    return "No base image is available yet — the server has nothing to download and nothing is cached."
                case .arm64:
                    return "The server doesn't offer an arm64 base image yet, so Simple mode can't host a server on this Apple-silicon Mac for now. Use Advanced mode with an arm64 Debian netinst ISO instead."
                }
            }
        }
    }

    /// Phase callback so the UI can show what's happening + the URL being fetched.
    public enum Phase: Sendable, Equatable {
        /// Reported once with the local cache path + sha (or nil if no cache),
        /// before contacting the server.
        case inspected(path: String?, sha256: String?)
        /// A download was ordered. Carries the URL so the UI shows it under the bar.
        case downloading(url: String, version: String, progress: Double)
        /// Done — either freshly downloaded or served from cache.
        case ready(path: String, sha256: String, fromCache: Bool)
    }

    private let client: IsoManifestClient
    private let burnerVersion: String
    /// Which arch's base this cache instance manages. Burning stays amd64;
    /// the host-a-VM path passes the HOST arch (arm64 on Apple silicon).
    private let arch: IsoArch
    private let log: @Sendable (String) -> Void
    /// Session used for the ISO byte stream. Defaults to `.shared`; tests inject
    /// a stub. The manifest POST uses the client's own session.
    private let downloadSession: URLSession
    /// Cache directory override for tests. nil → the real ~/Library/Caches dir.
    private let cacheDirOverride: URL?

    public init(client: IsoManifestClient = IsoManifestClient(),
                burnerVersion: String = IsoBaseCache.defaultBurnerVersion(),
                arch: IsoArch = .amd64,
                downloadSession: URLSession = .shared,
                cacheDirOverride: URL? = nil,
                log: @escaping @Sendable (String) -> Void = { _ in }) {
        self.client = client
        self.burnerVersion = burnerVersion
        self.arch = arch
        self.downloadSession = downloadSession
        self.cacheDirOverride = cacheDirOverride
        self.log = log
    }

    private func resolvedCacheDir() throws -> URL {
        if let cacheDirOverride {
            try FileManager.default.createDirectory(at: cacheDirOverride, withIntermediateDirectories: true)
            return cacheDirOverride
        }
        return try Self.cacheDir()
    }

    public static func defaultBurnerVersion() -> String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"
    }

    // MARK: - Cache directory

    public static func cacheDir() throws -> URL {
        let fm = FileManager.default
        guard let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            throw CacheError.noCacheDir
        }
        let dir = caches.appendingPathComponent("flagship-burner", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func cachedURL(version: String, arch: IsoArch, dir: URL) -> URL {
        dir.appendingPathComponent("\(basePrefix(arch))\(version).iso")
    }

    /// amd64 keeps the legacy un-tagged prefix so caches downloaded before the
    /// arch split stay valid; other arches get their own namespace so a host
    /// base and the burn base coexist without evicting each other.
    static func basePrefix(_ arch: IsoArch) -> String {
        arch == .amd64 ? "flagship-base-" : "flagship-base-\(arch.rawValue)-"
    }

    /// nil unless `name` is a cached base for exactly this arch. The legacy
    /// amd64 prefix is a prefix of every arch-tagged name, so the amd64 match
    /// must REJECT names whose "version" is actually another arch's tag.
    static func version(ofCachedName name: String, arch: IsoArch) -> String? {
        let prefix = basePrefix(arch)
        guard name.hasPrefix(prefix), name.hasSuffix(".iso") else { return nil }
        let version = String(name.dropFirst(prefix.count).dropLast(".iso".count))
        if arch == .amd64,
           IsoArch.allCases.contains(where: { $0 != .amd64 && version.hasPrefix("\($0.rawValue)-") }) {
            return nil
        }
        return version
    }

    /// The single base ISO of this arch currently on disk, if any. The
    /// filename encodes the version (and, for non-amd64, the arch).
    static func existingCachedISO(in dir: URL, arch: IsoArch) -> (url: URL, version: String)? {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(atPath: dir.path) else { return nil }
        for name in entries.sorted() {
            guard let version = version(ofCachedName: name, arch: arch) else { continue }
            let url = dir.appendingPathComponent(name)
            if fm.fileExists(atPath: url.path) {
                return (url, version)
            }
        }
        return nil
    }

    // MARK: - ensure()

    /// Inspect the cache, ask the server, obey, return the local base-ISO URL.
    public func ensure(progress: @escaping @Sendable (Phase) -> Void = { _ in }) async throws -> URL {
        let dir = try resolvedCacheDir()
        let existing = Self.existingCachedISO(in: dir, arch: arch)

        // (a) Inspect the cached ISO + compute its sha256, LOG path+sha.
        var current: IsoManifestCurrent? = nil
        if let existing {
            let sha = try Self.sha256OfFile(at: existing.url)
            log("base-iso cache: \(existing.url.path) sha256=\(sha) version=\(existing.version)")
            progress(.inspected(path: existing.url.path, sha256: sha))
            current = IsoManifestCurrent(version: existing.version, sha256: sha)
        } else {
            log("base-iso cache: empty (no cached \(arch.rawValue) base ISO)")
            progress(.inspected(path: nil, sha256: nil))
        }

        // (b) POST the manifest with `current`.
        let request = IsoManifestRequest(platform: "mac",
                                         burnerVersion: burnerVersion,
                                         current: current,
                                         arch: arch)
        let response = try await client.fetch(request)

        // (c) If ordered → download + verify; else keep the cache. null with
        // NOTHING cached means the server has no manifest for this arch at
        // all — surfaced as unavailable, never as "up to date".
        guard let order = response.download else {
            guard let existing else { throw CacheError.noBaseAvailable(arch) }
            log("base-iso: server ordered no change — keeping cached \(existing.url.path)")
            let sha = try current?.sha256 ?? Self.sha256OfFile(at: existing.url)
            progress(.ready(path: existing.url.path, sha256: sha, fromCache: true))
            return existing.url
        }

        return try await download(order: order, dir: dir, progress: progress)
    }

    // MARK: - Download + stream-verify

    private func download(order: IsoManifestDownload,
                          dir: URL,
                          progress: @escaping @Sendable (Phase) -> Void) async throws -> URL {
        guard let url = URL(string: order.url) else {
            throw CacheError.offline("server returned a malformed download URL")
        }
        let dest = Self.cachedURL(version: order.version, arch: arch, dir: dir)

        progress(.downloading(url: order.url, version: order.version, progress: 0))

        let (bytes, response): (URLSession.AsyncBytes, URLResponse)
        do {
            (bytes, response) = try await downloadSession.bytes(from: url)
        } catch let e as URLError {
            throw CacheError.offline(e.localizedDescription)
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw CacheError.httpStatus(http.statusCode)
        }
        // Prefer the server-quoted size; fall back to the HTTP length.
        let expectedLen: Int64 = order.sizeBytes > 0
            ? Int64(order.sizeBytes)
            : response.expectedContentLength

        let tmp = dest.appendingPathExtension("partial")
        FileManager.default.createFile(atPath: tmp.path, contents: nil)
        let handle = try FileHandle(forWritingTo: tmp)
        var hasher = SHA256()
        var received: Int64 = 0
        var buffer = Data(capacity: 1 << 20)
        do {
            for try await byte in bytes {
                buffer.append(byte)
                if buffer.count >= (1 << 20) {
                    handle.write(buffer)
                    hasher.update(data: buffer)
                    received += Int64(buffer.count)
                    buffer.removeAll(keepingCapacity: true)
                    if expectedLen > 0 {
                        progress(.downloading(url: order.url, version: order.version,
                                              progress: min(1.0, Double(received) / Double(expectedLen))))
                    }
                }
            }
        } catch let e as URLError {
            try? handle.close(); try? FileManager.default.removeItem(at: tmp)
            throw CacheError.offline(e.localizedDescription)
        }
        if !buffer.isEmpty {
            handle.write(buffer); hasher.update(data: buffer); received += Int64(buffer.count)
        }
        try? handle.close()
        progress(.downloading(url: order.url, version: order.version, progress: 1.0))

        // Stream-verify the downloaded bytes' sha256 against the manifest's.
        let got = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard got == order.sha256.lowercased() else {
            try? FileManager.default.removeItem(at: tmp)
            throw CacheError.checksumMismatch(expected: order.sha256, got: got)
        }

        // Atomic move into place.
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: tmp, to: dest)
        // A fresh order supersedes any older cached base OF THIS ARCH — drop
        // stale versions so the next inspect reports the new one. Other
        // arches' bases are untouched (the burn base survives a host fetch).
        Self.pruneOtherBases(keeping: dest, arch: arch, in: dir)

        log("downloaded \(dest.path) sha256=\(got) from \(order.url)")
        progress(.ready(path: dest.path, sha256: got, fromCache: false))
        return dest
    }

    // MARK: - Helpers

    static func pruneOtherBases(keeping keep: URL, arch: IsoArch, in dir: URL) {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(atPath: dir.path) else { return }
        for name in entries {
            guard version(ofCachedName: name, arch: arch) != nil else { continue }
            let url = dir.appendingPathComponent(name)
            if url.standardizedFileURL != keep.standardizedFileURL {
                try? fm.removeItem(at: url)
            }
        }
    }

    /// Streaming SHA-256 of a file (so a ~300 MB ISO isn't loaded into memory).
    static func sha256OfFile(at url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 1 << 20) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
