import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// "Change your account key" (docs/account-key-rotation.md): after "Remove from account" → "Yes, or I'm not
/// sure". An admin device makes a new account key, keeps every device it can still trust, removes the rest,
/// and sends `.com` one hop signed by the admin root. Servers follow by themselves; kept devices take the new
/// key the next time they open Flagship.
@Observable
@MainActor
public final class RotateAccountKeyViewModel {

    public enum Phase: Equatable, Sendable {
        case preparing
        /// Not offered (the sentence says why).
        case unavailable(String)
        case ready
        case rotating
        /// Done; `setUpRecovery` asks to run cloud recovery setup again.
        case done(setUpRecovery: Bool)
        case failed(String)
    }

    public struct ExcludedRow: Equatable, Sendable, Identifiable {
        public let deviceId: String
        public let line: String
        public var id: String { deviceId }
    }

    public struct Summary: Equatable, Sendable {
        public var removedName: String
        public var excluded: [ExcludedRow]
        public var adminKeyChangesFirst: Bool
        public var hasRecovery: Bool
        public var keptCount: Int
    }

    /// A server of the account, by name and address.
    public struct Server: Equatable, Sendable {
        public let name: String
        public let fqdn: String
        public init(name: String, fqdn: String) { self.name = name; self.fqdn = fqdn }
    }

    /// Everything the flow reaches outside itself (Keystore, `.com`, the boxes), so tests can run it.
    public struct Deps {
        public var hasAdminRoot: () -> Bool
        public var umk: (String) async throws -> Data
        public var adminRoot: (String) async throws -> Curve25519.Signing.PrivateKey
        public var deviceKey: (String, String) -> Curve25519.Signing.PrivateKey?
        public var boxStatus: (Server) async -> AccountKeyBoxStatus?
        public var strict: (String) -> Bool
        public var hasRecovery: (String) async -> Bool
        /// The hop's hybrid companion (strict accounts); nil when this device cannot sign one.
        public var pqCompanion: (AccountKeyRotation.Rotation, Curve25519.Signing.PrivateKey, Curve25519.Signing.PrivateKey) async -> [String: Any]?
        /// An admin-root rotation's companion (strict accounts).
        public var rootRotationCompanion: (AdminRootRotation, Curve25519.Signing.PrivateKey, Curve25519.Signing.PrivateKey) async -> AdminRootRotationPqWire?
        public var savePending: (Keystore.PendingAccountKey.Draft) throws -> Void
        public var clearPending: () -> Void
        public var promote: (AccountKeyPromotion) async throws -> Void
        public var now: () -> Int64

        public init(hasAdminRoot: @escaping () -> Bool, umk: @escaping (String) async throws -> Data,
                    adminRoot: @escaping (String) async throws -> Curve25519.Signing.PrivateKey,
                    deviceKey: @escaping (String, String) -> Curve25519.Signing.PrivateKey?,
                    boxStatus: @escaping (Server) async -> AccountKeyBoxStatus?, strict: @escaping (String) -> Bool,
                    hasRecovery: @escaping (String) async -> Bool,
                    pqCompanion: @escaping (AccountKeyRotation.Rotation, Curve25519.Signing.PrivateKey, Curve25519.Signing.PrivateKey) async -> [String: Any]?,
                    rootRotationCompanion: @escaping (AdminRootRotation, Curve25519.Signing.PrivateKey, Curve25519.Signing.PrivateKey) async -> AdminRootRotationPqWire?,
                    savePending: @escaping (Keystore.PendingAccountKey.Draft) throws -> Void, clearPending: @escaping () -> Void,
                    promote: @escaping (AccountKeyPromotion) async throws -> Void, now: @escaping () -> Int64) {
            self.hasAdminRoot = hasAdminRoot; self.umk = umk; self.adminRoot = adminRoot; self.deviceKey = deviceKey
            self.boxStatus = boxStatus; self.strict = strict; self.hasRecovery = hasRecovery; self.pqCompanion = pqCompanion
            self.rootRotationCompanion = rootRotationCompanion; self.savePending = savePending; self.clearPending = clearPending
            self.promote = promote; self.now = now
        }

