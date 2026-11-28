import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// The Keychain-bound half of an account key rotation (docs/account-key-rotation.md): a device's receive key,
/// the one-time move off a device key derived from the account key, a kept device taking its new account key,
/// and the rotator's pending slot. The pure steps are `AccountKeyRotationFlow` (FlagshipCore).
@MainActor
public enum AccountKeyRotationService {

    // MARK: - Signed directory requests

    /// This device's account device key: stored (joined devices, and every device after its first unlock),
    /// else the old derivation from this session's account key.
    static func deviceKey(username: String, deviceId: String) -> Curve25519.Signing.PrivateKey? {
        Keystore.sessionAccountDeviceKey(accountId: username.lowercased(), deviceId: deviceId)
    }

    static func authorization(_ key: Curve25519.Signing.PrivateKey, username: String, deviceId: String,
                              method: String, path: String) throws -> AccountDirectoryAuthorization {
        let u = username.lowercased()
        let pub = HexUtil.encode(key.publicKey.rawRepresentation)
        let requestId = try AccountMetadata.generateDeviceId()
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let sig = try key.signature(for: AccountMetadata.canonicalDirectoryRequest(
            accountId: u, deviceId: deviceId, signerPubHex: pub, method: method, path: path, requestId: requestId, issuedAt: issuedAt))
        return AccountDirectoryAuthorization(deviceId: deviceId, signerPubHex: pub, requestId: requestId, issuedAt: issuedAt,
                                             signatureHex: HexUtil.encode(Data(sig)))
    }

    static func directory(server: any FlagshipServerClient, username: String, deviceId: String,
                          key: Curve25519.Signing.PrivateKey) async throws -> AccountDirectoryResponse {
        let u = username.lowercased()
        return try await server.accountDirectory(accountId: u, authorization: try authorization(
            key, username: u, deviceId: deviceId, method: "GET", path: "/api/accounts/\(u)/directory"))
    }

    // MARK: - Phase 0: the receive key

    /// Publishes this device's X-Wing receive key once per device key (no prompt: the seed is sealed to the
    /// Secure Enclave key's public half and the device key is stored).
    @discardableResult
    public static func publishReceiveKey(server: any FlagshipServerClient, username: String, deviceId: String) async -> Bool {
        let u = username.lowercased()
        guard AccountMetadata.isDeviceId(deviceId), let key = deviceKey(username: u, deviceId: deviceId),
              let rk = try? Keystore.loadOrCreateReceiveKey() else { return false }
        let devicePub = HexUtil.encode(key.publicKey.rawRepresentation)
        if rk.publishedForDevicePubHex == devicePub { return true }
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let path = "/api/accounts/\(u)/devices/\(deviceId)/receive-key"
        do {
            let msg = try AccountKeyRotation.canonicalDeviceReceiveKey(username: u, deviceId: deviceId, devicePubHex: devicePub,
                                                                       xwingPubHex: rk.xwingPubHex, issuedAt: issuedAt)
            let sig = HexUtil.encode(try key.signature(for: Data(msg)))
            _ = try await server.accountKeyJson(method: "PUT", path: path, authorization: try authorization(key, username: u, deviceId: deviceId, method: "PUT", path: path),
                                                body: ["receiveKey": ["username": u, "deviceId": deviceId, "devicePubHex": devicePub,
                                                                      "xwingPubHex": rk.xwingPubHex, "issuedAt": issuedAt],
                                                       "signatureHex": sig])
            Keystore.markReceiveKeyPublished(devicePubHex: devicePub)
            return true
        } catch {
            return false
        }
    }

    // MARK: - Phase 0: off a device key derived from the account key

    public enum DeviceKeyMigration: Equatable, Sendable { case notNeeded, migrated, needsAdmin, failed }

