import Foundation
import CryptoKit

/// One-time base-ISO cache. The burner downloads the stock Flagship Alpine base
/// ISO ONCE, verifies its sha256, and keeps it in ~/Library/Caches. Every
/// subsequent server reuses the cached copy — no re-download — so the user only
/// ever pays the ~240 MB transfer the first time. The recipe trailer is then
/// appended locally (AlpinePersonalize).
public enum BaseIsoCache {
    /// Pinned base ISO. Bump both together when the base is rebuilt; ideally a
    /// future `/api/iso-manifest` makes this dynamic.
    public static let version = "alpine-3.21.0"
    public static let sha256Hex = "f63e57b0ad4a94444f3141bf29877dbe4502553725b7c883900215ad4d3c08cd"
    /// Served straight from R2 via the /build/iso/:filename route (returns the
    /// R2 body directly — runtime-native, no truncation).
    public static let url = URL(string: "https://flagshipserver.com/build/iso/flagship-alpine-base.iso")!

    /// After this long, the next apkovl burn does ONE quiet HEAD to see whether
    /// a newer base was published — so a long-lived cache doesn't silently miss
    /// an update, without re-checking on every single burn.
    public static let maxCacheAge: TimeInterval = 7 * 24 * 3600

    public enum CacheError: LocalizedError {
        case offline(String)
        case httpStatus(Int)
        case checksumMismatch(expected: String, got: String)
        case noCacheDir

        public var errorDescription: String? {
            switch self {
            case .offline(let why):
                return "Couldn't download the base image — check your internet connection. (\(why))"
            case .httpStatus(let code):
                return "Base-image download failed (HTTP \(code))."
            case .checksumMismatch(let e, let g):
                return "Base image failed its integrity check (expected \(e.prefix(12))…, got \(g.prefix(12))…). Try again."
            case .noCacheDir:
                return "Couldn't open the cache directory."
            }
        }
    }

    public static func cachedURL() throws -> URL {
        let fm = FileManager.default
        guard let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            throw CacheError.noCacheDir
        }
        let dir = caches.appendingPathComponent("flagship-burner", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("flagship-base-\(version).iso")
    }

    /// True if a verified base ISO is already cached (so the UI can skip the
    /// "one-time download" phase + its messaging).
    public static func isCached() -> Bool {
        guard let url = try? cachedURL(),
              FileManager.default.fileExists(atPath: url.path) else { return false }
        return true
    }

    /// Return the cached base ISO, downloading + verifying it once if absent.
    /// `progress` is called 0…1 during the download phase only. `onPhase` fires
    /// once with `true` if a download is actually starting (so the UI can show
    /// the one-time-download banner) or `false` if served from cache.
    public static func ensure(progress: @escaping (Double) -> Void,
                              onDownloadStart: @escaping () -> Void = {},
                              notice: @escaping (String) -> Void = { _ in }) async throws -> URL {
        let dest = try cachedURL()
        let fm = FileManager.default
        if fm.fileExists(atPath: dest.path) {
            let mtime = (try? fm.attributesOfItem(atPath: dest.path)[.modificationDate]) as? Date ?? .distantPast
            if Date().timeIntervalSince(mtime) < maxCacheAge {
                return dest   // fresh — use directly, no network touched
            }
            // Stale (> a week): ONE quiet HEAD to see if a newer base shipped.
            if let remoteTag = await headETag() {
                if remoteTag == storedETag(for: dest) {
                    touch(dest)   // unchanged upstream — reset the week
                } else {
                    notice("a newer base image is available — update the Flagship Assembler to use it")
                    storeETag(remoteTag, for: dest)
                    touch(dest)   // re-check (and re-warn) at most once per week
                }
            }
            // HEAD failed (offline) → keep the valid cache; never block a burn.
            return dest
        }
        onDownloadStart()

        let (bytes, response): (URLSession.AsyncBytes, URLResponse)
        do {
            (bytes, response) = try await URLSession.shared.bytes(from: url)
        } catch let e as URLError {
            throw CacheError.offline(e.localizedDescription)
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw CacheError.httpStatus(http.statusCode)
        }
        let expectedLen = response.expectedContentLength  // -1 if unknown

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
                    if expectedLen > 0 { progress(min(1.0, Double(received) / Double(expectedLen))) }
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
        progress(1.0)

        let got = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard got == sha256Hex else {
            try? FileManager.default.removeItem(at: tmp)
            throw CacheError.checksumMismatch(expected: sha256Hex, got: got)
        }
        // Atomic move into place.
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: tmp, to: dest)
        if let tag = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "ETag") {
            storeETag(tag, for: dest)
        }
        return dest
    }

    // MARK: - Freshness helpers

    private static func etagSidecar(for dest: URL) -> URL { dest.appendingPathExtension("etag") }
    private static func storedETag(for dest: URL) -> String? {
        try? String(contentsOf: etagSidecar(for: dest), encoding: .utf8)
    }
    private static func storeETag(_ tag: String, for dest: URL) {
        try? tag.write(to: etagSidecar(for: dest), atomically: true, encoding: .utf8)
    }
    private static func touch(_ url: URL) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
    }
    /// Lightweight conditional check — a HEAD for the ETag. Returns nil when the
    /// network is unreachable, so the caller keeps using the valid cache rather
    /// than blocking the burn.
    private static func headETag() async -> String? {
        var req = URLRequest(url: url)
        req.httpMethod = "HEAD"
        req.timeoutInterval = 8
        guard let (_, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse else { return nil }
        return http.value(forHTTPHeaderField: "ETag")
    }
}