        public static func live(server: any FlagshipServerClient, statusOf: @escaping (Server) async -> AccountKeyBoxStatus?,
                                selfName: @escaping () -> String?) -> Deps {
            Deps(
                hasAdminRoot: { Keystore.hasAdminRoot },
                umk: { reason in try await Keystore.currentUMK(reason: reason).withUnsafeBytes { Data($0) } },
                adminRoot: { reason in
                    if let held = Keystore.sessionAdminRoot() { return held }
                    return try await Keystore.adminRootKey(reason: reason)
                },
                deviceKey: { u, id in Keystore.sessionAccountDeviceKey(accountId: u, deviceId: id) },
                boxStatus: statusOf,
                strict: { QuantumSafetyService.anyStrict(username: $0) },
                hasRecovery: { u in (try? await server.hasCloudRecovery(username: u)) ?? false },
                pqCompanion: { r, root, irk in await QuantumSafetyService.accountKeyRotationCompanion(r, adminRoot: root, newIrk: irk) },
                rootRotationCompanion: { r, old, new in await QuantumSafetyService.rotationCompanion(r, oldRoot: old, newRoot: new) },
                savePending: { try Keystore.savePendingAccountKey($0) },
                clearPending: { Keystore.clearPendingAccountKey() },
                promote: { p in try await AccountKeyRotationService.promote(p, server: server, selfName: selfName()) },
                now: { Int64(Date().timeIntervalSince1970 * 1000) })
        }
    }

    public private(set) var phase: Phase = .preparing
    public private(set) var summary: Summary?

    private let server: any FlagshipServerClient
    private let username: String
    private let deviceId: String
    private let removedDeviceId: String
    private let removedName: String
    private let servers: [Server]
    private let deps: Deps

    private var plan: AccountKeyRotationFlow.Plan?
    private var oldUmk: Data?
    private var comEpoch: Int64 = 0
    private var comIrkPubHex = ""
    private var accountProfile: AccountKeyRotationFlow.ProfileName?
    private var managed: [AccountKeyRotationFlow.ProfileName] = []

    public static let reason = String(localized: "Change your account key")
    public static let failedLine = String(localized: "The account key could not be changed. Nothing was changed. Try again.")
    public static let lostRaceLine = String(localized: "Another admin device changed the account key first. Open Flagship again to get the new key.")
    public static let notAdminLine = String(localized: "Only an admin device can change the account key.")
    public static let strictWebLine = String(localized: "Under quantum-safe protection, this device can't sign the change. Try again from a device that holds the admin key's quantum-safe half.")
    public static func updateServerLine(_ name: String) -> String {
        String(localized: "Update every server first: \(name) can't follow an account key change yet.")
    }
    public static func adminFirstLine(_ name: String) -> String {
        String(localized: "\(name) held the admin key, so the admin key changes first.")
    }
    public static func derivedLine(_ name: String) -> String { String(localized: "\(name): its key came from the old account key") }
    public static func noReceiveKeyLine(_ name: String) -> String { String(localized: "\(name): it can't receive the new key safely") }

    public init(server: any FlagshipServerClient, username: String, deviceId: String, removedDeviceId: String, removedName: String,
                servers: [Server], deps: Deps) {
        self.server = server; self.username = username.lowercased(); self.deviceId = deviceId.lowercased()
        self.removedDeviceId = removedDeviceId.lowercased(); self.removedName = removedName; self.servers = servers; self.deps = deps
    }