    /// When this device's key is `HKDF(UMK, account-device-key/v1|…)` (accounts made before 0.5), anyone holding
    /// the account key could sign as it. An admin device replaces it with a random key, authorised by the admin
    /// root (`flagship/device-key-rotate/v1`) with a grant for the new key carrying the same scopes. A device
    /// without the admin root keeps its key; a rotation then has it added again.
    public static func migrateDerivedDeviceKey(server: any FlagshipServerClient, username: String, deviceId: String, umk: Data,
                                               adminRoot: Curve25519.Signing.PrivateKey?) async -> DeviceKeyMigration {
        let u = username.lowercased()
        guard AccountMetadata.isDeviceId(deviceId), var key = deviceKey(username: u, deviceId: deviceId) else { return .failed }
        if let prevRaw = Keystore.previousAccountDeviceKey, let prev = try? Curve25519.Signing.PrivateKey(rawRepresentation: prevRaw) {
            // An earlier replacement stopped between storing the new key and `.com`'s answer.
            if (try? await directory(server: server, username: u, deviceId: deviceId, key: key)) == nil,
               (try? await directory(server: server, username: u, deviceId: deviceId, key: prev)) != nil {
                try? Keystore.storeAccountDeviceSigningKey(prev, accountId: u, deviceId: deviceId)
                key = prev
            }
            Keystore.previousAccountDeviceKey = nil
        }
        let oldPub = HexUtil.encode(key.publicKey.rawRepresentation)
        guard AccountKeyRotation.deviceKeyIsUmkDerived(umk: [UInt8](umk), accountName: u, deviceId: deviceId, devicePubHex: oldPub) else {
            return .notNeeded
        }
        guard let adminRoot else { return .needsAdmin }
        do {
            let dir = try await directory(server: server, username: u, deviceId: deviceId, key: key)
            let live = dir.grants.filter { $0.deviceId == deviceId && $0.revokedAt == nil }
            let scopes = DeviceCapabilityGrantEnvelope.deviceScopeOrder.filter { s in live.contains { $0.scopes.contains(s) } }
            let newKey = Curve25519.Signing.PrivateKey()
            let newPub = HexUtil.encode(newKey.publicKey.rawRepresentation)
            let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
            let msg = Data(try AccountKeyRotation.canonicalDeviceKeyRotate(username: u, deviceId: deviceId, oldDevicePubHex: oldPub,
                                                                          newDevicePubHex: newPub, issuedAt: issuedAt))
            var body: [String: Any] = [
                "rotate": ["username": u, "deviceId": deviceId, "oldDevicePubHex": oldPub, "newDevicePubHex": newPub, "issuedAt": issuedAt],
                "newKeySignatureHex": HexUtil.encode(try newKey.signature(for: msg)),
                "adminRootSignatureHex": HexUtil.encode(try adminRoot.signature(for: msg)),
            ]
            if !scopes.isEmpty {
                let env = DeviceCapabilityGrantEnvelope(grantId: UUID().uuidString.lowercased(), username: u, deviceId: deviceId,
                                                        devicePubKeyHex: newPub, scopes: scopes, issuedAt: issuedAt,
                                                        expiresAt: issuedAt + 90 * 24 * 3_600_000)
                body["grant"] = [
                    "grant": ["grantId": env.grantId, "username": u, "deviceId": deviceId, "devicePubKey": newPub, "scopes": scopes,
                              "issuedAt": issuedAt, "expiresAt": env.expiresAt],
                    "signature": HexUtil.encode(try adminRoot.signature(for: env.canonicalBytes())), "signerRoot": "admin-root",
                ]
            }
            // The new key is stored first: a lost answer leaves `.com` on a key this device holds.
            Keystore.previousAccountDeviceKey = key.rawRepresentation
            try Keystore.storeAccountDeviceSigningKey(newKey, accountId: u, deviceId: deviceId)
            defer { Keystore.previousAccountDeviceKey = nil }
            do {
                _ = try await server.accountKeyJson(method: "POST", path: "/api/accounts/\(u)/devices/\(deviceId)/key", body: body)
            } catch {
                // A lost answer may still have been applied: keep whichever key `.com` accepts.
                if (try? await directory(server: server, username: u, deviceId: deviceId, key: newKey)) == nil {
                    try Keystore.storeAccountDeviceSigningKey(key, accountId: u, deviceId: deviceId)
                    return .failed
                }
            }
            PqIdentityBindingService.bindInBackground(username: u, identities: [PqIdentity(role: .device, subjectId: deviceId, edKey: newKey)])
            if let name = dir.selfProfiles.first(where: { $0.deviceId == deviceId }).flatMap({ p in
                try? AccountMetadata.decrypt(ciphertext: .init(nonceHex: p.nonceHex, ciphertextHex: p.ciphertextHex),
                                             keyBytes: AccountMetadata.deriveDeviceDirectoryKey(umk: umk),
                                             coordinates: .init(accountId: u, deviceId: deviceId, recordType: .deviceSelfProfile,
                                                                revision: p.revision, keyVersion: p.keyVersion))
            }) {
                let rev = dir.selfProfiles.first(where: { $0.deviceId == deviceId })?.revision ?? 0
                await putSelfProfile(server: server, username: u, deviceId: deviceId, key: newKey, umk: umk, name: name, expected: rev)
            }
            await publishReceiveKey(server: server, username: u, deviceId: deviceId)
            return .migrated
        } catch {
            return .failed
        }
    }

