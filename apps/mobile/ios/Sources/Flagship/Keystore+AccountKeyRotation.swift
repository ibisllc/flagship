import Foundation
import CryptoKit
import FlagshipCore

/// The per-profile slots an account key rotation keeps (docs/account-key-rotation.md). Every secret here is
/// sealed to the profile's Secure Enclave wrapping key like the PQ seeds: writing needs no prompt, opening
/// needs the unlock (this session's, or one Face ID / passcode prompt).
enum AccountKeyRotationSlots {
    static let pending = "com.flagship.akr.pending"
    static let retired = "com.flagship.akr.retired"
    static let epoch = "com.flagship.akr.epoch"
    static let rootPin = "com.flagship.akr.root-pin"
    static let receiveKey = "com.flagship.akr.receive-key"
    static let recoveryOff = "com.flagship.akr.recovery-off"
    static let progress = "com.flagship.akr.progress"
    static let previousDeviceKey = "com.flagship.akr.device-key-prev"
    static let all = [pending, retired, epoch, rootPin, receiveKey, recoveryOff, progress, previousDeviceKey]
}

public extension Keystore {

    // MARK: - Epoch and the admin root this device pins

    /// The account key epoch this device holds (0 until a rotation reached it).
    static func accountKeyEpoch() -> Int64 {
        guard let d = pqRecordRead(AccountKeyRotationSlots.epoch), let s = String(data: d, encoding: .utf8), let n = Int64(s), n >= 0 else { return 0 }
        return n
    }

    static func setAccountKeyEpoch(_ epoch: Int64) {
        try? pqRecordWrite(AccountKeyRotationSlots.epoch, Data(String(epoch).utf8))
    }

    /// The admin root this device replays the account's lane from: its own when it holds one, else the one it
    /// pinned (at its first unlock, or as the lane moved it).
    static func accountKeyAdminRootPin() -> String? {
        if let own = adminRootPubHex() { return own }
        guard let d = pqRecordRead(AccountKeyRotationSlots.rootPin), let s = String(data: d, encoding: .utf8),
              s.count == 64 else { return nil }
        return s
    }

    static func setAccountKeyAdminRootPin(_ hex: String) {
        try? pqRecordWrite(AccountKeyRotationSlots.rootPin, Data(hex.lowercased().utf8))
    }

    // MARK: - The receive key (X-Wing)

    struct StoredReceiveKey: Codable, Equatable, Sendable {
        public let xwingPubHex: String
        public let sealed: Data
        public let ephemeralPub: Data
        /// The device key the published record was signed with ("" until published).
        public var publishedForDevicePubHex: String
    }

    private static func receiveKeyAad(_ pubHex: String) -> Data { Data("flagship/umk-rotation-delivery/v1|receive-key|\(pubHex)".utf8) }

    static func storedReceiveKey() -> StoredReceiveKey? {
        pqRecordRead(AccountKeyRotationSlots.receiveKey).flatMap { try? JSONDecoder().decode(StoredReceiveKey.self, from: $0) }
    }

    /// This profile's receive key, made on first use (the seed sealed to the Secure Enclave key; no prompt).
    static func loadOrCreateReceiveKey() throws -> StoredReceiveKey {
        if let k = storedReceiveKey() { return k }
        let seed = PqHybrid.randomSeed()
        let pubHex = HexUtil.encode(Data(try PqHybrid.hybridSealKeygen(seed: seed).publicKey))
        let sealed = try pqSealSeed(Data(seed), aad: receiveKeyAad(pubHex))
        let k = StoredReceiveKey(xwingPubHex: pubHex, sealed: sealed.sealed, ephemeralPub: sealed.ephemeralPub, publishedForDevicePubHex: "")
        try pqRecordWrite(AccountKeyRotationSlots.receiveKey, try JSONEncoder().encode(k))
        return k
    }

