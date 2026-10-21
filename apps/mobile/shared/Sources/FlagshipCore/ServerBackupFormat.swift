import Foundation
import CryptoKit
import Security
import FlagshipAPI

/// The two files of a server backup (docs/server-backup-and-clone.md), the
/// Swift port of packages/protocol/src/serverBackup.ts. Must pass
/// packages/protocol/test-vectors/server-backup and server-restore vectors.
///
///   `<name>.flagship-backup`  small JSON: key slots + a body sealed under the content key
///   `<name>.flagship-data`    the apps, sealed in frames (only the box opens them)
///
/// The passcode slot's key is Argon2id, which lives in the iOS package
/// (`ServerBackupPasscode`); everything here takes the slot keys as input.
public enum ServerBackupFormat {
    public static let magic = "flagship-backup"
    public static let version = 2
    public static let dataMagic = "flagship-backup-data/v2\n"
    public static let backupExtension = "flagship-backup"
    public static let dataExtension = "flagship-data"
    public static let backupFileMaxBytes = 256 * 1024
    public static let passcodeAlphabet = Array("abcdefghijkmnpqrstuvwxyz23456789")
    /// The keyfile's Argon2id cost (memory KiB, passes, lanes).
    public static let defaultArgon = (m: 65536, t: 3, p: 4)
    static let tagSlot = "flagship/server-backup-slot/v2"
    static let tagBody = "flagship/server-backup-body/v2"
    public static let tagRestore = "flagship/server-restore/v1"

    public enum FormatError: Error, Equatable, LocalizedError {
        case notABackup
        case newerVersion
        case olderVersion
        case damaged
        case changed
        case wrongPasscode
        case noPasscode
        public var errorDescription: String? {
            switch self {
            case .notABackup: return "That isn't a Flagship backup file."
            case .newerVersion: return "This backup is from a newer version of Flagship. Update the app and try again."
            case .olderVersion: return "This backup is from an older version of Flagship and can't be restored."
            case .damaged: return "This backup file is damaged."
            case .changed: return "This backup file was changed or is damaged."
            case .wrongPasscode: return "That passcode doesn't open this backup."
            case .noPasscode: return "This backup has no passcode: open it on a device of the account that made it."
            }
        }
    }

    // MARK: - Types

    public typealias Kdf = ServerBackupKdf
    public typealias Slot = ServerBackupSlot

    public struct File: Equatable, Sendable {
        public let archiveId: String
        public let slots: [Slot]
        public let bodyNonceHex: String
        public let bodyHex: String
        public init(archiveId: String, slots: [Slot], bodyNonceHex: String, bodyHex: String) {
            self.archiveId = archiveId
            self.slots = slots
            self.bodyNonceHex = bodyNonceHex
            self.bodyHex = bodyHex
        }
        public var passcodeSlot: Slot? { slots.first { $0.kind == "passcode" } }
        public var accountSlot: Slot? { slots.first { $0.kind == "account" } }
    }

    public struct ServerSettings: Equatable, Sendable {
        public let name: String
        public let domain: String
        /// `auto` | `approve`
        public let bootUnlockMode: String
        /// `luks` | `none`
        public let diskEncryption: String
    }

    public struct App: Equatable, Sendable {
        public let serviceId: String
        public let name: String
        public let reason: String?
    }

    public struct DataInfo: Equatable, Sendable {
        public let fileName: String
        public let bytes: Int64
        public let sha256: String
        public let frameBytes: Int
    }

    public struct Body: Equatable, Sendable {
        public let createdAt: Int64
        public let server: ServerSettings
        public let apps: [App]
        public let left: [App]
        public let data: DataInfo
    }

    public struct Opened: Equatable, Sendable {
        public let file: File
        public let body: Body
        public let contentKey: Data
        /// `account` | `passcode`
        public let via: String
    }

    // MARK: - Passcodes