    // MARK: - Self profile

    static func putSelfProfile(server: any FlagshipServerClient, username u: String, deviceId: String, key: Curve25519.Signing.PrivateKey,
                               umk: Data, name: String, expected: Int64) async {
        let revision = expected + 1
        guard let ct = try? AccountMetadata.encrypt(displayName: name, keyBytes: AccountMetadata.deriveDeviceDirectoryKey(umk: umk),
                                                    coordinates: .init(accountId: u, deviceId: deviceId, recordType: .deviceSelfProfile,
                                                                       revision: revision, keyVersion: 1)) else { return }
        let pub = HexUtil.encode(key.publicKey.rawRepresentation)
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        guard let sig = try? key.signature(for: AccountMetadata.canonicalDeviceSelfProfile(
            accountId: u, deviceId: deviceId, revision: revision, keyVersion: 1, ciphertext: ct, issuedAt: issuedAt, signerPubHex: pub)),
              let auth = try? authorization(key, username: u, deviceId: deviceId, method: "PUT", path: "/api/accounts/\(u)/devices/\(deviceId)/profile")
        else { return }
        try? await server.putDeviceSelfProfile(accountId: u, deviceId: deviceId, authorization: auth, body: .init(profile: .init(
            accountId: u, deviceId: deviceId, revision: revision, keyVersion: 1, nonceHex: ct.nonceHex, ciphertextHex: ct.ciphertextHex,
            issuedAt: issuedAt, signerPubHex: pub, signatureHex: HexUtil.encode(Data(sig))), expectedRevision: expected))
    }

    // MARK: - A kept device takes its new key

    public enum ReceiveOutcome: Equatable, Sendable {
        /// Nothing waits for this device.
        case upToDate
        /// A new key waits; opening it needs the unlock (`interactive: false` never prompts).
        case waiting
        case installed(toEpoch: Int64)
        case failed(String)
    }

    public static let receiveFailedLine = String(localized: "This device couldn't check the new account key. Ask an admin device to add it again.")

    /// What `.com` holds for the account (`GET /api/username/:u`): its IRK, admin root and key epoch.
    public struct ComState: Equatable, Sendable {
        public let irkPub: String
        public let adminRootPub: String?
        public let keyEpoch: Int64
    }

