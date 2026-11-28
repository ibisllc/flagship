import Foundation
import CryptoKit
import FlagshipAPI

/// The client side of an account master-key rotation (docs/account-key-rotation.md), without any
/// Keychain: which devices keep the account, the body the rotator posts, the lane a kept device
/// replays from the admin root it pins, and opening its delivery. The Keystore-bound steps live in
/// the app (`AccountKeyRotationService`).
public enum AccountKeyRotationFlow {

    // MARK: - Who keeps the account

    /// One active device of the account, as the directory lists it.
    public struct Device: Equatable, Sendable, Identifiable {
        public var deviceId: String
        public var devicePubHex: String
        public var displayName: String
        public var platformClass: String?
        public var createdAt: Int64
        /// The scopes of its live grants.
        public var scopes: [String]
        /// "admin-root" when every live grant is signed by the admin root; else the old account key signed one.
        public var grantSignerRoot: String?
        public var receiveKey: DeviceReceiveKeyRecord?
        public var id: String { deviceId }

        public init(deviceId: String, devicePubHex: String, displayName: String, platformClass: String?, createdAt: Int64,
                    scopes: [String], grantSignerRoot: String?, receiveKey: DeviceReceiveKeyRecord?) {
            self.deviceId = deviceId.lowercased(); self.devicePubHex = devicePubHex.lowercased(); self.displayName = displayName
            self.platformClass = platformClass; self.createdAt = createdAt; self.scopes = scopes
            self.grantSignerRoot = grantSignerRoot; self.receiveKey = receiveKey
        }

        public var isAdmin: Bool { scopes.contains("admin") }
        public var isBrowser: Bool { platformClass == "web" || platformClass == "browser" }
    }

    /// Why a device cannot keep the account and has to be added again.
    public enum Exclusion: String, Sendable, Equatable {
        /// Its key is `HKDF(old UMK, …)`: whoever holds the old account key can sign as it.
        case derivedKey = "derived-key"
        /// Under strict only an X-Wing delivery is accepted, and it published no (valid) receive key.
        case noReceiveKey = "no-receive-key"
    }

    public struct Excluded: Equatable, Sendable {
        public var device: Device
        public var reason: Exclusion
    }

    public struct Plan: Equatable, Sendable {
        public var selfDevice: Device
        public var removed: Device
        /// The rotator first, then the others by date added.
        public var kept: [Device]
        public var excluded: [Excluded]
        /// The removed device's grant carries `admin`: it may hold the admin root, which changes first.
        public var removedMayHoldAdminRoot: Bool
    }

    public struct PlanError: Error, Equatable { public let code: String }

    /// A receive key that verifies under the device's own key, or nil.
    public static func validReceiveKey(_ d: Device, username: String) -> DeviceReceiveKeyRecord? {
        guard let k = d.receiveKey, k.deviceId == d.deviceId, k.devicePubHex.lowercased() == d.devicePubHex,
              AccountKeyRotation.verifyDeviceReceiveKey(username: username.lowercased(), deviceId: k.deviceId, devicePubHex: d.devicePubHex,
                                                        xwingPubHex: k.xwingPubHex.lowercased(), issuedAt: k.issuedAt,
                                                        signatureHex: k.signatureHex.lowercased())
        else { return nil }
        return k
    }

    public static func plan(devices: [Device], selfDeviceId: String, removedDeviceId: String, oldUmk: [UInt8],
                            accountName: String, strict: Bool) throws -> Plan {
        let me = selfDeviceId.lowercased(), gone = removedDeviceId.lowercased()
        guard let selfDevice = devices.first(where: { $0.deviceId == me }) else { throw PlanError(code: "self-not-listed") }
        guard me != gone, let removed = devices.first(where: { $0.deviceId == gone }) else { throw PlanError(code: "removed-not-listed") }
        if AccountKeyRotation.deviceKeyIsUmkDerived(umk: oldUmk, accountName: accountName, deviceId: me, devicePubHex: selfDevice.devicePubHex) {
            throw PlanError(code: "self-key-derived")
        }
        var kept: [Device] = [selfDevice]
        var excluded: [Excluded] = []
        for d in devices.sorted(by: { $0.createdAt < $1.createdAt }) where d.deviceId != me && d.deviceId != gone {
            if AccountKeyRotation.deviceKeyIsUmkDerived(umk: oldUmk, accountName: accountName, deviceId: d.deviceId, devicePubHex: d.devicePubHex) {
                excluded.append(Excluded(device: d, reason: .derivedKey))
            } else if validReceiveKey(d, username: accountName) == nil && (strict || d.receiveKey != nil) {
                // A device whose receive key `.com` holds gets X-Wing or nothing (`.com` refuses the classical seal).
                excluded.append(Excluded(device: d, reason: .noReceiveKey))
            } else {
                kept.append(d)
            }
        }
        return Plan(selfDevice: selfDevice, removed: removed, kept: kept, excluded: excluded, removedMayHoldAdminRoot: removed.isAdmin)
    }