    public static func normalizePasscode(_ p: String) -> String {
        p.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Why a passcode the user chose is too weak, or nil.
    public static func passcodeProblem(_ passcode: String) -> String? {
        let p = normalizePasscode(passcode)
        let len = p.unicodeScalars.count
        if len >= 20 { return nil }
        if len < 12 { return String(localized: "Use at least 12 characters (or 20 if it's all one kind, like words).") }
        var kinds = 0
        if p.unicodeScalars.contains(where: { ("a"..."z").contains($0) }) { kinds += 1 }
        if p.unicodeScalars.contains(where: { ("A"..."Z").contains($0) }) { kinds += 1 }
        if p.unicodeScalars.contains(where: { ("0"..."9").contains($0) }) { kinds += 1 }
        if p.unicodeScalars.contains(where: { !(("a"..."z").contains($0) || ("A"..."Z").contains($0) || ("0"..."9").contains($0)) }) { kinds += 1 }
        return kinds >= 3 ? nil : String(localized: "Mix at least three of: lowercase, uppercase, digits, symbols (or use 20 characters).")
    }

    /// A suggested passcode: five groups of four, 100 bits.
    public static func generatePasscode(rng: (Int) -> Data = randomBytes) -> String {
        (0..<5).map { _ in String(rng(4).map { passcodeAlphabet[Int($0 & 31)] }) }.joined(separator: "-")
    }

    public static func randomBytes(_ n: Int) -> Data {
        var b = [UInt8](repeating: 0, count: n)
        _ = SecRandomCopyBytes(kSecRandomDefault, n, &b)
        return Data(b)
    }

    // MARK: - Slots

    static func slotAad(archiveId: String, kind: String, kdf: Kdf?) -> Data {
        var parts = [tagSlot, kind, archiveId]
        if kind == "passcode", let k = kdf {
            parts += [k.algo, "m=\(k.m)", "t=\(k.t)", "p=\(k.p)", k.saltHex]
        }
        return Data(parts.joined(separator: "|").utf8)
    }

    static func seal(key: Data, nonce: Data, aad: Data, plain: Data) throws -> Data {
        let box = try AES.GCM.seal(plain, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce), authenticating: aad)
        return box.ciphertext + box.tag
    }