    static func markReceiveKeyPublished(devicePubHex: String) {
        guard var k = storedReceiveKey() else { return }
        k.publishedForDevicePubHex = devicePubHex.lowercased()
        try? pqRecordWrite(AccountKeyRotationSlots.receiveKey, (try? JSONEncoder().encode(k)) ?? Data())
    }

    /// The receive key's X-Wing seed (this session's unlock, else one prompt).
    static func receiveKeySeed(reason: String) async throws -> [UInt8] {
        guard let k = storedReceiveKey() else { throw KeystoreError.keyNotFound }
        return Array(try await pqOpenSeed(k.sealed, ephemeralPub: k.ephemeralPub, aad: receiveKeyAad(k.xwingPubHex), reason: reason))
    }

    // MARK: - The rotator's pending slot

    /// A rotation this device sent and has not seen applied: the new UMK (and admin root, when it rotated
    /// too) sealed, the exact body, and what decides promote / retry / drop on the next launch.
    struct PendingAccountKey: Codable, Equatable, Sendable {
        public let username: String
        public let toEpoch: Int64
        public let oldIrkPubHex: String
        public let newIrkPubHex: String
        public let scheme: String
        public let issuedAt: Int64
        public let body: Data
        public let sealedUmk: Data
        public let umkEphemeralPub: Data
        public let sealedAdminRoot: Data?
        public let adminRootEphemeralPub: Data?
        /// The kept devices, for the progress card.
        public let keptDeviceIds: [String]
        public let hadRecovery: Bool
    }

    private static func pendingAad(_ p: String, _ newIrk: String) -> Data { Data("flagship/account-key-rotation/v1|pending|\(p)|\(newIrk)".utf8) }

    static func savePendingAccountKey(username: String, toEpoch: Int64, oldIrkPubHex: String, newIrkPubHex: String, scheme: String,
                                      issuedAt: Int64, body: Data, newUmk: [UInt8], newAdminRootSeed: [UInt8]?,
                                      keptDeviceIds: [String], hadRecovery: Bool) throws {
        let umk = try pqSealSeed(Data(newUmk), aad: pendingAad("umk", newIrkPubHex))
        let root = try newAdminRootSeed.map { try pqSealSeed(Data($0), aad: pendingAad("admin-root", newIrkPubHex)) }
        let p = PendingAccountKey(username: username.lowercased(), toEpoch: toEpoch, oldIrkPubHex: oldIrkPubHex, newIrkPubHex: newIrkPubHex,
                                  scheme: scheme, issuedAt: issuedAt, body: body, sealedUmk: umk.sealed, umkEphemeralPub: umk.ephemeralPub,
                                  sealedAdminRoot: root?.sealed, adminRootEphemeralPub: root?.ephemeralPub,
                                  keptDeviceIds: keptDeviceIds, hadRecovery: hadRecovery)
        try pqRecordWrite(AccountKeyRotationSlots.pending, try JSONEncoder().encode(p))
    }

    static func pendingAccountKey() -> PendingAccountKey? {
        pqRecordRead(AccountKeyRotationSlots.pending).flatMap { try? JSONDecoder().decode(PendingAccountKey.self, from: $0) }
    }

    static func clearPendingAccountKey() { pqRecordDelete(AccountKeyRotationSlots.pending) }

    static func openPendingAccountKey(_ p: PendingAccountKey, reason: String) async throws -> (umk: [UInt8], adminRoot: [UInt8]?) {
        let umk = try await pqOpenSeed(p.sealedUmk, ephemeralPub: p.umkEphemeralPub, aad: pendingAad("umk", p.newIrkPubHex), reason: reason)
        var root: [UInt8]?
        if let s = p.sealedAdminRoot, let e = p.adminRootEphemeralPub {
            root = Array(try await pqOpenSeed(s, ephemeralPub: e, aad: pendingAad("admin-root", p.newIrkPubHex), reason: reason))
        }
        return (Array(umk), root)
    }

    // MARK: - Retired account keys

    struct RetiredUmk: Codable, Equatable, Sendable {
        /// The epoch this key belonged to.
        public let epoch: Int64
        public let sealed: Data
        public let ephemeralPub: Data
    }