    // MARK: - The rotator's request

    public struct Keys {
        public var oldUmk: [UInt8]
        public var newUmk: [UInt8]
        public var scheme: AccountKeyRotation.IrkScheme
        /// The IRK `.com` holds now.
        public var oldIrkPubHex: String
        public var oldAidPubHex: String
        /// The admin root that signs the hop and the deliveries (the new one when it rotates in the same request).
        public var adminRoot: Curve25519.Signing.PrivateKey
        /// When the admin root rotated: its seed, for kept admin devices' deliveries.
        public var rotatedAdminRootSeed: [UInt8]?

        public init(oldUmk: [UInt8], newUmk: [UInt8], scheme: AccountKeyRotation.IrkScheme, oldIrkPubHex: String,
                    oldAidPubHex: String, adminRoot: Curve25519.Signing.PrivateKey, rotatedAdminRootSeed: [UInt8]? = nil) {
            self.oldUmk = oldUmk; self.newUmk = newUmk; self.scheme = scheme; self.oldIrkPubHex = oldIrkPubHex
            self.oldAidPubHex = oldAidPubHex; self.adminRoot = adminRoot; self.rotatedAdminRootSeed = rotatedAdminRootSeed
        }
    }

    /// A profile name to carry under the new key: its plaintext and the revision `.com` holds.
    public struct ProfileName: Equatable, Sendable {
        public var deviceId: String?
        public var displayName: String
        public var revision: Int64
        public var locked: Bool
        public init(deviceId: String? = nil, displayName: String, revision: Int64, locked: Bool = false) {
            self.deviceId = deviceId; self.displayName = displayName; self.revision = revision; self.locked = locked
        }
    }

    public struct Built {
        public var rotation: AccountKeyRotation.Rotation
        public var digestHex: String
        public var body: [String: Any]
        public var newIrkPubHex: String
    }

    public static func newIrkSeed(_ keys: Keys) -> [UInt8] { AccountKeyRotation.irkSeed(umk: keys.newUmk, scheme: keys.scheme) }