    public static func comState(server: any FlagshipServerClient, username: String) async -> ComState? {
        guard let o = try? await server.accountKeyJson(method: "GET", path: "/api/username/\(username.lowercased())"),
              let irk = o["irkPub"] as? String else { return nil }
        return ComState(irkPub: irk.lowercased(), adminRootPub: (o["adminRootPub"] as? String)?.lowercased(),
                        keyEpoch: (o["keyEpoch"] as? NSNumber)?.int64Value ?? 0)
    }

    /// The account's lane against what this device holds; installs the newest key it was kept with. Prompts at
    /// most once (the unlock opens the receive key and the current account key) and only when `interactive`.
    public static func receive(server: any FlagshipServerClient, username: String, deviceId: String, interactive: Bool,
                               selfName: String?, reason: String = String(localized: "Get your new account key")) async -> ReceiveOutcome {
        let u = username.lowercased()
        guard AccountMetadata.isDeviceId(deviceId), let com = await comState(server: server, username: u) else { return .upToDate }
        let local = Keystore.accountKeyEpoch()
        let comEpoch = com.keyEpoch
        // The admin root this device replays from is its own, or the one its SAS-confirmed join bundle named;
        // never `.com`'s word. A device joined before bundles named it holds no pin and is added again.
        guard comEpoch > local else { return .upToDate }
        if !interactive && Keystore.sessionUMKIfCached() == nil { return .waiting }
        guard let key = deviceKey(username: u, deviceId: deviceId) else { return interactive ? .failed(receiveFailedLine) : .waiting }
        let path = "/api/accounts/\(u)/devices/\(deviceId)/umk-rotation"
        do {
            let answer = try await server.accountKeyJson(method: "GET", path: path,
                                                         authorization: try authorization(key, username: u, deviceId: deviceId, method: "GET", path: path))
            guard let root = Keystore.accountKeyAdminRootPin() else { return .failed(receiveFailedLine) }
            let irk = try await Keystore.deriveIRK(reason: reason)
            let replay = try AccountKeyRotationFlow.replay(lane: (answer["lane"] as? [[String: Any]]) ?? [], username: u,
                                                           pinnedAdminRootPubHex: root, epoch: local,
                                                           irkPubHex: HexUtil.encode(irk.publicKey.rawRepresentation))
            guard !replay.hops.isEmpty else { return .failed(receiveFailedLine) }
            let me = AccountKeyRotation.KeptDevice(deviceId: deviceId, devicePubHex: HexUtil.encode(key.publicKey.rawRepresentation))
            var receiveSeed: [UInt8]?
            let opened = try await openAll(deliveries: (answer["deliveries"] as? [[String: Any]]) ?? [], replay: replay, me: me) { kind in
                switch kind {
                case .ed25519: return Array(key.rawRepresentation)
                case .xwing:
                    if let receiveSeed { return receiveSeed }
                    let s = try await Keystore.receiveKeySeed(reason: reason)
                    receiveSeed = s
                    return s
                }
            }
            guard let last = opened.last, let scheme = AccountKeyRotation.IrkScheme(rawValue: last.rotation.newIrkScheme) else {
                return .failed(receiveFailedLine)
            }
            try await Keystore.installRotatedUMK(last.plaintext.umk, scheme: scheme, toEpoch: last.rotation.toEpoch, reason: reason)
            Keystore.setAccountKeyAdminRootPin(replay.adminRootPubHex)
            if let seed = opened.compactMap(\.plaintext.adminRootSeed).last,
               let rootKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: Data(seed)),
               HexUtil.encode(rootKey.publicKey.rawRepresentation) == replay.adminRootPubHex {
                _ = try? await Keystore.importAdminRoot(seed: Data(seed), reason: reason)
            }
            // `.com` dropped every self profile at the hop; this device writes its own again under the new key.
            await putSelfProfile(server: server, username: u, deviceId: deviceId, key: key, umk: Data(last.plaintext.umk),
                                 name: selfName ?? String(localized: "iPhone"), expected: 0)
            let ackPath = path + "/ack"
            _ = try? await server.accountKeyJson(method: "POST", path: ackPath,
                                                 authorization: try authorization(key, username: u, deviceId: deviceId, method: "POST", path: ackPath),
                                                 body: ["toEpoch": last.rotation.toEpoch])
            try? Keystore.setPushTokenId(nil)
            Keystore.clearWatchDelegate()
            return .installed(toEpoch: last.rotation.toEpoch)
        } catch let r as AccountKeyRefusal where r.code == "device-removed" {
            // Not kept: the shared gate already heard `.com` and runs the removed screen.
            return .upToDate
        } catch where Keystore.isPromptUnavailable(error) || BiometricGate.GateError.from(error).isSilent {
            return .waiting
        } catch {
            return .failed(receiveFailedLine)
        }
    }

    static func openAll(deliveries: [[String: Any]], replay: AccountKeyRotationFlow.Replay, me: AccountKeyRotation.KeptDevice,
                        secret: (AccountKeyRotation.SealKind) async throws -> [UInt8]) async throws -> [AccountKeyRotationFlow.Opened] {
        // Fetch each secret the deliveries need first (the open itself is synchronous).
        var secrets: [AccountKeyRotation.SealKind: [UInt8]] = [:]
        for raw in deliveries {
            if let k = AccountKeyRotation.SealKind(rawValue: (raw["sealKind"] as? String) ?? ""), secrets[k] == nil { secrets[k] = try await secret(k) }
        }
        return try AccountKeyRotationFlow.open(deliveries: deliveries, replay: replay, selfDevice: me) { kind in
            guard let s = secrets[kind] else { throw AccountKeyRotation.Failure("open-failed") }
            return s
        }
    }


    // MARK: - The rotator: promote, resume

    /// Installs the key `.com` now holds: UMK (old one retired), IRK at v1 of its scheme, the new admin root when it
    /// rotated, this device's self profile again, the progress record, and the recovery warning when the hop
    /// deleted cloud recovery.
    public static func promote(_ p: AccountKeyPromotion, server: any FlagshipServerClient, selfName: String?) async throws {
        let reason = RotateAccountKeyViewModel.reason
        try await Keystore.installRotatedUMK(p.newUmk, scheme: p.scheme, toEpoch: p.toEpoch, reason: reason)
        var root: Curve25519.Signing.PrivateKey?
        if let seed = p.newAdminRootSeed {
            _ = try await Keystore.importAdminRoot(seed: Data(seed), reason: reason)
            root = try? Curve25519.Signing.PrivateKey(rawRepresentation: Data(seed))
        }
        if let pin = root.map({ HexUtil.encode($0.publicKey.rawRepresentation) }) ?? Keystore.adminRootPubHex() {
            Keystore.setAccountKeyAdminRootPin(pin)
        }
        Keystore.clearPendingAccountKey()
        Keystore.accountKeyProgress = Keystore.RotationProgressRecord(toEpoch: p.toEpoch, keptDeviceIds: p.keptDeviceIds)
        if p.hadRecovery { Keystore.accountKeyRecoveryOff = true }
        try? Keystore.setPushTokenId(nil)
        Keystore.clearWatchDelegate()
        let u = p.username.lowercased()
        if let irk = try? IrkLineage.key(umk: SymmetricKey(data: Data(p.newUmk)), scheme: IrkLineage.Scheme(rawValue: p.scheme.rawValue) ?? .ios, version: 1) {
            var ids = [PqIdentity(role: .accountIrk, subjectId: u, edKey: irk.privateKey)]
            if let root { ids.append(PqIdentity(role: .adminRoot, subjectId: u, edKey: root)) }
            PqIdentityBindingService.bindInBackground(username: u, identities: ids)
        }
        if let key = deviceKey(username: u, deviceId: p.deviceId) {
            await putSelfProfile(server: server, username: u, deviceId: p.deviceId, key: key, umk: Data(p.newUmk),
                                 name: selfName ?? String(localized: "iPhone"), expected: 0)
        }
    }

    /// A rotation this device sent before it stopped: promote it when `.com` holds its key, send it once more
    /// while it is fresh and nothing moved, else forget it.
    @discardableResult
    public static func resumePending(server: any FlagshipServerClient, username: String, deviceId: String, selfName: String?,
                                     now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) async -> AccountKeyRotationFlow.PendingDecision? {
        guard let p = Keystore.pendingAccountKey(), p.username == username.lowercased(),
              let com = await comState(server: server, username: p.username) else { return nil }
        let decision = AccountKeyRotationFlow.decidePending(comIrkPubHex: com.irkPub, pendingNewIrkPubHex: p.newIrkPubHex,
                                                           pendingOldIrkPubHex: p.oldIrkPubHex, issuedAt: p.issuedAt, now: now)
        switch decision {
        case .drop:
            Keystore.clearPendingAccountKey()
            return .drop
        case .retry:
            let applied = ((try? await server.accountKeyCall(method: "POST", path: "/api/users/\(p.username)/account-key-rotation",
                                                            authorization: nil, body: p.body))?.status).map { (200..<300).contains($0) } ?? false
            if !applied { Keystore.clearPendingAccountKey(); return .drop }
            fallthrough
        case .promote:
            guard Keystore.sessionUMKIfCached() != nil,
                  let opened = try? await Keystore.openPendingAccountKey(p, reason: RotateAccountKeyViewModel.reason),
                  let scheme = AccountKeyRotation.IrkScheme(rawValue: p.scheme)
            else { return .promote }
            try? await promote(.init(username: p.username, deviceId: deviceId, newUmk: opened.umk, scheme: scheme, toEpoch: p.toEpoch,
                                     newAdminRootSeed: opened.adminRoot, keptDeviceIds: p.keptDeviceIds, hadRecovery: p.hadRecovery),
                               server: server, selfName: selfName)
            return .promote
        }
    }
}