    /// Reads the account and every server; ends `.ready` with the summary, or `.unavailable`.
    public func prepare() async {
        phase = .preparing
        guard deps.hasAdminRoot() else { phase = .unavailable(Self.notAdminLine); return }
        for s in servers {
            guard let st = await deps.boxStatus(s), st.canFollow else { phase = .unavailable(Self.updateServerLine(s.name)); return }
        }
        do {
            let umk = try await deps.umk(Self.reason)
            oldUmk = umk
            guard let key = deps.deviceKey(username, deviceId) else { phase = .unavailable(Self.failedLine); return }
            guard let com = await AccountKeyRotationService.comState(server: server, username: username) else {
                phase = .unavailable(Self.failedLine); return
            }
            comEpoch = com.keyEpoch
            comIrkPubHex = com.irkPub.lowercased()
            let dir = try await AccountKeyRotationService.directory(server: server, username: username, deviceId: deviceId, key: key)
            let names = AccountDeviceNames.names(in: dir, accountId: username, umk: umk)
            let receive = Dictionary((dir.receiveKeys ?? []).map { ($0.deviceId.lowercased(), $0) }, uniquingKeysWith: { a, _ in a })
            let devices: [AccountKeyRotationFlow.Device] = dir.devices.filter { $0.revokedAt == nil }.map { d in
                let id = d.deviceId.lowercased()
                let live = dir.grants.filter { $0.deviceId.lowercased() == id && $0.revokedAt == nil }
                let scopes = DeviceCapabilityGrantEnvelope.deviceScopeOrder.filter { s in live.contains { $0.scopes.contains(s) } }
                let signer = live.allSatisfy({ $0.signerRoot == "admin-root" }) && !live.isEmpty ? "admin-root" : "membership"
                return .init(deviceId: id, devicePubHex: d.devicePubHex, displayName: names[id] ?? id, platformClass: d.platformClass,
                             createdAt: d.createdAt, scopes: scopes, grantSignerRoot: signer, receiveKey: receive[id])
            }
            let plan = try AccountKeyRotationFlow.plan(devices: devices, selfDeviceId: deviceId, removedDeviceId: removedDeviceId,
                                                        oldUmk: [UInt8](umk), accountName: username, strict: deps.strict(username))
            self.plan = plan
            let directoryKey = try AccountMetadata.deriveDeviceDirectoryKey(umk: umk)
            if let p = dir.accountProfile, let name = try? AccountMetadata.decrypt(
                ciphertext: .init(nonceHex: p.nonceHex, ciphertextHex: p.ciphertextHex),
                keyBytes: AccountMetadata.deriveAccountProfileKey(umk: umk),
                coordinates: .init(accountId: username, recordType: .accountProfile, revision: p.revision, keyVersion: p.keyVersion)) {
                accountProfile = .init(displayName: name, revision: p.revision)
            }
            managed = dir.managedProfiles.compactMap { m in
                guard let name = try? AccountMetadata.decrypt(
                    ciphertext: .init(nonceHex: m.nonceHex, ciphertextHex: m.ciphertextHex), keyBytes: directoryKey,
                    coordinates: .init(accountId: username, deviceId: m.deviceId, recordType: .deviceManagedProfile,
                                       revision: m.revision, keyVersion: m.keyVersion)) else { return nil }
                return .init(deviceId: m.deviceId, displayName: name, revision: m.revision, locked: m.locked)
            }
            summary = Summary(
                removedName: removedName,
                excluded: plan.excluded.map { e in
                    ExcludedRow(deviceId: e.device.deviceId, line: e.reason == .derivedKey
                                ? Self.derivedLine(e.device.displayName) : Self.noReceiveKeyLine(e.device.displayName))
                },
                adminKeyChangesFirst: plan.removedMayHoldAdminRoot,
                hasRecovery: await deps.hasRecovery(username),
                keptCount: plan.kept.count)
            phase = .ready
        } catch let e as AccountKeyRotationFlow.PlanError where e.code == "self-key-derived" {
            phase = .unavailable(Self.failedLine)
        } catch {
            if BiometricGate.GateError.from(error).isSilent || Keystore.isPromptUnavailable(error) {
                phase = .unavailable("")
            } else {
                phase = .unavailable(UserErrorText.of(error, fallback: Self.failedLine))
            }
        }
    }

