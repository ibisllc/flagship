import Foundation
import CryptoKit

/// "Backup/clone server" (docs/server-backup-and-clone.md): the account's key
/// for a backup (the KEK of its account slot), the backup's file name, and
/// the wording around them. The format is `ServerBackupFormat`.
/// Must pass packages/protocol/test-vectors/server-archive/vectors.json.
public enum ServerArchive {
    public static let uploadChunkBytes = 4 * 1024 * 1024

    public static let excludesNote =
        "Holds your apps' source, data and settings, never system images: the new server rebuilds each app, so any Flagship server can restore it. Not included: the server's keys and certificate, peer backups, and the Git host."
    /// Why Back up now always asks for a passcode (owner, 2026-10-16).
    public static let passcodeWhy =
        "You'll need this passcode to import the backup into an account that isn't yours. Your own account opens it without the passcode."
    public static let passcodeNote =
        "Anyone with the file and this passcode can restore the backup, on any account, so keep it somewhere safe and apart from the file. It can't be reset."
    public static let peersIntro =
        "Your lost server's newest backup is kept in pieces on other Flagship servers. Name the lost server "
        + "and this phone gets the pieces back, with nothing from the lost server itself. You choose a name for the new one; "
        + "everything else comes from the backup."
    public static let importIntro =
        "Pick the backup's .flagship file from wherever you keep it. "
        + "You choose a name; everything else comes from the backup. Then set up the new server as usual, "
        + "and this screen sends it the backup as soon as it comes online."

    /// `HKDF-SHA256(umkSeed, salt: empty, info: "flagship/server-archive/v1|<archiveId>")`:
    /// the key of a backup's account slot. Independent of any server id, so any
    /// device of the account opens its backups under any new name.
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
        HexUtil.encode(ServerBackupFormat.randomBytes(16))
    }

    /// `<server label>-<yyyy-MM-dd>`: the two files are this plus `.flagship-backup` / `.flagship-data`.
    public static func fileStem(sourceServer: String, createdAt: Date) -> String {
        let label = sourceServer.split(separator: ".").first.map(String.init) ?? "server"
        let clean = label.filter { $0.isLetter || $0.isNumber || $0 == "-" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return "\(clean.isEmpty ? "server" : clean)-\(f.string(from: createdAt))"
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