    static func open(key: Data, nonce: Data, aad: Data, sealed: Data) throws -> Data {
        guard sealed.count >= 16 else { throw FormatError.damaged }
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonce),
            ciphertext: sealed.prefix(sealed.count - 16),
            tag: sealed.suffix(16)
        )
        return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
    }

    public static func wrapAccountSlot(archiveId: String, contentKey: Data, kek: Data, nonce: Data) throws -> Slot {
        let w = try seal(key: kek, nonce: nonce, aad: slotAad(archiveId: archiveId, kind: "account", kdf: nil), plain: contentKey)
        return Slot(kind: "account", nonceHex: HexUtil.encode(nonce), wrappedHex: HexUtil.encode(w))
    }

    /// `kek` is the Argon2id of the passcode under `kdf` (see `ServerBackupPasscode`).
    public static func wrapPasscodeSlot(archiveId: String, contentKey: Data, kek: Data, kdf: Kdf, nonce: Data) throws -> Slot {
        let w = try seal(key: kek, nonce: nonce, aad: slotAad(archiveId: archiveId, kind: "passcode", kdf: kdf), plain: contentKey)
        return Slot(kind: "passcode", kdf: kdf, nonceHex: HexUtil.encode(nonce), wrappedHex: HexUtil.encode(w))
    }

    /// The content key from a slot, or nil.
    public static func unwrap(archiveId: String, slot: Slot, kek: Data) -> Data? {
        guard let nonce = HexUtil.decode(slot.nonceHex), let wrapped = HexUtil.decode(slot.wrappedHex),
              let key = try? open(key: kek, nonce: nonce, aad: slotAad(archiveId: archiveId, kind: slot.kind, kdf: slot.kdf), sealed: wrapped),
              key.count == 32
        else { return nil }
        return key
    }

    // MARK: - The backup file

    static func isHex(_ s: String, length: Int? = nil) -> Bool {
        if let length, s.count != length { return false }
        return !s.isEmpty && s.count % 2 == 0 && s.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
    }

    static func int(_ v: Any?) -> Int64? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d == d.rounded(), abs(d) <= 9_007_199_254_740_991 else { return nil }
        return n.int64Value
    }

    static func parseSlot(_ v: Any?) -> Slot? {
        guard let o = v as? [String: Any],
              let nonce = o["nonceHex"] as? String, isHex(nonce, length: 24),
              let wrapped = o["wrappedHex"] as? String, isHex(wrapped, length: 96),
              let kind = o["kind"] as? String
        else { return nil }
        if kind == "account" { return Slot(kind: "account", nonceHex: nonce, wrappedHex: wrapped) }
        guard kind == "passcode", let k = o["kdf"] as? [String: Any], k["algo"] as? String == "argon2id",
              let m = int(k["m"]), let t = int(k["t"]), let p = int(k["p"]), let salt = k["saltHex"] as? String
        else { return nil }
        let kdf = Kdf(m: Int(m), t: Int(t), p: Int(p), saltHex: salt)
        guard kdf.isValid else { return nil }
        return Slot(kind: "passcode", kdf: kdf, nonceHex: nonce, wrappedHex: wrapped)
    }

    /// The outer layer of a backup file. Throws a readable `FormatError`.
    public static func parse(_ data: Data) throws -> File {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], o["magic"] as? String == magic else {
            throw FormatError.notABackup
        }
        guard let v = int(o["v"]) else { throw FormatError.notABackup }
        if v > Int64(version) { throw FormatError.newerVersion }
        if v < Int64(version) { throw FormatError.olderVersion }
        guard let id = o["archiveId"] as? String, isHex(id, length: 32),
              let bodyNonce = o["bodyNonceHex"] as? String, isHex(bodyNonce, length: 24),
              let body = o["bodyHex"] as? String, isHex(body), body.count >= 34,
              let rawSlots = o["slots"] as? [Any], !rawSlots.isEmpty
        else { throw FormatError.damaged }
        let slots = rawSlots.map(parseSlot)
        guard slots.allSatisfy({ $0 != nil }) else { throw FormatError.damaged }
        return File(archiveId: id, slots: slots.compactMap { $0 }, bodyNonceHex: bodyNonce, bodyHex: body)
    }

    public static func parseBody(_ data: Data) -> Body? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let createdAt = int(o["createdAt"]),
              let s = o["server"] as? [String: Any], let name = s["name"] as? String, let domain = s["domain"] as? String,
              let unlock = s["bootUnlockMode"] as? String, ["auto", "approve"].contains(unlock),
              let disk = s["diskEncryption"] as? String, ["luks", "none"].contains(disk),
              let d = o["data"] as? [String: Any], let fileName = d["fileName"] as? String,
              let sha = d["sha256"] as? String, isHex(sha, length: 64),
              let bytes = int(d["bytes"]), bytes >= Int64(dataMagic.utf8.count),
              let frame = int(d["frameBytes"]), (1024...16 * 1024 * 1024).contains(frame),
              let rawApps = o["apps"] as? [[String: Any]]
        else { return nil }
        let apps = rawApps.compactMap { a -> App? in
            guard let id = a["serviceId"] as? String, let n = a["name"] as? String else { return nil }
            return App(serviceId: id, name: n, reason: nil)
        }
        guard apps.count == rawApps.count else { return nil }
        let rawLeft = o["left"] as? [[String: Any]] ?? []
        let left = rawLeft.compactMap { a -> App? in
            guard let id = a["serviceId"] as? String, let n = a["name"] as? String, let r = a["reason"] as? String else { return nil }
            return App(serviceId: id, name: n, reason: r)
        }
        guard left.count == rawLeft.count else { return nil }
        return Body(
            createdAt: createdAt,
            server: ServerSettings(name: name, domain: domain, bootUnlockMode: unlock, diskEncryption: disk),
            apps: apps,
            left: left,
            data: DataInfo(fileName: fileName, bytes: bytes, sha256: sha, frameBytes: Int(frame))
        )
    }

    public static func openBody(_ file: File, contentKey: Data) throws -> Body {
        guard let nonce = HexUtil.decode(file.bodyNonceHex), let sealed = HexUtil.decode(file.bodyHex),
              let plain = try? open(key: contentKey, nonce: nonce, aad: Data("\(tagBody)|\(file.archiveId)".utf8), sealed: sealed)
        else { throw FormatError.changed }
        guard let body = parseBody(plain) else { throw FormatError.damaged }
        return body
    }

    /// Open with this account's key (`ServerArchive.deriveKey`); nil when it isn't this account's backup.
    public static func openWithAccountKey(_ file: File, kek: Data) throws -> Opened? {
        guard let slot = file.accountSlot, let key = unwrap(archiveId: file.archiveId, slot: slot, kek: kek) else { return nil }
        return Opened(file: file, body: try openBody(file, contentKey: key), contentKey: key, via: "account")
    }

    /// Open with the passcode slot's key (Argon2id of the passcode under `file.passcodeSlot.kdf`).
    public static func openWithPasscodeKey(_ file: File, kek: Data) throws -> Opened {
        guard let slot = file.passcodeSlot else { throw FormatError.noPasscode }
        guard let key = unwrap(archiveId: file.archiveId, slot: slot, kek: kek) else { throw FormatError.wrongPasscode }
        return Opened(file: file, body: try openBody(file, contentKey: key), contentKey: key, via: "passcode")
    }

    /// The body sealed under the content key (the box writes real files; this is for tests and parity).
    public static func sealFile(archiveId: String, contentKey: Data, slots: [Slot], bodyJson: Data, nonce: Data) throws -> File {
        let ct = try seal(key: contentKey, nonce: nonce, aad: Data("\(tagBody)|\(archiveId)".utf8), plain: bodyJson)
        return File(archiveId: archiveId, slots: slots, bodyNonceHex: HexUtil.encode(nonce), bodyHex: HexUtil.encode(ct))
    }

    // MARK: - Picked files

    public enum PickedKind: Equatable, Sendable { case backup, data }

    /// Which of the two files `head` (the first bytes of a picked file) is.
    public static func classify(head: Data, size: Int64) -> PickedKind? {
        if head.starts(with: Data(dataMagic.utf8)) { return .data }
        if head.first == UInt8(ascii: "{"), size <= Int64(backupFileMaxBytes) { return .backup }
        return nil
    }

    public enum DataCheckError: Error, Equatable, LocalizedError {
        case wrongSize(expected: String)
        case notData
        case mismatch
        case unreadable
        public var errorDescription: String? {
            switch self {
            case .wrongSize(let name): return "That data file isn't this backup's (it should be \(name))."
            case .notData: return "That isn't a Flagship backup's data file."
            case .mismatch: return "The data file doesn't match the backup file: it was changed or is damaged."
            case .unreadable: return "The data file can't be read any more (was its drive removed?)."
            }
        }
    }

    /// Check the data file against the backup file without holding it: its
    /// size, its first line and its SHA-256, read in slices.
    public static func checkDataFile(
        _ url: URL,
        against info: DataInfo,
        sliceBytes: Int = 8 * 1024 * 1024,
        progress: (Int64) async -> Void = { _ in }
    ) async throws {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? -1
        guard size == info.bytes else { throw DataCheckError.wrongSize(expected: info.fileName) }
        guard let fh = try? FileHandle(forReadingFrom: url) else { throw DataCheckError.unreadable }
        defer { try? fh.close() }
        var h = SHA256()
        var read: Int64 = 0
        while read < size {
            try Task.checkCancellation()
            guard let part = try? fh.read(upToCount: sliceBytes), !part.isEmpty else { throw DataCheckError.unreadable }
            if read == 0, !part.starts(with: Data(dataMagic.utf8)) { throw DataCheckError.notData }
            h.update(data: part)
            read += Int64(part.count)
            await progress(read)
        }
        guard HexUtil.encode(Data(h.finalize())) == info.sha256 else { throw DataCheckError.mismatch }
    }

    // MARK: - The restore order

    public struct RestoreOrder: Equatable, Sendable {
        public let serverDomain: String
        public let archiveId: String
        public let bytes: Int64
        public let sha256: String
        public let issuedAt: Int64
        public init(serverDomain: String, archiveId: String, bytes: Int64, sha256: String, issuedAt: Int64) {
            self.serverDomain = serverDomain
            self.archiveId = archiveId
            self.bytes = bytes
            self.sha256 = sha256
            self.issuedAt = issuedAt
        }

        public var isValid: Bool {
            !serverDomain.isEmpty
                && !serverDomain.unicodeScalars.contains(where: { $0 == "|" || $0.value <= 0x1f || $0.value == 0x7f })
                && isHex(archiveId, length: 32) && bytes >= 1 && isHex(sha256, length: 64) && issuedAt >= 0
        }

        /// `flagship/server-restore/v1|<serverDomain>|<archiveId>|<bytes>|<sha256>|<issuedAt>`
        public func canonicalBytes() throws -> Data {
            guard isValid else { throw FormatError.damaged }
            return Data([tagRestore, serverDomain, archiveId, String(bytes), sha256, String(issuedAt)].joined(separator: "|").utf8)
        }
    }

    /// The pairing order's JSON with the signed restore order beside it
    /// (`{request, signature, restore: {order, signatureHex}}`).
    public static func attachRestore(toPairingJson json: String, order: RestoreOrder, signatureHex: String) -> String {
        guard json.hasSuffix("}") else { return json }
        let o = "{\"serverDomain\":\(PairingOrderEnvelope.jsonString(order.serverDomain)),"
            + "\"archiveId\":\"\(order.archiveId)\",\"bytes\":\(order.bytes),"
            + "\"sha256\":\"\(order.sha256)\",\"issuedAt\":\(order.issuedAt)}"
        return String(json.dropLast()) + ",\"restore\":{\"order\":\(o),\"signatureHex\":\"\(signatureHex)\"}}"
    }
}

extension ServerBackupKdf {
    public var isValid: Bool {
        algo == "argon2id" && (1...16).contains(p) && (1...16).contains(t) && (8...1_048_576).contains(m) && m >= 8 * p
            && ServerBackupFormat.isHex(saltHex, length: 32)
    }
}