    /// The whole `POST /api/users/:u/account-key-rotation` body. `pq` builds the hybrid companion for a
    /// strict account; `adminRootRotation` is the admin-root rotation body to apply first.
    public static func build(username rawUser: String, fromEpoch: Int64, plan: Plan, keys: Keys,
                             adminRootRotation: [String: Any]? = nil, accountProfile: ProfileName? = nil,
                             managedProfiles: [ProfileName] = [],
                             pq: ((AccountKeyRotation.Rotation) throws -> [String: Any]?)? = nil,
                             now: Int64, nonceHex: String? = nil,
                             randomness: [String: [UInt8]] = [:]) throws -> Built {
        let username = rawUser.lowercased()
        let newIrk = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(newIrkSeed(keys)))
        let newAid = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(AccountKeyRotation.aidSeed(umk: keys.newUmk)))
        let rootPubHex = HexUtil.encode(keys.adminRoot.publicKey.rawRepresentation)
        let keptKeys = plan.kept.map { AccountKeyRotation.KeptDevice(deviceId: $0.deviceId, devicePubHex: $0.devicePubHex) }
        let rotation = AccountKeyRotation.Rotation(
            username: username, fromEpoch: fromEpoch, toEpoch: fromEpoch + 1, oldIrkPubHex: keys.oldIrkPubHex.lowercased(),
            newIrkPubHex: HexUtil.encode(newIrk.publicKey.rawRepresentation), newIrkScheme: keys.scheme.rawValue,
            oldAidPubHex: keys.oldAidPubHex.lowercased(), newAidPubHex: HexUtil.encode(newAid.publicKey.rawRepresentation),
            adminRootPubHex: rootPubHex, removedDeviceIds: [plan.removed.deviceId],
            keptDevicesDigestHex: try AccountKeyRotation.keptDevicesDigestHex(keptKeys), recoveryRecordDigestHex: nil,
            nonceHex: nonceHex ?? HexUtil.encode(Data((0..<16).map { _ in UInt8.random(in: 0...255) })), issuedAt: now)
        let rootSign: AccountKeyRotation.Signer = { msg in Array(try keys.adminRoot.signature(for: Data(msg))) }
        let sigs = try AccountKeyRotation.sign(rotation, adminRoot: rootSign,
                                               newIrk: { Array(try newIrk.signature(for: Data($0))) },
                                               newAid: { Array(try newAid.signature(for: Data($0))) })

        var deliveries: [[String: Any]] = []
        for d in plan.kept where d.deviceId != plan.selfDevice.deviceId {
            let plaintext = try AccountKeyRotation.encodePlaintext(.init(
                umk: keys.newUmk, irkScheme: keys.scheme, adminRootSeed: d.isAdmin ? keys.rotatedAdminRootSeed : nil))
            let sealed: [UInt8]
            let kind: AccountKeyRotation.SealKind
            if let rk = validReceiveKey(d, username: username), let pk = PqBin.unhex(rk.xwingPubHex.lowercased()) {
                sealed = try AccountKeyRotation.sealXWing(rotation, deviceId: d.deviceId, plaintext: plaintext, receiveKey: pk,
                                                          issuedAt: now, randomness: randomness[d.deviceId])
                kind = .xwing
            } else {
                sealed = try AccountKeyRotation.sealEd25519(plaintext: plaintext, devicePub: PqBin.unhex(d.devicePubHex) ?? [])
                kind = .ed25519
            }
            let (delivery, sig) = try AccountKeyRotation.buildDelivery(rotation, deviceId: d.deviceId, devicePubHex: d.devicePubHex,
                                                                       sealed: sealed, issuedAt: now, adminRoot: rootSign)
            deliveries.append([
                "delivery": deliveryJson(delivery), "signatureHex": sig, "sealKind": kind.rawValue, "sealedHex": PqBin.hex(sealed),
            ])
        }

        var grants: [[String: Any]] = []
        for d in plan.kept where d.grantSignerRoot != "admin-root" && !d.scopes.isEmpty {
            let env = DeviceCapabilityGrantEnvelope(
                grantId: UUID().uuidString.lowercased(), username: username, deviceId: d.deviceId, devicePubKeyHex: d.devicePubHex,
                scopes: d.scopes, issuedAt: now, expiresAt: now + 90 * 24 * 3_600_000)
            let sig = try keys.adminRoot.signature(for: env.canonicalBytes())
            grants.append([
                "grant": ["grantId": env.grantId, "username": username, "deviceId": d.deviceId, "devicePubKey": d.devicePubHex,
                          "scopes": d.scopes, "issuedAt": env.issuedAt, "expiresAt": env.expiresAt],
                "signature": HexUtil.encode(sig), "signerRoot": "admin-root",
            ])
        }

        var body: [String: Any] = [
            "rotation": rotationJson(rotation),
            "signatures": ["adminRootSignatureHex": sigs.adminRootSignatureHex, "newIrkSignatureHex": sigs.newIrkSignatureHex,
                           "newAidSignatureHex": sigs.newAidSignatureHex],
            "kept": keptKeys.map { ["deviceId": $0.deviceId, "devicePubHex": $0.devicePubHex] },
            "deliveries": deliveries,
            "grants": grants,
        ]
        if let adminRootRotation { body["adminRootRotation"] = adminRootRotation }
        if let pq, let companion = try pq(rotation) { body["pq"] = companion }
        let newUmkData = Data(keys.newUmk)
        if let p = accountProfile {
            let revision = p.revision + 1
            let ct = try AccountMetadata.encrypt(displayName: p.displayName, keyBytes: AccountMetadata.deriveAccountProfileKey(umk: newUmkData),
                                                 coordinates: .init(accountId: username, recordType: .accountProfile, revision: revision, keyVersion: 1))
            let sig = try keys.adminRoot.signature(for: AccountMetadata.canonicalAccountProfile(
                accountId: username, revision: revision, keyVersion: 1, ciphertext: ct, issuedAt: now, signerPubHex: rootPubHex))
            body["accountProfile"] = ["accountId": username, "revision": revision, "keyVersion": 1, "nonceHex": ct.nonceHex,
                                      "ciphertextHex": ct.ciphertextHex, "issuedAt": now, "signerPubHex": rootPubHex,
                                      "signatureHex": HexUtil.encode(sig)]
        }
        let keptIds = Set(plan.kept.map(\.deviceId))
        var managed: [[String: Any]] = []
        for m in managedProfiles {
            guard let id = m.deviceId?.lowercased(), keptIds.contains(id) else { continue }
            let revision = m.revision + 1
            let ct = try AccountMetadata.encrypt(displayName: m.displayName, keyBytes: AccountMetadata.deriveDeviceDirectoryKey(umk: newUmkData),
                                                 coordinates: .init(accountId: username, deviceId: id, recordType: .deviceManagedProfile,
                                                                    revision: revision, keyVersion: 1))
            let sig = try keys.adminRoot.signature(for: AccountMetadata.canonicalDeviceManagedProfile(
                accountId: username, deviceId: id, revision: revision, keyVersion: 1, ciphertext: ct, locked: m.locked,
                issuedAt: now, signerPubHex: rootPubHex))
            managed.append(["accountId": username, "deviceId": id, "revision": revision, "keyVersion": 1, "nonceHex": ct.nonceHex,
                            "ciphertextHex": ct.ciphertextHex, "locked": m.locked, "issuedAt": now, "signerPubHex": rootPubHex,
                            "signatureHex": HexUtil.encode(sig)])
        }
        if !managed.isEmpty { body["managedProfiles"] = managed }
        return Built(rotation: rotation, digestHex: try AccountKeyRotation.digestHex(rotation), body: body,
                     newIrkPubHex: rotation.newIrkPubHex)
    }

    public static func rotationJson(_ r: AccountKeyRotation.Rotation) -> [String: Any] {
        ["username": r.username, "fromEpoch": r.fromEpoch, "toEpoch": r.toEpoch, "oldIrkPubHex": r.oldIrkPubHex,
         "newIrkPubHex": r.newIrkPubHex, "newIrkScheme": r.newIrkScheme, "oldAidPubHex": r.oldAidPubHex,
         "newAidPubHex": r.newAidPubHex, "adminRootPubHex": r.adminRootPubHex, "removedDeviceIds": r.removedDeviceIds,
         "keptDevicesDigestHex": r.keptDevicesDigestHex, "recoveryRecordDigestHex": r.recoveryRecordDigestHex.map { $0 as Any } ?? NSNull(),
         "nonceHex": r.nonceHex, "issuedAt": r.issuedAt]
    }

    static func deliveryJson(_ d: AccountKeyRotation.Delivery) -> [String: Any] {
        ["username": d.username, "toEpoch": d.toEpoch, "deviceId": d.deviceId, "devicePubHex": d.devicePubHex,
         "rotationDigestHex": d.rotationDigestHex, "sealedDigestHex": d.sealedDigestHex, "issuedAt": d.issuedAt]
    }

    // MARK: - Parsing what `.com` serves

    static func int64(_ v: Any?) -> Int64? {
        if let n = v as? NSNumber { return n.int64Value }
        return nil
    }

    public static func parseRotation(_ v: Any?) -> AccountKeyRotation.Rotation? {
        guard let o = v as? [String: Any],
              let u = o["username"] as? String, let from = int64(o["fromEpoch"]), let to = int64(o["toEpoch"]),
              let oldIrk = o["oldIrkPubHex"] as? String, let newIrk = o["newIrkPubHex"] as? String,
              let scheme = o["newIrkScheme"] as? String, let oldAid = o["oldAidPubHex"] as? String,
              let newAid = o["newAidPubHex"] as? String, let root = o["adminRootPubHex"] as? String,
              let removed = o["removedDeviceIds"] as? [String], let kept = o["keptDevicesDigestHex"] as? String,
              let nonce = o["nonceHex"] as? String, let issuedAt = int64(o["issuedAt"])
        else { return nil }
        let rec = o["recoveryRecordDigestHex"] as? String
        return .init(username: u, fromEpoch: from, toEpoch: to, oldIrkPubHex: oldIrk, newIrkPubHex: newIrk, newIrkScheme: scheme,
                     oldAidPubHex: oldAid, newAidPubHex: newAid, adminRootPubHex: root, removedDeviceIds: removed,
                     keptDevicesDigestHex: kept, recoveryRecordDigestHex: rec, nonceHex: nonce, issuedAt: issuedAt)
    }

    static func parseDelivery(_ v: Any?) -> AccountKeyRotation.Delivery? {
        guard let o = v as? [String: Any], let u = o["username"] as? String, let to = int64(o["toEpoch"]),
              let id = o["deviceId"] as? String, let pub = o["devicePubHex"] as? String,
              let rd = o["rotationDigestHex"] as? String, let sd = o["sealedDigestHex"] as? String, let at = int64(o["issuedAt"])
        else { return nil }
        return .init(username: u, toEpoch: to, deviceId: id, devicePubHex: pub, rotationDigestHex: rd, sealedDigestHex: sd, issuedAt: at)
    }

    // MARK: - A kept device replays the lane

    public struct VerifiedHop: Sendable {
        public var rotation: AccountKeyRotation.Rotation
        public var kept: [AccountKeyRotation.KeptDevice]
    }

    public struct Replay: Sendable {
        /// The hops after the device's own epoch, in order, each verified under the root pinned at its place.
        public var hops: [VerifiedHop]
        /// The admin root after the whole lane.
        public var adminRootPubHex: String
        public var epoch: Int64
    }

    /// Replays `.com`'s lane from what this device holds: the admin root it pins, its epoch and its IRK. An
    /// admin-root rotation moves the pin only when the pinned root signed it; a hop counts only when the root
    /// pinned at that point signed it and it starts at this device's epoch from this device's IRK.
    public static func replay(lane: [[String: Any]], username: String, pinnedAdminRootPubHex: String, epoch: Int64,
                              irkPubHex: String) throws -> Replay {
        var root = pinnedAdminRootPubHex.lowercased()
        var e = epoch
        var irk = irkPubHex.lowercased()
        var hops: [VerifiedHop] = []
        for ev in lane {
            switch ev["kind"] as? String {
            case "admin-root-rotation":
                guard let r = ev["rotation"] as? [String: Any], let old = (r["oldAdminRootPubHex"] as? String)?.lowercased(),
                      let new = (r["newAdminRootPubHex"] as? String)?.lowercased(), let at = int64(r["issuedAt"]),
                      let sigHex = ev["signatureHex"] as? String, let sig = HexUtil.decode(sigHex), let oldPub = HexUtil.decode(old)
                else { throw AccountKeyRotation.Failure("malformed") }
                guard old == root else { continue }
                guard (r["username"] as? String)?.lowercased() == username.lowercased(),
                      AdminRootRotation(username: username.lowercased(), oldAdminRootPubHex: old, newAdminRootPubHex: new, issuedAt: at)
                        .verify(signature: sig, oldAdminRootPub: oldPub)
                else { throw AccountKeyRotation.Failure("bad-admin-root-rotation") }
                root = new
            case "account-key-rotation":
                guard let r = parseRotation(ev["rotation"]), let s = ev["signatures"] as? [String: Any],
                      let a = s["adminRootSignatureHex"] as? String, let i = s["newIrkSignatureHex"] as? String,
                      let d = s["newAidSignatureHex"] as? String
                else { throw AccountKeyRotation.Failure("malformed") }
                if r.toEpoch <= e { continue }
                try AccountKeyRotation.verify(r, signatures: .init(adminRootSignatureHex: a, newIrkSignatureHex: i, newAidSignatureHex: d),
                                              state: .init(username: username.lowercased(), epoch: e, irkPubHex: irk, aidPubHex: nil,
                                                           adminRootPubHex: root))
                let kept = ((ev["kept"] as? [[String: Any]]) ?? []).compactMap { k -> AccountKeyRotation.KeptDevice? in
                    guard let id = k["deviceId"] as? String, let pub = k["devicePubHex"] as? String else { return nil }
                    return .init(deviceId: id, devicePubHex: pub)
                }
                hops.append(VerifiedHop(rotation: r, kept: kept))
                e = r.toEpoch
                irk = r.newIrkPubHex
            default:
                continue
            }
        }
        return Replay(hops: hops, adminRootPubHex: root, epoch: e)
    }

    public struct Opened: Sendable {
        public var rotation: AccountKeyRotation.Rotation
        public var plaintext: AccountKeyRotation.Plaintext
    }

    /// Opens every delivery this device has for the verified hops, oldest first. `secret` gives the X-Wing
    /// receive-key seed or the device's Ed25519 seed. A hop this device is not kept in is refused.
    public static func open(deliveries: [[String: Any]], replay: Replay, selfDevice: AccountKeyRotation.KeptDevice,
                            secret: (AccountKeyRotation.SealKind) throws -> [UInt8]) throws -> [Opened] {
        var out: [Opened] = []
        for hop in replay.hops {
            try AccountKeyRotation.verifyKept(hop.rotation, kept: hop.kept, selfDevice: selfDevice)
            guard let raw = deliveries.first(where: {
                int64($0["toEpoch"]) == hop.rotation.toEpoch && parseDelivery($0["delivery"])?.deviceId == selfDevice.deviceId
            }) ?? deliveries.first(where: { int64($0["toEpoch"]) == hop.rotation.toEpoch }),
                  let d = parseDelivery(raw["delivery"]), let sig = raw["signatureHex"] as? String,
                  let sealedHex = raw["sealedHex"] as? String, let sealed = PqBin.unhex(sealedHex.lowercased()),
                  let kind = AccountKeyRotation.SealKind(rawValue: (raw["sealKind"] as? String) ?? "")
            else { throw AccountKeyRotation.Failure("no-delivery") }
            let p = try AccountKeyRotation.open(hop.rotation, delivery: d, signatureHex: sig.lowercased(), sealed: sealed, kind: kind,
                                                selfDevice: selfDevice, secret: try secret(kind))
            out.append(Opened(rotation: hop.rotation, plaintext: p))
        }
        return out
    }

    // MARK: - The rotator's pending slot

    public enum PendingDecision: Equatable, Sendable {
        /// `.com` holds the pending key: install it.
        case promote
        /// Nothing applied yet and the request is still fresh: send the same body again.
        case retry
        /// Another hop won, or the request went stale: forget it.
        case drop
    }

    public static let pendingFreshMs: Int64 = 15 * 60_000

    public static func decidePending(comIrkPubHex: String, pendingNewIrkPubHex: String, pendingOldIrkPubHex: String,
                                     issuedAt: Int64, now: Int64) -> PendingDecision {
        let com = comIrkPubHex.lowercased()
        if com == pendingNewIrkPubHex.lowercased() { return .promote }
        if com == pendingOldIrkPubHex.lowercased() && now - issuedAt < pendingFreshMs { return .retry }
        return .drop
    }

    // MARK: - Progress after a hop

    public struct Progress: Equatable, Sendable {
        public var devicesUpdated: Int
        public var devicesTotal: Int
        public var serversOnNewKey: Int
        public var serversTotal: Int
        /// Servers still on the old key (their names).
        public var waitingFor: [String]
        public var isComplete: Bool { devicesUpdated >= devicesTotal && serversOnNewKey >= serversTotal }
    }

    /// A kept device counts as updated once its own self profile is back (`.com` dropped them all at the hop
    /// and each device writes its own under the new key); a server once it verified the new epoch itself.
    public static func progress(kept: [String], selfProfileDeviceIds: Set<String>, servers: [(name: String, trustedEpoch: Int64?)],
                                keyEpoch: Int64) -> Progress {
        let ids = Set(kept.map { $0.lowercased() })
        let updated = ids.intersection(Set(selfProfileDeviceIds.map { $0.lowercased() })).count
        let onNew = servers.filter { ($0.trustedEpoch ?? -1) >= keyEpoch }
        return Progress(devicesUpdated: updated, devicesTotal: ids.count, serversOnNewKey: onNew.count, serversTotal: servers.count,
                        waitingFor: servers.filter { ($0.trustedEpoch ?? -1) < keyEpoch }.map(\.name))
    }
}
