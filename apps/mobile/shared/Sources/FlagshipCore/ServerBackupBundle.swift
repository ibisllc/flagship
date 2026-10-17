import Foundation
import CryptoKit

/// The one file people keep (owner, 2026-10-16; packages/protocol/src/serverBackup.ts
/// `backupBundleHeader` / `parseBackupBundleHeader` / `backupBundleFileName`):
///
///     "FLGSHBK1" | u64 big-endian L | metadata part (L bytes: the backup file) | data part (to EOF)
///
/// L is 1...262144. The app reads the header and the metadata part only, and
/// streams the data part (never held in memory) to check it and to upload it.
/// Must pass packages/protocol/test-vectors/server-backup-bundle/vectors.json.
public enum ServerBackupBundle {
    public static let magic = "FLGSHBK1"
    public static let fileExtension = "flagship"
    public static let headerBytes = 16
    public static let maxMetaBytes = ServerBackupFormat.backupFileMaxBytes

    public enum BundleError: Error, Equatable, LocalizedError {
        case tooShort
        case notABackup
        case damagedHeader
        case cutShort
        case badLength
        case unreadable
        case dataChanged
        public var errorDescription: String? {
            switch self {
            case .tooShort: return "This file is too short to be a Flagship backup."
            case .notABackup: return "This file isn't a Flagship backup."
            case .damagedHeader: return "This backup's header is damaged."
            case .cutShort: return "This backup is cut short: it ends before its data."
            case .badLength: return "The backup's metadata part has a bad length."
            case .unreadable: return "The backup file can't be read any more (was its drive removed?)."
            case .dataChanged: return "This backup was changed or is damaged: its data doesn't match."
            }
        }
    }

    public struct Layout: Equatable, Sendable {
        public let metaOffset: Int64
        public let metaLength: Int64
        public let dataOffset: Int64
        public let dataLength: Int64
    }

    /// The 16-byte header for a metadata part of `metaLength` bytes.
    public static func header(metaLength: Int) throws -> Data {
        guard (1...maxMetaBytes).contains(metaLength) else { throw BundleError.badLength }
        var out = Data(magic.utf8)
        var be = UInt64(metaLength).bigEndian
        withUnsafeBytes(of: &be) { out.append(contentsOf: $0) }
        return out
    }

    /// Where the metadata part ends and the data part starts, for a file of
    /// `fileBytes` whose first bytes are `head`. Throws a sentence for anything
    /// that isn't a Flagship backup or is cut short.
    public static func parseHeader(_ head: Data, fileBytes: Int64) throws -> Layout {
        guard head.count >= headerBytes else { throw BundleError.tooShort }
        let bytes = [UInt8](head.prefix(headerBytes))
        guard Data(bytes[0..<8]) == Data(magic.utf8) else { throw BundleError.notABackup }
        let len = bytes[8..<16].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        guard len >= 1, len <= UInt64(maxMetaBytes) else { throw BundleError.damagedHeader }
        let dataOffset = Int64(headerBytes) + Int64(len)
        guard fileBytes > dataOffset else { throw BundleError.cutShort }
        return Layout(metaOffset: Int64(headerBytes), metaLength: Int64(len), dataOffset: dataOffset, dataLength: fileBytes - dataOffset)
    }

    /// `<stem>.flagship` for a part named `<stem>.flagship-backup` / `.flagship-data`.
    public static func fileName(forPart name: String) -> String {
        for ext in [".flagship-backup", ".flagship-data"] where name.hasSuffix(ext) {
            return String(name.dropLast(ext.count)) + "." + fileExtension
        }
        return name + "." + fileExtension
    }

    /// Whether the first bytes of a picked file are a `.flagship` file's.
    public static func looksLikeBundle(_ head: Data) -> Bool {
        head.count >= 8 && head.prefix(8) == Data(magic.utf8)
    }

    /// A whole file in memory (tests, the mock box). The box writes real ones.
    public static func make(meta: Data, data: Data) throws -> Data {
        try header(metaLength: meta.count) + meta + data
    }

    public struct Opened: Sendable {
        public let file: ServerBackupFormat.File
        public let layout: Layout
    }

    /// Read a picked `.flagship` file's header and metadata part only.
    public static func read(_ url: URL) throws -> Opened {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? -1
        guard let fh = try? FileHandle(forReadingFrom: url) else { throw BundleError.unreadable }
        defer { try? fh.close() }
        let head = (try? fh.read(upToCount: headerBytes)) ?? Data()
        let layout = try parseHeader(head, fileBytes: max(size, 0))
        guard let meta = try? fh.read(upToCount: Int(layout.metaLength)), Int64(meta.count) == layout.metaLength else {
            throw BundleError.cutShort
        }
        return Opened(file: try ServerBackupFormat.parse(meta), layout: layout)
    }

    /// Check the data part against the opened metadata without holding it:
    /// its size, its first line and its SHA-256, read in slices from `layout.dataOffset`.
    public static func checkData(
        _ url: URL,
        layout: Layout,
        against info: ServerBackupFormat.DataInfo,
        sliceBytes: Int = 8 * 1024 * 1024,
        progress: (Int64) async -> Void = { _ in }
    ) async throws {
        guard layout.dataLength == info.bytes else { throw BundleError.dataChanged }
        guard let fh = try? FileHandle(forReadingFrom: url) else { throw BundleError.unreadable }
        defer { try? fh.close() }
        do { try fh.seek(toOffset: UInt64(layout.dataOffset)) } catch { throw BundleError.unreadable }
        var h = SHA256()
        var read: Int64 = 0
        while read < info.bytes {
            try Task.checkCancellation()
            let want = Int(min(Int64(sliceBytes), info.bytes - read))
            guard let part = try? fh.read(upToCount: want), !part.isEmpty else { throw BundleError.unreadable }
            if read == 0, !part.starts(with: Data(ServerBackupFormat.dataMagic.utf8)) { throw BundleError.dataChanged }
            h.update(data: part)
            read += Int64(part.count)
            await progress(read)
        }
        guard HexUtil.encode(Data(h.finalize())) == info.sha256 else { throw BundleError.dataChanged }
    }

    /// Up to `count` bytes of the data part from `offset` within it (the restore upload).
    public static func readData(_ fh: FileHandle, layout: Layout, offset: Int64, count: Int) throws -> Data {
        try fh.seek(toOffset: UInt64(layout.dataOffset + offset))
        let want = Int(min(Int64(count), layout.dataLength - offset))
        guard want > 0, let d = try fh.read(upToCount: want), !d.isEmpty else { throw BundleError.unreadable }
        return d
    }
}
