import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipUI
@testable import FlagshipCore
@testable import Flagship

/// The iOS client of an account key rotation (docs/account-key-rotation.md) against a scripted `.com`: the
/// rotator's view model, a kept device taking its key, the pending slot, the receive key, the move off a
/// derived device key and Wipe & restart's admin signature. Keystore runs on its in-memory test store.
@MainActor
final class AccountKeyRotationClientTests: XCTestCase {
    let user = "alice"

    /// A tiny `.com`: answers the rotation routes and remembers what it was sent.
    final class FakeCom: @unchecked Sendable {
        let lock = NSLock()
        var irkPub: String
        var adminRootPub: String
        var keyEpoch: Int64 = 0
        var rotationStatus = 200
        var posts: [(String, [String: Any])] = []
        var umkRotation: [String: Any] = ["deliveries": [], "lane": []]
        init(irkPub: String, adminRootPub: String) { self.irkPub = irkPub; self.adminRootPub = adminRootPub }

        func handle(_ method: String, _ path: String, _ body: Data?) -> (Int, Data) {
            lock.lock(); defer { lock.unlock() }
            let o = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            if method != "GET" { posts.append((method + " " + path, o)) }
            func json(_ v: Any) -> Data { (try? JSONSerialization.data(withJSONObject: v)) ?? Data() }
            switch (method, path) {
            case ("GET", let p) where p.hasPrefix("/api/username/"):
                return (200, json(["irkPub": irkPub, "adminRootPub": adminRootPub, "keyEpoch": keyEpoch]))
            case ("POST", let p) where p.hasSuffix("/account-key-rotation"):
                guard rotationStatus == 200 else { return (rotationStatus, json(["error": "x", "code": "rotation-conflict"])) }
                if let r = o["rotation"] as? [String: Any] {
                    irkPub = r["newIrkPubHex"] as! String
                    keyEpoch = (r["toEpoch"] as! NSNumber).int64Value
                    adminRootPub = r["adminRootPubHex"] as! String
                }
                return (200, json(["ok": true, "applied": true, "keyEpoch": keyEpoch]))
            case ("GET", let p) where p.hasSuffix("/umk-rotation"):
                return (200, json(umkRotation))
            default:
                return (200, json(["ok": true]))
            }
        }
        func post(_ suffix: String) -> [String: Any]? { lock.lock(); defer { lock.unlock() }; return posts.last { $0.0.hasSuffix(suffix) }?.1 }
    }

    override func setUp() async throws {
        Keystore.setActiveProfile(nil)
        Keystore.wipe()
    }

    override func tearDown() async throws {
        Keystore.wipe()
        Keystore.clearSessionKeyCache()
    }

    func irkNow() async throws -> Curve25519.Signing.PrivateKey { try await Keystore.deriveIRK(reason: "test") }

    func randomId() -> String { HexUtil.encode(Data((0..<16).map { _ in UInt8.random(in: 0...255) })) }
    func pub(_ k: Curve25519.Signing.PrivateKey) -> String { HexUtil.encode(k.publicKey.rawRepresentation) }

    func device(_ id: String, _ key: Curve25519.Signing.PrivateKey, platform: String = "ios") -> AccountDirectoryDevice {
        let o: [String: Any] = ["accountId": user, "deviceId": id, "devicePubHex": pub(key), "platformClass": platform,
                                "createdAt": 1, "lastSeenAt": 1, "supportCode": "AAAA-BBBB"]
        return try! JSONDecoder().decode(AccountDirectoryDevice.self, from: JSONSerialization.data(withJSONObject: o))
    }

    func grant(_ id: String, _ key: Curve25519.Signing.PrivateKey, scopes: [String], signer: String) -> AccountDirectoryGrant {
        let o: [String: Any] = ["grantId": UUID().uuidString.lowercased(), "username": user, "deviceId": id, "devicePubHex": pub(key),
                                "scopesJson": String(data: try! JSONSerialization.data(withJSONObject: scopes), encoding: .utf8)!,
                                "issuedAt": 1, "expiresAt": 9_999_999_999_999, "signatureHex": String(repeating: "0", count: 128),
                                "signerRoot": signer]
        return try! JSONDecoder().decode(AccountDirectoryGrant.self, from: JSONSerialization.data(withJSONObject: o))
    }

