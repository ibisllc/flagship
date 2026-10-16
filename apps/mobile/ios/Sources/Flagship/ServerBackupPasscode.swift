import Foundation
import FlagshipAPI
import FlagshipCore
import FlagshipArgon2

/// The passcode side of a server backup (docs/server-backup-and-clone.md):
/// the key of a backup file's passcode slot is Argon2id v1.3 of the passcode
/// (NFC, surrounding spaces dropped) under the slot's salt and cost. Pinned by
/// packages/protocol/test-vectors/server-backup/vectors.json.
public enum ServerBackupPasscode {
    /// Argon2id of the normalized passcode. Slow on purpose (about a second at
    /// the default cost): call it off the main actor.
    public static func kek(passcode: String, kdf: ServerBackupKdf) throws -> Data {
        guard kdf.isValid, let salt = HexUtil.decode(kdf.saltHex) else { throw ServerBackupFormat.FormatError.damaged }
        let digest = try Argon2.hash(
            password: Data(ServerBackupFormat.normalizePasscode(passcode).utf8),
            salt: salt,
            iterations: UInt32(kdf.t),
            memory: UInt32(kdf.m),
            threads: UInt32(kdf.p),
            length: 32,
            type: .id,
            version: .v13
        )
        return digest.rawData
    }

    /// A passcode slot for `contentKey`, with a fresh salt and nonce.
    public static func slot(archiveId: String, contentKey: Data, passcode: String,
                            m: Int = ServerBackupFormat.defaultArgon.m,
                            t: Int = ServerBackupFormat.defaultArgon.t,
                            p: Int = ServerBackupFormat.defaultArgon.p) throws -> ServerBackupSlot {
        let kdf = ServerBackupKdf(m: m, t: t, p: p, saltHex: HexUtil.encode(ServerBackupFormat.randomBytes(16)))
        return try ServerBackupFormat.wrapPasscodeSlot(
            archiveId: archiveId, contentKey: contentKey, kek: try kek(passcode: passcode, kdf: kdf),
            kdf: kdf, nonce: ServerBackupFormat.randomBytes(12)
        )
    }

    /// Open a backup file with its passcode (off the main actor).
    public static func open(_ file: ServerBackupFormat.File, passcode: String) async throws -> ServerBackupFormat.Opened {
        guard let kdf = file.passcodeSlot?.kdf else { throw ServerBackupFormat.FormatError.noPasscode }
        let key = try await Task.detached(priority: .userInitiated) { try Self.kek(passcode: passcode, kdf: kdf) }.value
        return try ServerBackupFormat.openWithPasscodeKey(file, kek: key)
    }
}
