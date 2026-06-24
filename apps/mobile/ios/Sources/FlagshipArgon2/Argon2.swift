import Foundation
import CArgon2

/// Thin Swift wrapper over the locally-vendored `phc-winner-argon2` reference
/// C library (see `apps/mobile/ios/Vendor/CArgon2`). This replaces the former
/// external `Argon2Kit` SPM package — which pulled the C library as a git
/// SUBMODULE whose clone was intermittently flaky in this environment ("Missing
/// package product 'Argon2Kit'"). Vendoring the SAME source at the SAME
/// revision keeps the output byte-identical, so the `.flagshipkey` backup KDF
/// and the recovery KDF stay cross-platform compatible with Android
/// (BouncyCastle) + the webapp (WASM).
///
/// The public surface deliberately matches the subset of Argon2Kit's API the
/// two call sites (`Keyfile`, `RecoveryDerivation`) use:
/// `Argon2.hash(...).rawData`, plus the `Type` / `Version` enums.
public enum Argon2 {

    /// Argon2 variant.
    public enum `Type`: UInt32 {
        case d = 0
        case i = 1
        case id = 2

        fileprivate var argon2type: argon2_type { argon2_type(rawValue: rawValue) }
    }

    /// Argon2 algorithm version.
    public enum Version: UInt32 {
        case v10 = 0x10
        case v13 = 0x13

        public static var latest: Version { .v13 }
    }

    /// Error thrown when the underlying C library reports a non-OK status.
    /// `code` is the raw libargon2 error code; `message` is its human string.
    public struct Argon2Error: Error, CustomStringConvertible {
        public let code: Int32
        public let message: String
        public var description: String { "[\(code)] \(message)" }
    }

    /// The result of a hash. Mirrors Argon2Kit's `Digest` surface — only
    /// `rawData` is consumed by the call sites; `encodedData`/`encodedString`
    /// are provided for parity (unused today).
    public struct Digest: Hashable {
        public let hash: Data
        public let encoded: Data

        /// The raw Argon2 output bytes.
        public var rawData: Data { hash }
        /// The `$argon2id$v=...$m=...,t=...,p=...$salt$hash` encoded form.
        public var encodedData: Data { encoded }
        /// The encoded form as a String.
        public var encodedString: String { String(data: encoded, encoding: .utf8) ?? "" }
    }

    /// Hash `password` with Argon2. Parameters map 1:1 onto the reference C
    /// `argon2_hash`: `iterations`→t_cost, `memory`→m_cost (KiB),
    /// `threads`→parallelism, `length`→hashlen.
    public static func hash(
        password: Data,
        salt: Data,
        iterations: UInt32,
        memory: UInt32,
        threads: UInt32,
        length: UInt32,
        type: `Type`,
        version: Version
    ) throws -> Digest {
        let pwd = [UInt8](password)
        let saltBytes = [UInt8](salt)

        let encodedLen = argon2_encodedlen(
            iterations, memory, threads,
            UInt32(saltBytes.count), length, type.argon2type
        )

        var hashOut = [UInt8](repeating: 0, count: Int(length))
        var encodedOut = [Int8](repeating: 0, count: encodedLen)

        let rc = argon2_hash(
            iterations, memory, threads,
            pwd, pwd.count,
            saltBytes, saltBytes.count,
            &hashOut, Int(length),
            &encodedOut, encodedLen,
            type.argon2type, version.rawValue
        )

        guard rc == ARGON2_OK.rawValue else {
            let msg = String(cString: argon2_error_message(rc))
            throw Argon2Error(code: rc, message: msg)
        }

        let hashData = Data(hashOut)
        // encodedOut is a NUL-terminated C string of length encodedLen-1.
        let encodedData = encodedOut.withUnsafeBytes { raw -> Data in
            let ptr = raw.bindMemory(to: CChar.self).baseAddress!
            return String(cString: ptr).data(using: .utf8) ?? Data()
        }
        return Digest(hash: hashData, encoded: encodedData)
    }

    /// Convenience overload accepting a `String` password (UTF-8 encoded).
    public static func hash(
        password: String,
        salt: Data,
        iterations: UInt32,
        memory: UInt32,
        threads: UInt32,
        length: UInt32,
        type: `Type`,
        version: Version
    ) throws -> Digest {
        try hash(
            password: Data(password.utf8), salt: salt,
            iterations: iterations, memory: memory, threads: threads,
            length: length, type: type, version: version
        )
    }
}