    struct Setup {
        let server: MockFlagshipServerClient
        let com: FakeCom
        let selfId: String
        let removedId: String
        let derivedId: String
        let tabletId: String
        let tabletSeed: [UInt8]
        let tabletKey: Curve25519.Signing.PrivateKey
        let oldUmk: Data
    }

    /// This device: an admin with a random device key; a tablet with a receive key; a laptop whose key came
    /// from the account key; the phone being removed.
    func setupRotator() async throws -> Setup {
        try await Keystore.generateUMK(reason: "test")
        try await Keystore.generateAdminRoot(reason: "test")
        let umk = try await Keystore.currentUMK(reason: "test").withUnsafeBytes { Data($0) }
        let irk = try await Keystore.deriveIRK(reason: "test")
        let me = randomId(), tablet = randomId(), laptop = randomId(), lost = randomId()
        let meKey = Curve25519.Signing.PrivateKey()
        try Keystore.storeAccountDeviceSigningKey(meKey, accountId: user, deviceId: me)
        let tabletKey = Curve25519.Signing.PrivateKey()
        let laptopKey = try AccountMetadata.deriveAccountDeviceKey(umk: umk, accountId: user, deviceId: laptop)
        let lostKey = Curve25519.Signing.PrivateKey()
        let seed = PqHybrid.randomSeed()
        let xpk = HexUtil.encode(Data(try PqHybrid.hybridSealKeygen(seed: seed).publicKey))
        let rkSig = HexUtil.encode(try tabletKey.signature(for: Data(try AccountKeyRotation.canonicalDeviceReceiveKey(
            username: user, deviceId: tablet, devicePubHex: pub(tabletKey), xwingPubHex: xpk, issuedAt: 7))))
        let all = DeviceCapabilityGrantEnvelope.deviceScopeOrder, member = DeviceCapabilityGrantEnvelope.memberScopes
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.accountDirectories[user] = AccountDirectoryResponse(
            accountId: user, accountProfile: nil,
            devices: [device(me, meKey), device(tablet, tabletKey), device(laptop, laptopKey, platform: "web"), device(lost, lostKey)],
            grants: [grant(me, meKey, scopes: all, signer: "admin-root"), grant(tablet, tabletKey, scopes: member, signer: "membership"),
                     grant(laptop, laptopKey, scopes: member, signer: "membership"), grant(lost, lostKey, scopes: all, signer: "admin-root")],
            selfProfiles: [], managedProfiles: [],
            receiveKeys: [DeviceReceiveKeyRecord(deviceId: tablet, devicePubHex: pub(tabletKey), xwingPubHex: xpk, issuedAt: 7, signatureHex: rkSig)])
        let com = FakeCom(irkPub: pub(irk), adminRootPub: Keystore.adminRootPubHex()!)
        server.accountKeyHandler = { m, p, b in com.handle(m, p, b) }
        return Setup(server: server, com: com, selfId: me, removedId: lost, derivedId: laptop, tabletId: tablet, tabletSeed: seed,
                     tabletKey: tabletKey, oldUmk: umk)
    }

    func vm(_ s: Setup, servers: [RotateAccountKeyViewModel.Server] = [.init(name: "home", fqdn: "home.alice.flagship.services")],
            status: AccountKeyBoxStatus? = .init(trustedEpoch: 0, hintedEpoch: 0, holdingOwnerKey: false, rekeyDue: [], lastError: nil,
                                                 capability: AccountKeyBoxStatus.capabilityV1)) -> RotateAccountKeyViewModel {
        RotateAccountKeyViewModel(server: s.server, username: user, deviceId: s.selfId, removedDeviceId: s.removedId, removedName: "Lost phone",
                                  servers: servers, deps: .live(server: s.server, statusOf: { _ in status }, selfName: { "Mine" }))
    }