    /// Makes the new key and sends the hop; on `.com`'s 200 installs it here.
    public func rotate() async {
        guard case .ready = phase, let plan, let oldUmk, let summary else { return }
        phase = .rotating
        do {
            let oldRoot = try await deps.adminRoot(Self.reason)
            let now = deps.now()
            var signingRoot = oldRoot
            var rotatedSeed: [UInt8]?
            var rootBody: [String: Any]?
            if plan.removedMayHoldAdminRoot {
                let newRoot = Curve25519.Signing.PrivateKey()
                let r = AdminRootRotation(username: username, oldAdminRootPubHex: HexUtil.encode(oldRoot.publicKey.rawRepresentation),
                                          newAdminRootPubHex: HexUtil.encode(newRoot.publicKey.rawRepresentation), issuedAt: now)
                let req = AdminRootRotationRequest(
                    rotation: .init(username: username, oldAdminRootPub: r.oldAdminRootPubHex, newAdminRootPub: r.newAdminRootPubHex, issuedAt: now),
                    signatureHex: HexUtil.encode(try r.sign(withOldAdminRoot: oldRoot)),
                    pq: deps.strict(username) ? await deps.rootRotationCompanion(r, oldRoot, newRoot) : nil)
                rootBody = try JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any]
                signingRoot = newRoot
                rotatedSeed = Array(newRoot.rawRepresentation)
            }
            let newUmk = [UInt8](SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) })
            let oldAid = HexUtil.encode(try Curve25519.Signing.PrivateKey(rawRepresentation: Data(AccountKeyRotation.aidSeed(umk: [UInt8](oldUmk))))
                .publicKey.rawRepresentation)
            let keys = AccountKeyRotationFlow.Keys(oldUmk: [UInt8](oldUmk), newUmk: newUmk, scheme: .ios, oldIrkPubHex: comIrkPubHex,
                                                   oldAidPubHex: oldAid, adminRoot: signingRoot, rotatedAdminRootSeed: rotatedSeed)
            let strict = deps.strict(username)
            let newIrk = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(AccountKeyRotationFlow.newIrkSeed(keys)))
            var built = try AccountKeyRotationFlow.build(username: username, fromEpoch: comEpoch, plan: plan, keys: keys,
                                                         adminRootRotation: rootBody, accountProfile: accountProfile, managedProfiles: managed,
                                                         now: now)
            if strict {
                guard let companion = await deps.pqCompanion(built.rotation, signingRoot, newIrk) else { phase = .failed(Self.strictWebLine); return }
                built.body["pq"] = companion
            }
            let bodyData = try JSONSerialization.data(withJSONObject: built.body, options: [.sortedKeys])
            try deps.savePending(.init(username: username, toEpoch: built.rotation.toEpoch, oldIrkPubHex: comIrkPubHex,
                                       newIrkPubHex: built.newIrkPubHex, scheme: AccountKeyRotation.IrkScheme.ios.rawValue, issuedAt: now,
                                       body: bodyData, newUmk: newUmk, newAdminRootSeed: rotatedSeed,
                                       keptDeviceIds: plan.kept.map(\.deviceId), hadRecovery: summary.hasRecovery))
            do {
                let (status, data) = try await server.accountKeyCall(method: "POST", path: "/api/users/\(username)/account-key-rotation",
                                                                     authorization: nil, body: bodyData)
                guard (200..<300).contains(status) else { throw AccountKeyRefusal(status: status, data: data) }
            } catch let r as AccountKeyRefusal {
                if r.isConflict, let com = await AccountKeyRotationService.comState(server: server, username: username), com.irkPub == built.newIrkPubHex {
                    // Applied by this request after all (a retried send): promote below.
                } else {
                    deps.clearPending()
                    phase = .failed(r.isConflict ? Self.lostRaceLine : Self.failedLine)
                    return
                }
            } catch {
                // No answer: `.com` may hold the new key. Decide from what it serves; the pending slot covers a crash.
                guard let com = await AccountKeyRotationService.comState(server: server, username: username), com.irkPub == built.newIrkPubHex else {
                    phase = .failed(Self.failedLine)
                    return
                }
            }
            try await deps.promote(.init(username: username, deviceId: deviceId, newUmk: newUmk, scheme: .ios,
                                         toEpoch: built.rotation.toEpoch, newAdminRootSeed: rotatedSeed,
                                         keptDeviceIds: plan.kept.map(\.deviceId), hadRecovery: summary.hasRecovery))
            phase = .done(setUpRecovery: summary.hasRecovery)
        } catch {
            if BiometricGate.GateError.from(error).isSilent { phase = .ready; return }
            phase = .failed(Self.failedLine)
        }
    }
}

/// What a rotator installs once `.com` applied its hop (also from the pending slot on resume).
public struct AccountKeyPromotion: Sendable, Equatable {
    public let username: String
    public let deviceId: String
    public let newUmk: [UInt8]
    public let scheme: AccountKeyRotation.IrkScheme
    public let toEpoch: Int64
    public let newAdminRootSeed: [UInt8]?
    public let keptDeviceIds: [String]
    public let hadRecovery: Bool
}

public extension Keystore.PendingAccountKey {
    /// The fields `savePendingAccountKey` seals.
    struct Draft: Sendable {
        public let username: String
        public let toEpoch: Int64
        public let oldIrkPubHex: String
        public let newIrkPubHex: String
        public let scheme: String
        public let issuedAt: Int64
        public let body: Data
        public let newUmk: [UInt8]
        public let newAdminRootSeed: [UInt8]?
        public let keptDeviceIds: [String]
        public let hadRecovery: Bool
    }
}

public extension Keystore {
    static func savePendingAccountKey(_ d: PendingAccountKey.Draft) throws {
        try savePendingAccountKey(username: d.username, toEpoch: d.toEpoch, oldIrkPubHex: d.oldIrkPubHex, newIrkPubHex: d.newIrkPubHex,
                                  scheme: d.scheme, issuedAt: d.issuedAt, body: d.body, newUmk: d.newUmk,
                                  newAdminRootSeed: d.newAdminRootSeed, keptDeviceIds: d.keptDeviceIds, hadRecovery: d.hadRecovery)
    }
}
