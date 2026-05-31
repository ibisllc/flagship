import Foundation
import CryptoKit
import Argon2Kit
import FlagshipCore

/// `.flagshipkey` — a passphrase-wrapped, portable backup of the User
/// Master Key. Byte-compatible with `packages/protocol/src/keyfile.ts`.
///
/// The UMK seed (32 bytes) is the ENTIRE account: IRK/BAK/SWK/STK all
/// HKDF-derive from it, so this file is the keys to the kingdom — anyone
/// with the file AND the passphrase can fully control the account. It is
/// the cloud-independent recovery + cross-device backup path. Surfaces
/// MUST wrap export in heavy warnings and never auto-sync this file.
///
/// Format: JSON, binary fields hex. A self-describing header is bound
/// into the AES-256-GCM AAD, so tampering any header field (username,
/// version, kdf params) fails decryption. The argon2id-derived key
/// (params recorded in-file so they can be raised later without breaking
/// old files) wraps the 32-byte seed.
public enum Keyfile {

    public static let magic = "flagship-key"
    public static let version = 1

    /// memory in KiB (m), iterations (t), parallelism (p).
    public struct ArgonParams: Sendable, Equatable {
        public let m: Int
        public let t: Int
        public let p: Int
        public init(m: Int, t: Int, p: Int) {
            self.m = m; self.t = t; self.p = p
        }
    }

    /// Strong interactive default. Recorded in the file so a future
    /// version can raise it and old files still unwrap with their own
    /// recorded params. Matches `KEYFILE_ARGON_PARAMS` on the TS side.
    public static let argonParams = ArgonParams(m: 65536, t: 3, p: 4)

    /// Floor only — surfaces enforce real passphrase strength in the UI.
    public static let minPassphrase = 8

    public struct Meta: Sendable, Equatable {
        public let username: String
        public let accountId: String?
        /// ISO-8601
        public let createdAt: String
        public init(username: String, accountId: String?, createdAt: String) {
            self.username = username
            self.accountId = accountId
            self.createdAt = createdAt
        }
    }

    public enum KeyfileError: Error, LocalizedError, Equatable {
        /// Not a flagship key file / not valid JSON / structurally bad.
        case malformed(String)
        /// Wrong passphrase or corrupted/tampered ciphertext.
        case badPassphrase
        /// Unsupported version.
        case version(Int)

        public var errorDescription: String? {
            switch self {
            case .malformed(let m): return "This isn't a Flagship key file. (\(m))"
            case .badPassphrase:    return "That passphrase didn't open the file."
            case .version(let v):   return "Unsupported key file version \(v)."
            }
        }
    }

    /// Canonical AAD binding the human-meaningful header to the
    /// ciphertext. MUST match `aadBytes` in keyfile.ts byte-for-byte.
    static func aad(
        version: Int,
        username: String,
        accountId: String?,
        createdAt: String,
        params: ArgonParams
    ) -> Data {
        let s = [
            "flagship/keyfile/v1",
            String(version),
            username,
            accountId ?? "",
            createdAt,
            "argon2id|m=\(params.m)|t=\(params.t)|p=\(params.p)",
            "aes-256-gcm",
        ].joined(separator: "|")
        return Data(s.utf8)
    }

    /// argon2id KDF. input = UTF8(passphrase); dkLen = 32. Maps the
    /// file's m (memory KiB) / t (iterations) / p (parallelism) onto the
    /// reference C library via Argon2Kit. Pinned to argon2id + V13.
    static func deriveKey(passphrase: String, salt: Data, params: ArgonParams) throws -> SymmetricKey {
        let digest = try Argon2.hash(
            password: Data(passphrase.utf8),
            salt: salt,
            iterations: UInt32(params.t),
            memory: UInt32(params.m),
            threads: UInt32(params.p),
            length: 32,
            type: .id,
            version: .v13
        )
        return SymmetricKey(data: digest.rawData)
    }

    // MARK: - Wrap (export)

    /// Wrap a 32-byte UMK seed into `.flagshipkey` text. `params` is
    /// injectable for tests; production callers should omit it.
    public static func wrap(
        umkSeed: Data,
        passphrase: String,
        meta: Meta,
        params: ArgonParams = Keyfile.argonParams
    ) throws -> String {
        guard umkSeed.count == 32 else {
            throw KeyfileError.malformed("UMK seed must be 32 bytes")
        }
        guard passphrase.count >= minPassphrase else {
            throw KeyfileError.malformed("passphrase too short (min \(minPassphrase))")
        }
        var saltBytes = [UInt8](repeating: 0, count: 16)
        _ = saltBytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let salt = Data(saltBytes)

        let nonceBytes = (0..<12).map { _ in UInt8.random(in: 0...255) }
        let nonceData = Data(nonceBytes)
        let nonce = try AES.GCM.Nonce(data: nonceData)

        let key = try deriveKey(passphrase: passphrase, salt: salt, params: params)
        let aadData = aad(
            version: version,
            username: meta.username,
            accountId: meta.accountId,
            createdAt: meta.createdAt,
            params: params
        )
        let sealed = try AES.GCM.seal(umkSeed, using: key, nonce: nonce, authenticating: aadData)
        // TS ciphertextHex = plaintext-ciphertext + 16-byte GCM tag.
        let ciphertext = sealed.ciphertext + sealed.tag

        return envelopeJSON(
            meta: meta,
            params: params,
            saltHex: HexUtil.encode(salt),
            nonceHex: HexUtil.encode(nonceData),
            ciphertextHex: HexUtil.encode(ciphertext)
        )
    }