    func testTheRotatorChangesTheKeyAndKeepsTheOldOneRetired() async throws {
        let s = try await setupRotator()
        let model = vm(s)
        await model.prepare()
        XCTAssertEqual(model.phase, .ready)
        let summary = try XCTUnwrap(model.summary)
        XCTAssertTrue(summary.adminKeyChangesFirst, "the removed phone carried the admin scope")
        XCTAssertEqual(summary.excluded.map(\.deviceId), [s.derivedId])
        XCTAssertEqual(summary.keptCount, 2)

        await model.rotate()
        XCTAssertEqual(model.phase, .done(setUpRecovery: false))
        let body = try XCTUnwrap(s.com.post("/account-key-rotation"))
        let r = try XCTUnwrap(AccountKeyRotationFlow.parseRotation(body["rotation"]))
        XCTAssertEqual(r.removedDeviceIds, [s.removedId])
        XCTAssertNotNil(body["adminRootRotation"], "the admin root rotates in the same request")
        XCTAssertEqual((body["deliveries"] as? [[String: Any]])?.count, 1)
        // This device now holds the new key: its IRK is the hop's, the new admin root is sealed, epoch 1.
        let irk = try await Keystore.deriveIRK(reason: "test")
        XCTAssertEqual(pub(irk), r.newIrkPubHex)
        XCTAssertEqual(Keystore.adminRootPubHex(), r.adminRootPubHex)
        XCTAssertEqual(Keystore.accountKeyEpoch(), 1)
        XCTAssertNil(Keystore.pendingAccountKey())
        XCTAssertEqual(Keystore.retiredUmks().map(\.epoch), [0])
        let retired = try await Keystore.retiredUmk(epoch: 0, reason: "test")
        XCTAssertEqual(retired.map { Data($0) }, s.oldUmk)
        XCTAssertEqual(Keystore.accountKeyProgress?.keptDeviceIds.sorted(), [s.selfId, s.tabletId].sorted())
    }

    func testNotOfferedWhileAServerCannotFollow() async throws {
        let s = try await setupRotator()
        let model = vm(s, status: nil)
        await model.prepare()
        XCTAssertEqual(model.phase, .unavailable(RotateAccountKeyViewModel.updateServerLine("home")))
    }

    func testALostRaceDropsThePendingKeyAndChangesNothing() async throws {
        let s = try await setupRotator()
        s.com.rotationStatus = 409
        let model = vm(s)
        await model.prepare()
        let before = try await Keystore.deriveIRK(reason: "test")
        await model.rotate()
        XCTAssertEqual(model.phase, .failed(RotateAccountKeyViewModel.lostRaceLine))
        XCTAssertNil(Keystore.pendingAccountKey())
        let irkAfter = pub(try await irkNow())
        XCTAssertEqual(irkAfter, pub(before))
        XCTAssertEqual(Keystore.accountKeyEpoch(), 0)
    }

    func testAPendingKeyIsPromotedOnResumeWhenComHoldsIt() async throws {
        let s = try await setupRotator()
        let newUmk = PqBin.random(32)
        let newIrk = try IrkLineage.key(umk: SymmetricKey(data: Data(newUmk)), scheme: .ios, version: 1)
        try Keystore.savePendingAccountKey(username: user, toEpoch: 1, oldIrkPubHex: s.com.irkPub, newIrkPubHex: newIrk.pubHex, scheme: "ios",
                                           issuedAt: 0, body: Data("{}".utf8), newUmk: newUmk, newAdminRootSeed: nil,
                                           keptDeviceIds: [s.selfId], hadRecovery: true)
        // `.com` still on the old key and the request is stale: dropped.
        var decision = await AccountKeyRotationService.resumePending(server: s.server, username: user, deviceId: s.selfId, selfName: nil,
                                                                     now: AccountKeyRotationFlow.pendingFreshMs + 1)
        XCTAssertEqual(decision, .drop)
        XCTAssertNil(Keystore.pendingAccountKey())
        // Saved again, and `.com` holds the new key: promoted.
        try Keystore.savePendingAccountKey(username: user, toEpoch: 1, oldIrkPubHex: s.com.irkPub, newIrkPubHex: newIrk.pubHex, scheme: "ios",
                                           issuedAt: 0, body: Data("{}".utf8), newUmk: newUmk, newAdminRootSeed: nil,
                                           keptDeviceIds: [s.selfId], hadRecovery: true)
        s.com.irkPub = newIrk.pubHex
        s.com.keyEpoch = 1
        decision = await AccountKeyRotationService.resumePending(server: s.server, username: user, deviceId: s.selfId, selfName: nil)
        XCTAssertEqual(decision, .promote)
        let irkAfter = pub(try await irkNow())
        XCTAssertEqual(irkAfter, newIrk.pubHex)
        XCTAssertTrue(Keystore.accountKeyRecoveryOff, "the hop deleted cloud recovery")
        XCTAssertEqual(Keystore.accountKeyEpoch(), 1)
    }

