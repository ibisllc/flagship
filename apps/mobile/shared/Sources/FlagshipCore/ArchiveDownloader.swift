import Foundation
import CryptoKit

/// Downloads a server backup in fixed-size parts, several at once, writing each
/// part straight to its place in the file, and remembering which parts are in
/// so an interrupted download picks up where it stopped. The finished file is
/// checked against the SHA-256 the server reported. Used by the Backup/clone
/// sheet (docs/server-backup-and-clone.md).
public enum ArchiveDownloader {
    /// What the box hands out per `GET .../chunk?offset=` (serverArchive/service.ts).
    public static let chunkBytes: Int64 = 4 * 1024 * 1024
    public static let parallel = 4

    struct State: Codable, Equatable {
        var total: Int64
        var sha256: String?
        var done: Set<Int64>
    }

    public enum DownloadError: Error, Equatable, LocalizedError {
        case shortPart(offset: Int64)
        case damaged
        public var errorDescription: String? {
            switch self {
            case .shortPart: return "The server sent a short piece of the backup. Try again; the download resumes."
            case .damaged: return "The downloaded backup doesn't match the server's copy. Try downloading it again."
            }
        }
    }

    /// Download `total` bytes into `file`. `stateFile` records finished parts;
    /// a matching one (same size and hash) resumes, anything else starts over.
    public static func download(
        total: Int64,
        sha256: String?,
        to file: URL,
        stateFile: URL,
        chunkBytes: Int64 = chunkBytes,
        parallel: Int = parallel,
        fetch: @escaping @Sendable (_ offset: Int64) async throws -> Data,
        progress: @escaping @Sendable (_ received: Int64) async -> Void = { _ in }
    ) async throws {
        let fm = FileManager.default
        var state = (try? JSONDecoder().decode(State.self, from: Data(contentsOf: stateFile))) ?? State(total: -1, sha256: nil, done: [])
        if state.total != total || state.sha256 != sha256 || !fm.fileExists(atPath: file.path) {
            state = State(total: total, sha256: sha256, done: [])
            try? fm.removeItem(at: file)
            fm.createFile(atPath: file.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete])
        }
        let fh = try FileHandle(forWritingTo: file)
        defer { try? fh.close() }
        try fh.truncate(atOffset: UInt64(total))

        let offsets = stride(from: Int64(0), to: total, by: Int(chunkBytes)).map { $0 }
        var pending = offsets.filter { !state.done.contains($0) }[...]
        func length(_ offset: Int64) -> Int64 { min(chunkBytes, total - offset) }
        var received = state.done.reduce(Int64(0)) { $0 + length($1) }
        await progress(received)

        try await withThrowingTaskGroup(of: (Int64, Data).self) { group in
            func launch() {
                guard let next = pending.popFirst() else { return }
                group.addTask { (next, try await fetch(next)) }
            }
            for _ in 0..<max(1, parallel) { launch() }
            while let (offset, data) = try await group.next() {
                guard Int64(data.count) == length(offset) else { throw DownloadError.shortPart(offset: offset) }
                try fh.seek(toOffset: UInt64(offset))
                try fh.write(contentsOf: data)
                state.done.insert(offset)
                try? JSONEncoder().encode(state).write(to: stateFile, options: .atomic)
                received += Int64(data.count)
                await progress(received)
                launch()
            }
        }
        try fh.synchronize()

        if let expected = sha256, !expected.isEmpty {
            guard try fileSha256(file) == expected.lowercased() else {
                try? fm.removeItem(at: file)
                try? fm.removeItem(at: stateFile)
                throw DownloadError.damaged
            }
        }
        try? fm.removeItem(at: stateFile)
    }

    static func fileSha256(_ url: URL) throws -> String {
        let fh = try FileHandle(forReadingFrom: url)
        defer { try? fh.close() }
        var h = SHA256()
        while let d = try fh.read(upToCount: 1 << 20), !d.isEmpty { h.update(data: d) }
        return h.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
