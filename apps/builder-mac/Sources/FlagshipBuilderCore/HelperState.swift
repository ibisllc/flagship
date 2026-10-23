import Foundation
import CryptoKit
import Darwin

/// What the root helper keeps between calls (SEC-MAC-002): the images it staged,
/// the disks it registered and the progress it reported. Every id is 128 random
/// bits the helper issued; each is tied to the user that asked, expires, and
/// means nothing to any other connection. Pure of XPC so it is testable without
/// root.
public final class HelperState {
    public enum Refusal: LocalizedError, Equatable {
        case notAFile
        case badSize
        case stageFailed(String)
        case tooManyStaged
        case unknownImage
        case unknownMedia

        public var errorDescription: String? {
            switch self {
            case .notAFile: return "Refusing the image: it is not a regular file."
            case .badSize: return "Refusing the image: unreasonable size."
            case .stageFailed(let w): return "Couldn't stage the image: \(w)."
            case .tooManyStaged: return "Too many images are waiting; finish or wait for one to expire."
            case .unknownImage: return "That image is not staged (it expired, was used or is not yours)."
            case .unknownMedia: return "That disk is not registered (it expired or is not yours)."
            }
        }
    }

    public struct Staged: Equatable {
        public let id: String
        public let path: String
        public let size: Int64
        public let sha256: String
        public let uid: uid_t
        public let expiresAt: Date
    }

    public struct Media {
        public let id: String
        public let facts: HelperPolicy.DiskFacts
        public let uid: uid_t
        public let expiresAt: Date
    }

    private let dir: String
    private let now: () -> Date
    private let ttl: TimeInterval
    private let maxStaged: Int
    private let lock = NSLock()
    private var staged: [String: Staged] = [:]
    private var media: [String: Media] = [:]
    private var progress: [String: [String]] = [:]
    private var owner: [String: uid_t] = [:]
    private static let maxProgressLines = 4096

    public init(stagingDir: String, ttl: TimeInterval = 30 * 60, maxStaged: Int = 2, now: @escaping () -> Date = Date.init) {
        self.dir = stagingDir
        self.ttl = ttl
        self.maxStaged = maxStaged
        self.now = now
    }

