import Foundation
import CryptoKit

/// "Backup/clone server" (docs/server-backup-and-clone.md): the key that seals
/// an archive, the readable header of an archive file, and the wording around
/// both. Must pass packages/protocol/test-vectors/server-archive/vectors.json.
public enum ServerArchive {
    public static let fileExtension = "flagship-backup"
    public static let uploadChunkBytes = 4 * 1024 * 1024
    public static let headerMaxBytes = 64 * 1024

    public static let backupNote =
        "Makes one file with all of this server's apps and their data. Keep it safe: only your own devices can open it. "
        + "To clone this server, add the new server first, then choose Add/Import a server → Import a backup."
    public static let excludesNote =
        "Not included: API keys, the server's name and certificate, peer backups, and the Git host."
    public static let cloneHint =
        "To clone a server under a new name: add the new server first, then import the backup onto it."

    /// `HKDF-SHA256(umkSeed, salt: empty, info: "flagship/server-archive/v1|<archiveId>")`.
    /// Independent of any server id, so any device of the account opens an
    /// archive and imports it onto a server with a different name.
    public static func deriveKey(umkSeed: Data, archiveId: String) -> Data? {
        guard umkSeed.count == 32, isArchiveId(archiveId) else { return nil }
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: umkSeed),
            salt: Data(),
            info: Data("flagship/server-archive/v1|\(archiveId)".utf8),
            outputByteCount: 32
        )
        return key.withUnsafeBytes { Data($0) }
    }

    public static func isArchiveId(_ s: String) -> Bool {
        s.count == 32 && s.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
    }

    public static func newArchiveId() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    public struct Header: Equatable, Sendable {
        public let archiveId: String
        public let createdAt: Int64
        public let sourceServer: String
        public let appNames: [String]
    }

    public enum HeaderError: Error, Equatable, LocalizedError {
        case notABackup
        case newerVersion
        case damaged
        public var errorDescription: String? {
            switch self {
            case .notABackup: return "That isn't a Flagship backup."
            case .newerVersion: return "This backup is from a newer version of Flagship. Update the app and try again."
            case .damaged: return "This backup's header is damaged."
            }
        }
    }

    /// Reads the readable first line of an archive file (pass its first ~64 KB).
    public static func parseHeader(_ head: Data) throws -> Header {
        guard let nl = head.firstIndex(of: 0x0a),
              let obj = try? JSONSerialization.jsonObject(with: head.prefix(upTo: nl)) as? [String: Any],
              obj["magic"] as? String == "flagship-archive"
        else { throw HeaderError.notABackup }
        guard (obj["v"] as? NSNumber)?.intValue == 1 else { throw HeaderError.newerVersion }
        guard let id = obj["archiveId"] as? String, isArchiveId(id) else { throw HeaderError.damaged }
        let apps = (obj["apps"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
        return Header(
            archiveId: id,
            createdAt: (obj["createdAt"] as? NSNumber)?.int64Value ?? 0,
            sourceServer: obj["sourceServer"] as? String ?? "",
            appNames: apps
        )
    }

    /// The name a backup is offered under: `<server label>-<yyyy-MM-dd>.flagship-backup`.
    public static func fileName(sourceServer: String, createdAt: Date) -> String {
        let label = sourceServer.split(separator: ".").first.map(String.init) ?? "server"
        let clean = label.filter { $0.isLetter || $0.isNumber || $0 == "-" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return "\(clean.isEmpty ? "server" : clean)-\(f.string(from: createdAt)).\(fileExtension)"
    }

    public static func formatBytes(_ n: Int64) -> String {
        if n < 0 { return "" }
        if n < 1024 * 1024 { return "\(max(1, Int((Double(n) / 1024).rounded()))) KB" }
        if n < 1024 * 1024 * 1024 {
            let mb = Double(n) / (1024 * 1024)
            return n < 10 * 1024 * 1024 ? String(format: "%.1f MB", mb) : "\(Int(mb.rounded())) MB"
        }
        return String(format: "%.1f GB", Double(n) / (1024 * 1024 * 1024))
    }
}