extension QuantumSafetyService {
    /// The hop's hybrid companion (`flagship/account-key-rotation/v2`): the admin root's PQ half signs, and the new
    /// IRK gets a fresh ML-DSA key bound to it. Nil when this device holds no PQ half for the root.
    static func accountKeyRotationCompanion(_ r: AccountKeyRotation.Rotation, adminRoot: Curve25519.Signing.PrivateKey,
                                            newIrk: Curve25519.Signing.PrivateKey) async -> [String: Any]? {
        let user = r.username.lowercased()
        guard let rootSign = await boundSigner(role: .adminRoot, username: user, edKey: adminRoot, requireBound: false) else { return nil }
        let id = PqIdentity(role: .accountIrk, subjectId: user, edKey: newIrk)
        guard let held = await PqKeyStore.shared.key(for: id), let ml = QSHex.unhex(held.mldsaPubHex) else { return nil }
        let edPub = [UInt8](newIrk.publicKey.rawRepresentation)
        let irkSign: (String, [UInt8]) throws -> [UInt8] = { purpose, payload in
            try PqHybrid.hybridSign(edPublicKey: edPub, mldsaPublicKey: ml, purpose: purpose, payload: payload,
                                    edSign: { [UInt8](try newIrk.signature(for: Data($0))) }, mldsaSign: held.sign)
        }
        let st = PqKeyBindingStatement(role: PqBindingRole.accountIrk.rawValue, subjectId: user, ed25519PubHex: QSHex.hex(edPub),
                                       mldsaPubHex: held.mldsaPubHex, issuedAt: r.issuedAt)
        guard let binding = try? PqTrust.signPqKeyBinding(st, signer: irkSign) else { return nil }
        return try? AccountKeyRotation.signPq(r, newIrkBinding: binding, adminRootSign: rootSign)
    }
}