    private static func retiredAad(_ epoch: Int64) -> Data { Data("flagship/account-key-rotation/v1|retired|\(epoch)".utf8) }

    static func retiredUmks() -> [RetiredUmk] {
        pqRecordRead(AccountKeyRotationSlots.retired).flatMap { try? JSONDecoder().decode([RetiredUmk].self, from: $0) } ?? []
    }

    /// The account keys of earlier epochs, for what they still open (old backups, messages, drafts).
    static func retiredUmk(epoch: Int64, reason: String) async throws -> [UInt8]? {
        guard let r = retiredUmks().first(where: { $0.epoch == epoch }) else { return nil }
        return Array(try await pqOpenSeed(r.sealed, ephemeralPub: r.ephemeralPub, aad: retiredAad(epoch), reason: reason))
    }

    /// Installs the next epoch's UMK: the current one goes to the retired slot (same custody), the new one is
    /// wrapped like any UMK, the IRK starts again at version 1 of `scheme` (the platform that made the key).
    static func installRotatedUMK(_ newUmk: [UInt8], scheme: AccountKeyRotation.IrkScheme, toEpoch: Int64, reason: String) async throws {
        let current = try await currentUMK(reason: reason).withUnsafeBytes { Data($0) }
        var retired = retiredUmks().filter { $0.epoch != toEpoch - 1 }
        let sealed = try pqSealSeed(current, aad: retiredAad(toEpoch - 1))
        retired.append(RetiredUmk(epoch: toEpoch - 1, sealed: sealed.sealed, ephemeralPub: sealed.ephemeralPub))
        try pqRecordWrite(AccountKeyRotationSlots.retired, try JSONEncoder().encode(retired))
        try await installUMK(SymmetricKey(data: Data(newUmk)), reason: reason)
        if let made = IrkLineage.Scheme(rawValue: scheme.rawValue), made != IrkLineage.own {
            try adoptRegisteredIrk(try IrkLineage.key(umk: SymmetricKey(data: Data(newUmk)), scheme: made, version: 1))
        }
        setAccountKeyEpoch(toEpoch)
    }

    // MARK: - A device key being replaced

    /// The key a device-key replacement is moving off, kept until `.com` is known to hold the new one.
    static var previousAccountDeviceKey: Data? {
        get { pqRecordRead(AccountKeyRotationSlots.previousDeviceKey) }
        set { if let newValue { try? pqRecordWrite(AccountKeyRotationSlots.previousDeviceKey, newValue) } else { pqRecordDelete(AccountKeyRotationSlots.previousDeviceKey) } }
    }

    // MARK: - After a rotation

    /// Cloud recovery was deleted by a rotation and is not set up again yet.
    static var accountKeyRecoveryOff: Bool {
        get { pqRecordRead(AccountKeyRotationSlots.recoveryOff) != nil }
        set { if newValue { try? pqRecordWrite(AccountKeyRotationSlots.recoveryOff, Data("1".utf8)) } else { pqRecordDelete(AccountKeyRotationSlots.recoveryOff) } }
    }

    /// The last rotation this device made, for the progress card: epoch and kept device ids.
    struct RotationProgressRecord: Codable, Equatable, Sendable {
        public let toEpoch: Int64
        public let keptDeviceIds: [String]
        public init(toEpoch: Int64, keptDeviceIds: [String]) { self.toEpoch = toEpoch; self.keptDeviceIds = keptDeviceIds }
    }

    static var accountKeyProgress: RotationProgressRecord? {
        get { pqRecordRead(AccountKeyRotationSlots.progress).flatMap { try? JSONDecoder().decode(RotationProgressRecord.self, from: $0) } }
        set {
            if let newValue, let d = try? JSONEncoder().encode(newValue) { try? pqRecordWrite(AccountKeyRotationSlots.progress, d) }
            else { pqRecordDelete(AccountKeyRotationSlots.progress) }
        }
    }
}