    /// The other side: this device is the tablet; another admin device made the hop.
    func setupReceiver() async throws -> (server: MockFlagshipServerClient, com: FakeCom, me: String, built: AccountKeyRotationFlow.Built,
                                          newUmk: [UInt8], root: Curve25519.Signing.PrivateKey) {
        try await Keystore.generateUMK(reason: "test")
        let oldUmk = try await Keystore.currentUMK(reason: "test").withUnsafeBytes { [UInt8](Data($0)) }
        let irk = try await Keystore.deriveIRK(reason: "test")
        let me = randomId(), admin = randomId(), lost = randomId()
        let meKey = Curve25519.Signing.PrivateKey()
        try Keystore.storeAccountDeviceSigningKey(meKey, accountId: user, deviceId: me)
        let rk = try Keystore.loadOrCreateReceiveKey()
        let rkSig = HexUtil.encode(try meKey.signature(for: Data(try AccountKeyRotation.canonicalDeviceReceiveKey(
            username: user, deviceId: me, devicePubHex: pub(meKey), xwingPubHex: rk.xwingPubHex, issuedAt: 3))))
        let root = Curve25519.Signing.PrivateKey()
        let adminKey = Curve25519.Signing.PrivateKey()
        let devices: [AccountKeyRotationFlow.Device] = [
            .init(deviceId: admin, devicePubHex: pub(adminKey), displayName: "Admin", platformClass: "android", createdAt: 1,
                  scopes: DeviceCapabilityGrantEnvelope.deviceScopeOrder, grantSignerRoot: "admin-root", receiveKey: nil),
            .init(deviceId: me, devicePubHex: pub(meKey), displayName: "Me", platformClass: "ios", createdAt: 2,
                  scopes: DeviceCapabilityGrantEnvelope.memberScopes, grantSignerRoot: "membership",
                  receiveKey: .init(deviceId: me, devicePubHex: pub(meKey), xwingPubHex: rk.xwingPubHex, issuedAt: 3, signatureHex: rkSig)),
            .init(deviceId: lost, devicePubHex: pub(Curve25519.Signing.PrivateKey()), displayName: "Lost", platformClass: "ios", createdAt: 3,
                  scopes: DeviceCapabilityGrantEnvelope.memberScopes, grantSignerRoot: "membership", receiveKey: nil),
        ]
        let plan = try AccountKeyRotationFlow.plan(devices: devices, selfDeviceId: admin, removedDeviceId: lost, oldUmk: oldUmk,
                                                   accountName: user, strict: false)
        let newUmk = PqBin.random(32)
        let oldAid = pub(try Curve25519.Signing.PrivateKey(rawRepresentation: Data(AccountKeyRotation.aidSeed(umk: oldUmk))))
        let built = try AccountKeyRotationFlow.build(
            username: user, fromEpoch: 0, plan: plan,
            keys: .init(oldUmk: oldUmk, newUmk: newUmk, scheme: .android, oldIrkPubHex: pub(irk), oldAidPubHex: oldAid, adminRoot: root),
            now: Int64(Date().timeIntervalSince1970 * 1000))
        let wire = try JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: built.body)) as! [String: Any]
        let com = FakeCom(irkPub: built.newIrkPubHex, adminRootPub: pub(root))
        com.keyEpoch = 1
        com.umkRotation = [
            "keyEpoch": 1,
            "deliveries": (wire["deliveries"] as! [[String: Any]]).map { $0.merging(["toEpoch": 1]) { a, _ in a } },
            "lane": [["kind": "account-key-rotation", "rotation": wire["rotation"]!, "signatures": wire["signatures"]!, "kept": wire["kept"]!]],
        ]
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.accountKeyHandler = { m, p, b in com.handle(m, p, b) }
        return (server, com, me, built, newUmk, root)
    }

    func testAKeptDeviceTakesItsNewKeyInTheRotatorsScheme() async throws {
        let t = try await setupReceiver()
        Keystore.setAccountKeyAdminRootPin(pub(t.root))
        let out = await AccountKeyRotationService.receive(server: t.server, username: user, deviceId: t.me, interactive: true, selfName: "Me")
        XCTAssertEqual(out, .installed(toEpoch: 1))
        // The account key now derives the hop's IRK in the rotator's (Android) scheme.
        let irkAfter = pub(try await irkNow())
        XCTAssertEqual(irkAfter, t.built.newIrkPubHex)
        XCTAssertEqual(Keystore.currentIrkScheme(), .android)
        XCTAssertEqual(Keystore.accountKeyEpoch(), 1)
        XCTAssertEqual(Keystore.retiredUmks().map(\.epoch), [0])
        XCTAssertEqual((t.com.post("/umk-rotation/ack")?["toEpoch"] as? NSNumber)?.int64Value, 1)
        // Nothing waits any more.
        let again = await AccountKeyRotationService.receive(server: t.server, username: user, deviceId: t.me, interactive: true, selfName: "Me")
        XCTAssertEqual(again, .upToDate)
    }

    func testAKeptDeviceRefusesAHopUnderAnotherAdminRoot() async throws {
        let t = try await setupReceiver()
        Keystore.setAccountKeyAdminRootPin(pub(Curve25519.Signing.PrivateKey()))
        let before = pub(try await Keystore.deriveIRK(reason: "test"))
        let out = await AccountKeyRotationService.receive(server: t.server, username: user, deviceId: t.me, interactive: true, selfName: "Me")
        XCTAssertEqual(out, .failed(AccountKeyRotationService.receiveFailedLine))
        let irkAfter = pub(try await irkNow())
        XCTAssertEqual(irkAfter, before)
        XCTAssertEqual(Keystore.accountKeyEpoch(), 0)
        XCTAssertNil(t.com.post("/umk-rotation/ack"))
    }

    func testWithoutTheUnlockItOnlySaysAKeyWaits() async throws {
        let t = try await setupReceiver()
        Keystore.setAccountKeyAdminRootPin(pub(t.root))
        Keystore.clearSessionKeyCache()
        let out = await AccountKeyRotationService.receive(server: t.server, username: user, deviceId: t.me, interactive: false, selfName: "Me")
        XCTAssertEqual(out, .waiting)
        XCTAssertEqual(Keystore.accountKeyEpoch(), 0)
    }

    func testTheReceiveKeyIsPublishedOncePerDeviceKey() async throws {
        try await Keystore.generateUMK(reason: "test")
        let id = randomId()
        let key = Curve25519.Signing.PrivateKey()
        try Keystore.storeAccountDeviceSigningKey(key, accountId: user, deviceId: id)
        let com = FakeCom(irkPub: "", adminRootPub: "")
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.accountKeyHandler = { m, p, b in com.handle(m, p, b) }
        let ok = await AccountKeyRotationService.publishReceiveKey(server: server, username: user, deviceId: id)
        XCTAssertTrue(ok)
        let body = try XCTUnwrap(com.post("/receive-key"))
        let rk = try XCTUnwrap(body["receiveKey"] as? [String: Any])
        XCTAssertTrue(AccountKeyRotation.verifyDeviceReceiveKey(
            username: user, deviceId: id, devicePubHex: pub(key), xwingPubHex: rk["xwingPubHex"] as! String,
            issuedAt: (rk["issuedAt"] as! NSNumber).int64Value, signatureHex: body["signatureHex"] as! String))
        _ = await AccountKeyRotationService.publishReceiveKey(server: server, username: user, deviceId: id)
        XCTAssertEqual(com.posts.filter { $0.0.hasSuffix("/receive-key") }.count, 1)
        // Its seed opens with the unlock and matches the published key.
        let seed = try await Keystore.receiveKeySeed(reason: "test")
        XCTAssertEqual(HexUtil.encode(Data(try PqHybrid.hybridSealKeygen(seed: seed).publicKey)), rk["xwingPubHex"] as? String)
    }

    func testAnAdminDeviceMovesOffADerivedDeviceKey() async throws {
        try await Keystore.generateUMK(reason: "test")
        let umk = try await Keystore.currentUMK(reason: "test").withUnsafeBytes { Data($0) }
        let root = Curve25519.Signing.PrivateKey()
        let id = randomId()
        let derived = try AccountMetadata.deriveAccountDeviceKey(umk: umk, accountId: user, deviceId: id)
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.accountDirectories[user] = AccountDirectoryResponse(
            accountId: user, accountProfile: nil, devices: [device(id, derived)],
            grants: [grant(id, derived, scopes: DeviceCapabilityGrantEnvelope.deviceScopeOrder, signer: "admin-root")],
            selfProfiles: [], managedProfiles: [])
        let com = FakeCom(irkPub: "", adminRootPub: pub(root))
        server.accountKeyHandler = { m, p, b in com.handle(m, p, b) }
        // Without the admin root it stays put.
        let none = await AccountKeyRotationService.migrateDerivedDeviceKey(server: server, username: user, deviceId: id, umk: umk, adminRoot: nil)
        XCTAssertEqual(none, .needsAdmin)
        let done = await AccountKeyRotationService.migrateDerivedDeviceKey(server: server, username: user, deviceId: id, umk: umk, adminRoot: root)
        XCTAssertEqual(done, .migrated)
        let body = try XCTUnwrap(com.post("/devices/\(id)/key"))
        let r = try XCTUnwrap(body["rotate"] as? [String: Any])
        let newPub = r["newDevicePubHex"] as! String
        XCTAssertTrue(AccountKeyRotation.verifyDeviceKeyRotate(
            username: user, deviceId: id, oldDevicePubHex: pub(derived), newDevicePubHex: newPub,
            issuedAt: (r["issuedAt"] as! NSNumber).int64Value, newKeySignatureHex: body["newKeySignatureHex"] as! String,
            adminRootSignatureHex: body["adminRootSignatureHex"] as! String, adminRootPubHex: pub(root)))
        XCTAssertEqual(((body["grant"] as? [String: Any])?["grant"] as? [String: Any])?["scopes"] as? [String], DeviceCapabilityGrantEnvelope.deviceScopeOrder)
        XCTAssertEqual(Keystore.storedAccountDeviceSigningKey(accountId: user, deviceId: id).map(pub), newPub)
        XCTAssertNil(Keystore.previousAccountDeviceKey)
        // Random now: nothing more to do.
        let again = await AccountKeyRotationService.migrateDerivedDeviceKey(server: server, username: user, deviceId: id, umk: umk, adminRoot: root)
        XCTAssertEqual(again, .notNeeded)
    }

    func testWipeAndRestartSendsTheAdminRootSignature() async throws {
        try await Keystore.generateUMK(reason: "test")
        let root = Curve25519.Signing.PrivateKey()
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.wipeRestartBehavior = .ok
        let model = WipeRestartViewModel(server: server, webAuthn: MockWebAuthnProvider(), username: { "alice" },
                                         hasAdminRoot: { true }, adminRoot: { _ in root })
        await model.run(currentEtag: nil)
        XCTAssertEqual(model.phase, .completed)
        let body = try XCTUnwrap(server.lastWipeRestart?.body)
        let sig = try XCTUnwrap(body.adminRootSignature.flatMap(HexUtil.decode))
        let canonical = WipeRestartClaim.canonicalBytes(
            username: "alice", oldIrkPubHex: body.request.oldIrkPub, newIrkPubHex: body.request.newIrkPub,
            newCredentialIdHex: body.request.newCredentialId,
            newWrappedUmkHashHex: HexUtil.encode(Data(SHA256.hash(data: Data(base64Encoded: body.request.newWrappedUmk)!))),
            issuedAt: body.request.issuedAt)
        XCTAssertTrue(root.publicKey.isValidSignature(sig, for: canonical))
    }

    func testRemoveDialogAsksWhetherSomeoneCouldUnlockIt() {
        let browser = SettingsViewModel.DirectoryDevice(deviceId: randomId(), displayName: "Laptop", platformClass: "web", supportCode: "A",
                                                        createdAt: 1, lastSeenAt: 1, isCurrent: false, isAdministrator: false,
                                                        isRestricted: false, isManaged: false, isLocked: false)
        XCTAssertEqual(RemoveDeviceCopy.message(for: browser, canChangeKey: false), RemoveDeviceCopy.message)
        let asked = RemoveDeviceCopy.message(for: browser, canChangeKey: true)
        XCTAssertTrue(asked.contains(RemoveDeviceCopy.question))
        XCTAssertTrue(asked.contains(RemoveDeviceCopy.browserLine))
    }
}
