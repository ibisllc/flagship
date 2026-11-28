import XCTest
import CryptoKit
import FlagshipAPI
@testable import FlagshipCore

/// The client side of an account key rotation (AccountKeyRotationFlow): the rotator's plan and body checked
/// against the protocol port, and a kept device replaying the lane and opening its delivery.
final class AccountKeyRotationFlowTests: XCTestCase {
    typealias F = AccountKeyRotationFlow
    typealias A = AccountKeyRotation
    let user = "alice"

    struct Phone {
        let id: String
        let key: Curve25519.Signing.PrivateKey
        let xwingSeed: [UInt8]?
        var pubHex: String { HexUtil.encode(key.publicKey.rawRepresentation) }
    }

    func id() -> String { HexUtil.encode(Data((0..<16).map { _ in UInt8.random(in: 0...255) })) }

    func phone(xwing: Bool, derivedFrom umk: [UInt8]? = nil) throws -> Phone {
        let i = id()
        let key: Curve25519.Signing.PrivateKey
        if let umk { key = try AccountMetadata.deriveAccountDeviceKey(umk: Data(umk), accountId: user, deviceId: i) } else { key = .init() }
        return Phone(id: i, key: key, xwingSeed: xwing ? PqBin.random(32) : nil)
    }

    func device(_ p: Phone, name: String, scopes: [String] = DeviceCapabilityGrantEnvelope.memberScopes, signer: String = "membership",
                created: Int64, badReceiveKey: Bool = false) throws -> F.Device {
        var rk: DeviceReceiveKeyRecord?
        if let seed = p.xwingSeed {
            let pk = try PqHybrid.hybridSealKeygen(seed: seed).publicKey
            let pkHex = PqBin.hex(pk)
            let msg = try A.canonicalDeviceReceiveKey(username: user, deviceId: p.id, devicePubHex: p.pubHex, xwingPubHex: pkHex, issuedAt: 5)
            let sig = badReceiveKey ? Data(repeating: 1, count: 64) : try p.key.signature(for: Data(msg))
            rk = DeviceReceiveKeyRecord(deviceId: p.id, devicePubHex: p.pubHex, xwingPubHex: pkHex, issuedAt: 5, signatureHex: HexUtil.encode(sig))
        }
        return F.Device(deviceId: p.id, devicePubHex: p.pubHex, displayName: name, platformClass: "ios", createdAt: created,
                        scopes: scopes, grantSignerRoot: signer, receiveKey: rk)
    }

    struct World {
        var oldUmk: [UInt8]
        var root: Curve25519.Signing.PrivateKey
        var me: Phone, kept: Phone, keptEd: Phone, derived: Phone, removed: Phone
        var devices: [F.Device]
    }

    func world() throws -> World {
        let oldUmk = PqBin.random(32)
        let me = try phone(xwing: true), kept = try phone(xwing: true), keptEd = try phone(xwing: false)
        let derived = try phone(xwing: true, derivedFrom: oldUmk), removed = try phone(xwing: true)
        let devices = [
            try device(me, name: "Mine", scopes: DeviceCapabilityGrantEnvelope.deviceScopeOrder, signer: "admin-root", created: 1),
            try device(kept, name: "Tablet", created: 2),
            try device(keptEd, name: "Old phone", created: 3),
            try device(derived, name: "Laptop", created: 4),
            try device(removed, name: "Lost phone", scopes: DeviceCapabilityGrantEnvelope.deviceScopeOrder, signer: "admin-root", created: 5),
        ]
        return World(oldUmk: oldUmk, root: .init(), me: me, kept: kept, keptEd: keptEd, derived: derived, removed: removed, devices: devices)
    }

    func pub(_ seed: [UInt8]) throws -> String { HexUtil.encode(try Curve25519.Signing.PrivateKey(rawRepresentation: Data(seed)).publicKey.rawRepresentation) }