    static func newID() -> String {
        var b = [UInt8](repeating: 0, count: 16)
        precondition(SecRandomCopyBytes(kSecRandomDefault, b.count, &b) == errSecSuccess)
        return b.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: staging

    /// Copy the open descriptor's bytes into a fresh root-only file. The descriptor is the client's own: whatever
    /// it can read is all it can offer, and the helper never opens a path the client names.
    public func stage(from handle: FileHandle, clientUID: uid_t) throws -> Staged {
        sweep()
        lock.lock()
        let count = staged.values.filter { $0.uid == clientUID }.count
        lock.unlock()
        guard count < maxStaged else { throw Refusal.tooManyStaged }

        let src = handle.fileDescriptor
        var st = stat()
        guard fstat(src, &st) == 0, st.st_mode & S_IFMT == S_IFREG else { throw Refusal.notAFile }
        let size = Int64(st.st_size)
        guard size >= HelperPolicy.minImageBytes, size <= HelperPolicy.maxImageBytes else { throw Refusal.badSize }

        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let id = Self.newID()
        let path = dir + "/" + id + ".img"
        let out = path.withCString { Darwin.open($0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600) }
        guard out >= 0 else { throw Refusal.stageFailed("can't create it (\(String(cString: strerror(errno))))") }
        var ok = false
        defer {
            Darwin.close(out)
            if !ok { _ = unlink(path) }
        }
        var hasher = SHA256()
        var copied: Int64 = 0
        let chunk = 1 << 20
        var buf = [UInt8](repeating: 0, count: chunk)
        while copied < size {
            let want = Int(min(Int64(chunk), size - copied))
            let n = pread(src, &buf, want, off_t(copied))
            if n < 0 { throw Refusal.stageFailed("read failed (\(String(cString: strerror(errno))))") }
            if n == 0 { break }
            hasher.update(data: Data(buf[0..<n]))
            var written = 0
            while written < n {
                let w = buf.withUnsafeBytes { Darwin.write(out, $0.baseAddress!.advanced(by: written), n - written) }
                if w < 0 { throw Refusal.stageFailed("write failed (\(String(cString: strerror(errno))))") }
                written += w
            }
            copied += Int64(n)
        }
        // The file changed under the copy, or ended early: refuse rather than write something half-made.
        guard copied == size else { throw Refusal.stageFailed("the file changed while it was copied") }
        var after = stat()
        guard fstat(src, &after) == 0, Int64(after.st_size) == size else { throw Refusal.stageFailed("the file changed while it was copied") }
        _ = fsync(out)
        let s = Staged(id: id, path: path, size: size, sha256: hasher.finalize().map { String(format: "%02x", $0) }.joined(), uid: clientUID, expiresAt: now().addingTimeInterval(ttl))
        lock.lock()
        staged[id] = s
        owner[id] = clientUID
        if owner.count > 16, let oldest = owner.keys.first(where: { staged[$0] == nil }) {
            owner.removeValue(forKey: oldest)
            progress.removeValue(forKey: oldest)
        }
        lock.unlock()
        ok = true
        return s
    }

    /// The staged image for this id and user, left in place until `finish`.
    public func staged(id: String, clientUID: uid_t) throws -> Staged {
        sweep()
        lock.lock(); defer { lock.unlock() }
        guard let s = staged[id], s.uid == clientUID else { throw Refusal.unknownImage }
        return s
    }

    /// Open the staged copy for reading (the helper's own file, never a client path).
    public func open(_ s: Staged) throws -> FileHandle {
        let fd = s.path.withCString { Darwin.open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC) }
        guard fd >= 0 else { throw Refusal.stageFailed("can't reopen it") }
        return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }

    /// The write is over (either way): the staged bytes go, and a second write of the same id is refused.
    public func finish(imageID: String) {
        lock.lock()
        let s = staged.removeValue(forKey: imageID)
        lock.unlock()
        if let s = s { _ = unlink(s.path) }
    }

    // MARK: media

    public func register(facts: HelperPolicy.DiskFacts, clientUID: uid_t) -> Media {
        sweep()
        let m = Media(id: Self.newID(), facts: facts, uid: clientUID, expiresAt: now().addingTimeInterval(ttl))
        lock.lock()
        if media.count >= 64 { media.removeValue(forKey: media.keys.first!) }
        media[m.id] = m
        lock.unlock()
        return m
    }

    public func media(id: String, clientUID: uid_t) throws -> Media {
        sweep()
        lock.lock(); defer { lock.unlock() }
        guard let m = media[id], m.uid == clientUID else { throw Refusal.unknownMedia }
        return m
    }

    // MARK: progress

    public func append(_ line: String, imageID: String) {
        lock.lock(); defer { lock.unlock() }
        var lines = progress[imageID] ?? []
        if lines.count >= Self.maxProgressLines { lines.removeFirst(lines.count - Self.maxProgressLines + 1) }
        lines.append(line)
        progress[imageID] = lines
    }

    /// Lines from `from` on, and where to resume. The progress of an image the caller does not own is empty.
    public func read(imageID: String, clientUID: uid_t, from: Int) -> (next: Int, lines: [String]) {
        lock.lock(); defer { lock.unlock() }
        guard let lines = progress[imageID], owner[imageID] == clientUID else { return (from, []) }
        let start = max(0, from)
        return (lines.count, start < lines.count ? Array(lines[start...]) : [])
    }

    // MARK: expiry

    public func sweep() {
        let t = now()
        lock.lock()
        let dead = staged.values.filter { $0.expiresAt <= t }
        for s in dead { staged.removeValue(forKey: s.id) }
        media = media.filter { $0.value.expiresAt > t }
        lock.unlock()
        for s in dead { _ = unlink(s.path) }
    }
}