    // MARK: - Unwrap (import)

    /// Wrap a UMK seed held as a CryptoKit SymmetricKey.
    public static func wrap(
        umkSeed: SymmetricKey,
        passphrase: String,
        meta: Meta,
        params: ArgonParams = Keyfile.argonParams
    ) throws -> String {
        try wrap(
            umkSeed: umkSeed.withUnsafeBytes { Data($0) },
            passphrase: passphrase,
            meta: meta,
            params: params
        )
    }

    /// Parse + decrypt a `.flagshipkey` file. Throws KeyfileError on
    /// any failure (malformed / wrong-passphrase / version).
    public static func unwrap(
        fileText: String,
        passphrase: String
    ) throws -> (umkSeed: SymmetricKey, meta: Meta) {
        guard let data = fileText.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw KeyfileError.malformed("not valid JSON")
        }
        guard (obj["magic"] as? String) == magic else {
            throw KeyfileError.malformed("not a flagship key file")
        }
        guard let ver = obj["version"] as? Int else {
            throw KeyfileError.malformed("missing version")
        }
        guard ver == version else {
            throw KeyfileError.version(ver)
        }
        guard let kdf = obj["kdf"] as? [String: Any],
              (kdf["algo"] as? String) == "argon2id",
              (obj["aead"] as? String) == "aes-256-gcm" else {
            throw KeyfileError.malformed("unsupported kdf/aead")
        }
        guard let m = intValue(kdf["m"]),
              let t = intValue(kdf["t"]),
              let p = intValue(kdf["p"]),
              let saltHex = kdf["saltHex"] as? String,
              let username = obj["username"] as? String,
              let createdAt = obj["createdAt"] as? String,
              let nonceHex = obj["nonceHex"] as? String,
              let ciphertextHex = obj["ciphertextHex"] as? String,
              let salt = HexUtil.decode(saltHex),
              let nonceData = HexUtil.decode(nonceHex),
              let ctAndTag = HexUtil.decode(ciphertextHex) else {
            throw KeyfileError.malformed("missing or malformed fields")
        }
        guard ctAndTag.count >= 16 else {
            throw KeyfileError.malformed("ciphertext too short")
        }
        let accountId = obj["accountId"] as? String
        let params = ArgonParams(m: m, t: t, p: p)

        let key = try deriveKey(passphrase: passphrase, salt: salt, params: params)
        let aadData = aad(
            version: ver,
            username: username,
            accountId: accountId,
            createdAt: createdAt,
            params: params
        )
        // ciphertextHex is plaintext-ciphertext + 16B tag appended.
        let tag = ctAndTag.suffix(16)
        let ciphertext = ctAndTag.prefix(ctAndTag.count - 16)
        do {
            let nonce = try AES.GCM.Nonce(data: nonceData)
            let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
            let seed = try AES.GCM.open(box, using: key, authenticating: aadData)
            guard seed.count == 32 else {
                throw KeyfileError.malformed("decrypted seed is not 32 bytes")
            }
            return (
                SymmetricKey(data: seed),
                Meta(username: username, accountId: accountId, createdAt: createdAt)
            )
        } catch let e as KeyfileError {
            throw e
        } catch {
            throw KeyfileError.badPassphrase
        }
    }

    // MARK: - Helpers

    /// Build the envelope JSON. We emit it by hand (rather than
    /// JSONEncoder) to guarantee the field set + accountId-omission
    /// match the TS writer's shape exactly.
    private static func envelopeJSON(
        meta: Meta,
        params: ArgonParams,
        saltHex: String,
        nonceHex: String,
        ciphertextHex: String
    ) -> String {
        var root: [String: Any] = [
            "magic": magic,
            "version": version,
            "username": meta.username,
            "createdAt": meta.createdAt,
            "kdf": [
                "algo": "argon2id",
                "m": params.m,
                "t": params.t,
                "p": params.p,
                "saltHex": saltHex,
            ],
            "aead": "aes-256-gcm",
            "nonceHex": nonceHex,
            "ciphertextHex": ciphertextHex,
        ]
        if let accountId = meta.accountId {
            root["accountId"] = accountId
        }
        let data = (try? JSONSerialization.data(
            withJSONObject: root,
            options: [.prettyPrinted, .sortedKeys]
        )) ?? Data()
        let json = String(data: data, encoding: .utf8) ?? "{}"
        return json + "\n"
    }

    private static func intValue(_ any: Any?) -> Int? {
        if let i = any as? Int { return i }
        if let n = any as? NSNumber { return n.intValue }
        if let d = any as? Double { return Int(d) }
        return nil
    }
}