    func build(_ w: World, plan: F.Plan, fromEpoch: Int64 = 0, newUmk: [UInt8], scheme: A.IrkScheme = .ios, now: Int64 = 1_000) throws -> F.Built {
        let keys = F.Keys(oldUmk: w.oldUmk, newUmk: newUmk, scheme: scheme, oldIrkPubHex: try pub(A.irkSeed(umk: w.oldUmk, scheme: .ios)),
                          oldAidPubHex: try pub(A.aidSeed(umk: w.oldUmk)), adminRoot: w.root)
        return try F.build(username: user, fromEpoch: fromEpoch, plan: plan, keys: keys,
                           accountProfile: .init(displayName: "Family", revision: 3),
                           managedProfiles: [.init(deviceId: w.kept.id, displayName: "Kid's tablet", revision: 1, locked: true),
                                             .init(deviceId: w.removed.id, displayName: "Gone", revision: 1)],
                           now: now)
    }

    /// What `.com` would serve in its lane for the hop the body carries.
    func laneEvent(_ body: [String: Any]) -> [String: Any] {
        ["kind": "account-key-rotation", "rotation": body["rotation"]!, "signatures": body["signatures"]!, "kept": body["kept"]!]
    }

    /// The body as it travels: JSON round-trip (numbers become NSNumber).
    func wire(_ o: [String: Any]) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: o)) as? [String: Any])
    }

    func testPlanKeepsRandomKeysAndExcludesDerivedOnes() throws {
        let w = try world()
        let plan = try F.plan(devices: w.devices, selfDeviceId: w.me.id, removedDeviceId: w.removed.id, oldUmk: w.oldUmk,
                              accountName: user, strict: false)
        XCTAssertEqual(plan.kept.map(\.deviceId), [w.me.id, w.kept.id, w.keptEd.id])
        XCTAssertEqual(plan.excluded.map(\.device.deviceId), [w.derived.id])
        XCTAssertEqual(plan.excluded.first?.reason, .derivedKey)
        XCTAssertTrue(plan.removedMayHoldAdminRoot)
        let strict = try F.plan(devices: w.devices, selfDeviceId: w.me.id, removedDeviceId: w.removed.id, oldUmk: w.oldUmk,
                                accountName: user, strict: true)
        XCTAssertEqual(strict.kept.map(\.deviceId), [w.me.id, w.kept.id])
        XCTAssertEqual(Set(strict.excluded.map(\.reason)), [.derivedKey, .noReceiveKey])
    }

    func testPlanExcludesABadReceiveKeyEvenOutsideStrict() throws {
        var w = try world()
        w.devices[1] = try device(w.kept, name: "Tablet", created: 2, badReceiveKey: true)
        let plan = try F.plan(devices: w.devices, selfDeviceId: w.me.id, removedDeviceId: w.removed.id, oldUmk: w.oldUmk,
                              accountName: user, strict: false)
        XCTAssertFalse(plan.kept.contains { $0.deviceId == w.kept.id })
        XCTAssertEqual(plan.excluded.first { $0.device.deviceId == w.kept.id }?.reason, .noReceiveKey)
    }

    func testARotatorWithADerivedKeyCannotRotate() throws {
        let w = try world()
        XCTAssertThrowsError(try F.plan(devices: w.devices, selfDeviceId: w.derived.id, removedDeviceId: w.removed.id,
                                        oldUmk: w.oldUmk, accountName: user, strict: false)) { e in
            XCTAssertEqual(e as? F.PlanError, F.PlanError(code: "self-key-derived"))
        }
    }

    func testTheBodyVerifiesAndEveryKeptDeviceOpensItsKey() throws {
        let w = try world()
        let plan = try F.plan(devices: w.devices, selfDeviceId: w.me.id, removedDeviceId: w.removed.id, oldUmk: w.oldUmk,
                              accountName: user, strict: false)
        let newUmk = PqBin.random(32)
        let built = try build(w, plan: plan, newUmk: newUmk)
        let body = try wire(built.body)
        let r = try XCTUnwrap(F.parseRotation(body["rotation"]))
        XCTAssertEqual(r, built.rotation)
        XCTAssertEqual(r.removedDeviceIds, [w.removed.id])
        XCTAssertNil(r.recoveryRecordDigestHex)
        let oldIrk = try pub(A.irkSeed(umk: w.oldUmk, scheme: .ios))
        let rootHex = HexUtil.encode(w.root.publicKey.rawRepresentation)
        let s = try XCTUnwrap(body["signatures"] as? [String: String])
        XCTAssertNoThrow(try A.verify(r, signatures: .init(adminRootSignatureHex: s["adminRootSignatureHex"]!, newIrkSignatureHex: s["newIrkSignatureHex"]!,
                                                           newAidSignatureHex: s["newAidSignatureHex"]!),
                                      state: .init(username: user, epoch: 0, irkPubHex: oldIrk, aidPubHex: try pub(A.aidSeed(umk: w.oldUmk)), adminRootPubHex: rootHex)))
        // Deliveries: one per kept device but the rotator, X-Wing where a receive key exists.
        let deliveries = try XCTUnwrap(body["deliveries"] as? [[String: Any]])
        XCTAssertEqual(Set(deliveries.compactMap { ($0["delivery"] as? [String: Any])?["deviceId"] as? String }), [w.kept.id, w.keptEd.id])
        XCTAssertEqual(deliveries.first { (($0["delivery"] as? [String: Any])?["deviceId"] as? String) == w.kept.id }?["sealKind"] as? String, "xwing")
        XCTAssertEqual(deliveries.first { (($0["delivery"] as? [String: Any])?["deviceId"] as? String) == w.keptEd.id }?["sealKind"] as? String, "ed25519")
        // Grants: the two membership-signed kept devices, by the admin root, same scopes.
        let grants = try XCTUnwrap(body["grants"] as? [[String: Any]])
        XCTAssertEqual(Set(grants.compactMap { ($0["grant"] as? [String: Any])?["deviceId"] as? String }), [w.kept.id, w.keptEd.id])
        for g in grants {
            let o = try XCTUnwrap(g["grant"] as? [String: Any])
            let env = DeviceCapabilityGrantEnvelope(grantId: o["grantId"] as! String, username: user, deviceId: o["deviceId"] as! String,
                                                    devicePubKeyHex: o["devicePubKey"] as! String, scopes: o["scopes"] as! [String],
                                                    issuedAt: (o["issuedAt"] as! NSNumber).int64Value, expiresAt: (o["expiresAt"] as! NSNumber).int64Value)
            XCTAssertTrue(env.verify(signature: HexUtil.decode(g["signature"] as! String)!, irkPub: w.root.publicKey.rawRepresentation))
            XCTAssertEqual(g["signerRoot"] as? String, "admin-root")
        }
        // Profiles: the account name under the new key, a kept device's managed name, not the removed one's.
        let ap = try XCTUnwrap(body["accountProfile"] as? [String: Any])
        XCTAssertEqual((ap["revision"] as? NSNumber)?.int64Value, 4)
        let name = try AccountMetadata.decrypt(ciphertext: .init(nonceHex: ap["nonceHex"] as! String, ciphertextHex: ap["ciphertextHex"] as! String),
                                               keyBytes: AccountMetadata.deriveAccountProfileKey(umk: Data(newUmk)),
                                               coordinates: .init(accountId: user, recordType: .accountProfile, revision: 4, keyVersion: 1))
        XCTAssertEqual(name, "Family")
        XCTAssertEqual((body["managedProfiles"] as? [[String: Any]])?.map { $0["deviceId"] as? String }, [w.kept.id])

        // The kept tablet replays the lane from the root it pins and opens its key.
        let lane = [laneEvent(body)]
        let replay = try F.replay(lane: lane, username: user, pinnedAdminRootPubHex: rootHex, epoch: 0, irkPubHex: oldIrk)
        XCTAssertEqual(replay.epoch, 1)
        let opened = try F.open(deliveries: deliveries.map { $0.merging(["toEpoch": 1]) { a, _ in a } }, replay: replay,
                                selfDevice: .init(deviceId: w.kept.id, devicePubHex: w.kept.pubHex),
                                secret: { kind in XCTAssertEqual(kind, .xwing); return w.kept.xwingSeed! })
        XCTAssertEqual(opened.last?.plaintext.umk, newUmk)
        XCTAssertEqual(opened.last?.plaintext.irkScheme, .ios)
        // The classical seal opens with the device's own key.
        let ed = try F.open(deliveries: deliveries.map { $0.merging(["toEpoch": 1]) { a, _ in a } }, replay: replay,
                            selfDevice: .init(deviceId: w.keptEd.id, devicePubHex: w.keptEd.pubHex),
                            secret: { _ in Array(w.keptEd.key.rawRepresentation) })
        XCTAssertEqual(ed.last?.plaintext.umk, newUmk)
    }

    func testAKeptAdminGetsTheRotatedRootOnlyWhenItRotated() throws {
        var w = try world()
        w.devices[1] = try device(w.kept, name: "Tablet", scopes: DeviceCapabilityGrantEnvelope.deviceScopeOrder, signer: "admin-root", created: 2)
        let plan = try F.plan(devices: w.devices, selfDeviceId: w.me.id, removedDeviceId: w.removed.id, oldUmk: w.oldUmk,
                              accountName: user, strict: false)
        let newRoot = Curve25519.Signing.PrivateKey()
        let oldRootHex = HexUtil.encode(w.root.publicKey.rawRepresentation)
        let arr = AdminRootRotation(username: user, oldAdminRootPubHex: oldRootHex,
                                    newAdminRootPubHex: HexUtil.encode(newRoot.publicKey.rawRepresentation), issuedAt: 900)
        let arrSig = HexUtil.encode(try arr.sign(withOldAdminRoot: w.root))
        let newUmk = PqBin.random(32)
        let keys = F.Keys(oldUmk: w.oldUmk, newUmk: newUmk, scheme: .web, oldIrkPubHex: try pub(A.irkSeed(umk: w.oldUmk, scheme: .ios)),
                          oldAidPubHex: try pub(A.aidSeed(umk: w.oldUmk)), adminRoot: newRoot,
                          rotatedAdminRootSeed: Array(newRoot.rawRepresentation))
        let built = try F.build(username: user, fromEpoch: 0, plan: plan, keys: keys, now: 1_000)
        let body = try wire(built.body)
        let lane: [[String: Any]] = [
            ["kind": "admin-root-rotation", "seq": 1, "signatureHex": arrSig,
             "rotation": ["username": user, "oldAdminRootPubHex": oldRootHex, "newAdminRootPubHex": arr.newAdminRootPubHex, "issuedAt": 900]],
            laneEvent(body),
        ]
        let replay = try F.replay(lane: lane, username: user, pinnedAdminRootPubHex: oldRootHex, epoch: 0,
                                  irkPubHex: try pub(A.irkSeed(umk: w.oldUmk, scheme: .ios)))
        XCTAssertEqual(replay.adminRootPubHex, arr.newAdminRootPubHex)
        let deliveries = (body["deliveries"] as! [[String: Any]]).map { $0.merging(["toEpoch": 1]) { a, _ in a } }
        let opened = try F.open(deliveries: deliveries, replay: replay, selfDevice: .init(deviceId: w.kept.id, devicePubHex: w.kept.pubHex),
                                secret: { _ in w.kept.xwingSeed! })
        XCTAssertEqual(opened.last?.plaintext.adminRootSeed, Array(newRoot.rawRepresentation))
        XCTAssertEqual(opened.last?.plaintext.irkScheme, .web)
        // A member device in the same hop gets no root.
        let member = try F.open(deliveries: deliveries, replay: replay, selfDevice: .init(deviceId: w.keptEd.id, devicePubHex: w.keptEd.pubHex),
                                secret: { _ in Array(w.keptEd.key.rawRepresentation) })
        XCTAssertNil(member.last?.plaintext.adminRootSeed)
    }

    func testReplayRefusesAHopNotSignedByThePinnedRoot() throws {
        let w = try world()
        let plan = try F.plan(devices: w.devices, selfDeviceId: w.me.id, removedDeviceId: w.removed.id, oldUmk: w.oldUmk,
                              accountName: user, strict: false)
        let body = try wire(try build(w, plan: plan, newUmk: PqBin.random(32)).body)
        let oldIrk = try pub(A.irkSeed(umk: w.oldUmk, scheme: .ios))
        // Another root (e.g. one `.com` made up) is not the pin.
        XCTAssertThrowsError(try F.replay(lane: [laneEvent(body)], username: user, pinnedAdminRootPubHex: HexUtil.encode(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation),
                                          epoch: 0, irkPubHex: oldIrk)) { XCTAssertEqual(($0 as? A.Failure)?.code, "wrong-admin-root") }
        // A hop from an IRK this device does not hold.
        XCTAssertThrowsError(try F.replay(lane: [laneEvent(body)], username: user, pinnedAdminRootPubHex: HexUtil.encode(w.root.publicKey.rawRepresentation),
                                          epoch: 0, irkPubHex: try pub(PqBin.random(32)))) { XCTAssertEqual(($0 as? A.Failure)?.code, "wrong-old-irk") }
        // An admin-root rotation the pinned root did not sign never moves the pin.
        let fake = Curve25519.Signing.PrivateKey()
        let forged: [String: Any] = ["kind": "admin-root-rotation", "seq": 1, "signatureHex": String(repeating: "00", count: 64),
                                     "rotation": ["username": user, "oldAdminRootPubHex": HexUtil.encode(w.root.publicKey.rawRepresentation),
                                                  "newAdminRootPubHex": HexUtil.encode(fake.publicKey.rawRepresentation), "issuedAt": 1]]
        XCTAssertThrowsError(try F.replay(lane: [forged], username: user, pinnedAdminRootPubHex: HexUtil.encode(w.root.publicKey.rawRepresentation),
                                          epoch: 0, irkPubHex: oldIrk))
        // A hop already behind this device's epoch is skipped.
        let past = try F.replay(lane: [laneEvent(body)], username: user, pinnedAdminRootPubHex: HexUtil.encode(w.root.publicKey.rawRepresentation),
                                epoch: 1, irkPubHex: "")
        XCTAssertTrue(past.hops.isEmpty)
    }

    func testADeviceThatWasNotKeptCannotOpen() throws {
        let w = try world()
        let plan = try F.plan(devices: w.devices, selfDeviceId: w.me.id, removedDeviceId: w.removed.id, oldUmk: w.oldUmk,
                              accountName: user, strict: false)
        let body = try wire(try build(w, plan: plan, newUmk: PqBin.random(32)).body)
        let replay = try F.replay(lane: [laneEvent(body)], username: user, pinnedAdminRootPubHex: HexUtil.encode(w.root.publicKey.rawRepresentation),
                                  epoch: 0, irkPubHex: try pub(A.irkSeed(umk: w.oldUmk, scheme: .ios)))
        let deliveries = (body["deliveries"] as! [[String: Any]]).map { $0.merging(["toEpoch": 1]) { a, _ in a } }
        XCTAssertThrowsError(try F.open(deliveries: deliveries, replay: replay, selfDevice: .init(deviceId: w.derived.id, devicePubHex: w.derived.pubHex),
                                        secret: { _ in w.derived.xwingSeed! })) { XCTAssertEqual(($0 as? A.Failure)?.code, "not-kept") }
        // Someone else's delivery handed to the tablet does not open.
        let swapped = deliveries.filter { (($0["delivery"] as? [String: Any])?["deviceId"] as? String) == w.keptEd.id }
        XCTAssertThrowsError(try F.open(deliveries: swapped, replay: replay, selfDevice: .init(deviceId: w.kept.id, devicePubHex: w.kept.pubHex),
                                        secret: { _ in w.kept.xwingSeed! }))
    }

    func testPendingDecisions() {
        XCTAssertEqual(F.decidePending(comIrkPubHex: "AA", pendingNewIrkPubHex: "aa", pendingOldIrkPubHex: "bb", issuedAt: 0, now: 99_999_999), .promote)
        XCTAssertEqual(F.decidePending(comIrkPubHex: "bb", pendingNewIrkPubHex: "aa", pendingOldIrkPubHex: "bb", issuedAt: 0, now: 60_000), .retry)
        XCTAssertEqual(F.decidePending(comIrkPubHex: "bb", pendingNewIrkPubHex: "aa", pendingOldIrkPubHex: "bb", issuedAt: 0, now: F.pendingFreshMs), .drop)
        XCTAssertEqual(F.decidePending(comIrkPubHex: "cc", pendingNewIrkPubHex: "aa", pendingOldIrkPubHex: "bb", issuedAt: 0, now: 1), .drop)
    }

    func testProgressCountsSelfProfilesAndServersOnTheNewEpoch() {
        let p = F.progress(kept: ["a", "b", "c"], selfProfileDeviceIds: ["a", "c", "x"],
                           servers: [("home", 2), ("cabin", 1), ("lab", nil)], keyEpoch: 2)
        XCTAssertEqual(p, F.Progress(devicesUpdated: 2, devicesTotal: 3, serversOnNewKey: 1, serversTotal: 3, waitingFor: ["cabin", "lab"]))
        XCTAssertFalse(p.isComplete)
        XCTAssertTrue(F.progress(kept: ["a"], selfProfileDeviceIds: ["a"], servers: [("home", 1)], keyEpoch: 1).isComplete)
    }
}
