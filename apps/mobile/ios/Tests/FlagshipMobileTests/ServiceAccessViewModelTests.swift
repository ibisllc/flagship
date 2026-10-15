import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class ServiceAccessViewModelTests: XCTestCase {
    private let server = "home.alice.flagship.services"
    private let serviceRef = "alice--notes"
    private let username = "alice"
    private let control = URL(string: "https://flagshipserver.com")!

    private func irk() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
    }
    /// The author's stable AID — the v2 create/revoke/list signer.
    private func aid() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 5, count: 32))
    }
    private let household = Data(repeating: 0x33, count: 32)
    private func adminRoot() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x0a, count: 32))
    }
    private let ownDevice = String(repeating: "d0", count: 16)
    private let otherDevice = String(repeating: "1a", count: 16)

    /// Counts how often each signer is asked for (each one is a Face ID in production).
    private final class Prompts { var admin = 0; var aid = 0 }

    private func makeVM(
        _ mock: MockServiceAccessClient,
        isAdmin: Bool = false,
        prompts: Prompts = Prompts(),
        names: [String: String]? = nil,
        now: @escaping () -> Int64 = { 1700 }
    ) -> ServiceAccessViewModel {
        let k = irk(); let a = aid(); let hh = household; let root = adminRoot()
        return ServiceAccessViewModel(
            client: mock, serverDomain: server, serviceRef: serviceRef, username: username, controlBase: control,
            authorAidKeys: { _ in prompts.aid += 1; return (a, hh) },
            irkSigner: { _ in k },
            isAdminDevice: isAdmin,
            adminSigner: { _ in prompts.admin += 1; return root },
            deviceId: ownDevice.uppercased(),
            deviceNames: { names },
            now: now
        )
    }

    private func row(_ id: String, _ name: String, tier: String? = nil, device: String? = nil,
                     bound: String? = nil) -> ServiceInviteRow {
        let sealed = try! ServiceInvite.sealBundle(.init(name: name, photo: nil), householdKey: household, inviteId: id)
        return ServiceInviteRow(inviteId: id, serviceRef: serviceRef, encryptedBundleHex: sealed,
                                boundAidHex: bound, boundAt: bound == nil ? nil : 1, createdAt: 1, revokedAt: nil,
                                creatorTier: tier, creatorDeviceId: device)
    }

    private func createBytes(_ call: MockServiceAccessClient.CreateCall) -> Data {
        try! ServiceInvite.canonicalCreate(
            inviteId: call.request["inviteId"]!, authorAID: aid().publicKey.rawRepresentation, serviceRef: serviceRef,
            secretHash: call.request["secretHash"]!, encryptedBundle: call.request["encryptedBundle"]!, issuedAt: 1700)
    }

    // ─── Who can invite (owner decision 2026-10-15) ──────────────────────────

    func testAdminDeviceSignsCreateWithAdminRootUnderOnePromptAndSendsDeviceId() async {
        let mock = MockServiceAccessClient()
        let prompts = Prompts()
        let vm = makeVM(mock, isAdmin: true, prompts: prompts)
        let link = await vm.addPerson(name: "Alex", photo: nil)
        XCTAssertNotNil(link)
        XCTAssertEqual(prompts.admin, 1, "the admin root is asked for once")
        let call = mock.createCalls[0]
        XCTAssertEqual(call.request["deviceId"], ownDevice, "the account device id rides the create, lowercase")
        XCTAssertEqual(call.request["authorAID"], HexUtil.encode(aid().publicKey.rawRepresentation))
        let sig = Data(HexUtil.decode(call.signatureHex)!)
        XCTAssertTrue(adminRoot().publicKey.isValidSignature(sig, for: createBytes(call)), "an admin device signs with the admin root")
        XCTAssertFalse(aid().publicKey.isValidSignature(sig, for: createBytes(call)))
    }

    func testNonAdminDeviceSignsCreateWithAidAndNeverAsksForTheAdminRoot() async {
        let mock = MockServiceAccessClient()
        let prompts = Prompts()
        let vm = makeVM(mock, isAdmin: false, prompts: prompts)
        let link = await vm.addPerson(name: "Alex", photo: nil, role: .master)
        XCTAssertNotNil(link)
        XCTAssertEqual(prompts.admin, 0)
        let call = mock.createCalls[0]
        XCTAssertEqual(call.request["deviceId"], ownDevice)
        let sig = Data(HexUtil.decode(call.signatureHex)!)
        XCTAssertTrue(aid().publicKey.isValidSignature(sig, for: createBytes(call)), "a non-admin device signs with the AID")
        XCTAssertFalse(adminRoot().publicKey.isValidSignature(sig, for: createBytes(call)))
        XCTAssertFalse(vm.canChangeRanks)
    }

    func testCreateWithoutAnAccountDeviceIdSendsNone() async {
        let mock = MockServiceAccessClient()
        let a = aid(); let hh = household
        let vm = ServiceAccessViewModel(
            client: mock, serverDomain: server, serviceRef: serviceRef, username: username, controlBase: control,
            authorAidKeys: { _ in (a, hh) }, irkSigner: { [k = irk()] _ in k }, isAdminDevice: false, now: { 1700 })
        _ = await vm.addPerson(name: "Alex", photo: nil)
        XCTAssertNil(mock.createCalls[0].request["deviceId"])
    }

    func testListCarriesWhoInvitedEachRow() async {
        let mock = MockServiceAccessClient()
        let a = "aa" + String(repeating: "0", count: 62)
        let b = "bb" + String(repeating: "0", count: 62)
        mock.rows = [row(a, "Sam", tier: "member", device: ownDevice), row(b, "Old")]
        let vm = makeVM(mock)
        await vm.load()
        let sam = vm.people.first { $0.inviteId == a }
        XCTAssertEqual(sam?.creatorTier, "member")
        XCTAssertEqual(sam?.creatorDeviceId, ownDevice)
        let old = vm.people.first { $0.inviteId == b }
        XCTAssertNil(old?.creatorTier)
        XCTAssertNil(old?.creatorDeviceId)
    }

    func testInvitedByResolvesNamesAndFallsBack() async {
        let mock = MockServiceAccessClient()
        let ids = ["a1", "a2", "a3", "a4", "a5"].map { $0 + String(repeating: "0", count: 62) }
        let unknown = String(repeating: "2b", count: 16)
        mock.rows = [
            row(ids[0], "Sam", tier: "member", device: ownDevice),
            row(ids[1], "Priya", tier: "admin", device: otherDevice),
            row(ids[2], "Family", tier: "admin", device: unknown),
            row(ids[3], "Old"),
            row(ids[4], "Tier only", tier: "admin"),
        ]
        let vm = makeVM(mock, names: [otherDevice: "Harry's iPad"])
        await vm.load()
        func by(_ id: String) -> String? { vm.invitedBy(for: vm.people.first { $0.inviteId == id }!) }
        XCTAssertEqual(by(ids[0]), "Invited by this device")
        XCTAssertEqual(by(ids[1]), "Invited by Harry's iPad")
        XCTAssertEqual(by(ids[2]), "Invited by another device")
        XCTAssertNil(by(ids[3]), "old rows show nothing")
        XCTAssertEqual(by(ids[4]), "Invited by another device")
    }

    func testInvitedByWithoutDirectoryAccessFallsBack() {
        XCTAssertEqual(ServiceAccessViewModel.invitedByText(creatorTier: "member", creatorDeviceId: otherDevice,
                                                            ownDeviceId: ownDevice, names: nil),
                       "Invited by another device")
        XCTAssertEqual(ServiceAccessViewModel.invitedByText(creatorTier: "member", creatorDeviceId: ownDevice.uppercased(),
                                                            ownDeviceId: ownDevice, names: nil),
                       "Invited by this device")
        XCTAssertNil(ServiceAccessViewModel.invitedByText(creatorTier: nil, creatorDeviceId: nil,
                                                          ownDeviceId: ownDevice, names: [:]))
        XCTAssertEqual(ServiceAccessViewModel.memberOnlyReason, "Only an admin device can give a higher rank")
    }

    func testNonAdminMayRemoveOnlyItsOwnMemberInvites() async {
        let mock = MockServiceAccessClient()
        let mine = "a1" + String(repeating: "0", count: 62)
        let adminOne = "a2" + String(repeating: "0", count: 62)
        let othersMember = "a3" + String(repeating: "0", count: 62)
        let old = "a4" + String(repeating: "0", count: 62)
        mock.rows = [
            row(mine, "Sam", tier: "member", device: ownDevice),
            row(adminOne, "Priya", tier: "admin", device: ownDevice),
            row(othersMember, "Kai", tier: "member", device: otherDevice),
            row(old, "Old"),
        ]
        let prompts = Prompts()
        let vm = makeVM(mock, isAdmin: false, prompts: prompts)
        await vm.load()
        let person = { (id: String) in vm.people.first { $0.inviteId == id }! }
        XCTAssertTrue(vm.canRemove(person(mine)))
        XCTAssertFalse(vm.canRemove(person(adminOne)))
        XCTAssertFalse(vm.canRemove(person(othersMember)))
        XCTAssertFalse(vm.canRemove(person(old)))

        await vm.remove(inviteId: othersMember)
        XCTAssertTrue(mock.revokeCalls.isEmpty, "never revokes another device's invite")

        await vm.remove(inviteId: mine)
        XCTAssertEqual(mock.revokeCalls.map(\.inviteId), [mine])
        XCTAssertEqual(prompts.admin, 0)
    }

    func testAdminMayRemoveAnyRowAndSignsTheRevokeWithTheAdminRoot() async {
        let mock = MockServiceAccessClient()
        let theirs = "a3" + String(repeating: "0", count: 62)
        mock.rows = [row(theirs, "Kai", tier: "member", device: otherDevice)]
        let prompts = Prompts()
        let vm = makeVM(mock, isAdmin: true, prompts: prompts)
        await vm.load()
        XCTAssertTrue(vm.canRemove(vm.people[0]))
        XCTAssertTrue(vm.canChangeRanks)
        await vm.remove(inviteId: theirs)
        XCTAssertEqual(mock.revokeCalls.map(\.inviteId), [theirs])
        XCTAssertEqual(prompts.admin, 1)
    }

    func testLiveClientReadsCreatorFieldsAndSendsDeviceId() async throws {
        let device = ownDevice
        final class Sent: @unchecked Sendable { var body: [String: Any]? }
        let sent = Sent()
        StubURLProtocol.handler = { req in
            if req.httpMethod == "POST", let stream = req.httpBodyStream {
                stream.open(); defer { stream.close() }
                var data = Data(); var buf = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let n = stream.read(&buf, maxLength: buf.count); if n <= 0 { break }; data.append(buf, count: n) }
                sent.body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                return (HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                        Data(#"{"created":true,"inviteId":"i1","tier":"member"}"#.utf8))
            }
            let body = #"{"invites":[{"inviteId":"i1","serviceRef":"alice--notes","encryptedBundle":"00","creatorTier":"member","creatorDeviceId":"\#(device)"},{"inviteId":"i2","serviceRef":"alice--notes","encryptedBundle":"00","creatorTier":null,"creatorDeviceId":null}]}"#
            return (HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
        }
        defer { StubURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: config)
        let client = LiveServiceAccessClient(boxSession: session, comSession: session)

        let rows = try await client.listInvites(controlBase: control, username: username, query: [:], signatureHex: "00")
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].creatorTier, "member")
        XCTAssertEqual(rows[0].creatorDeviceId, device)
        XCTAssertNil(rows[1].creatorTier)
        XCTAssertNil(rows[1].creatorDeviceId)

        try await client.createInvite(controlBase: control, username: username,
                                      request: ["inviteId": "i1", "deviceId": device], signatureHex: "00")
        let request = try XCTUnwrap(sent.body?["request"] as? [String: Any])
        XCTAssertEqual(request["deviceId"] as? String, device)
    }

    func testRevokeSignerMatchesTheDevice() async throws {
        let id = "a1" + String(repeating: "0", count: 62)
        let bytes = try ServiceInvite.canonicalRevoke(inviteId: id, issuedAt: 1700)
        for admin in [true, false] {
            let mock = MockServiceAccessClient()
            mock.rows = [row(id, "Sam", tier: "member", device: ownDevice)]
            let vm = makeVM(mock, isAdmin: admin)
            await vm.load()
            await vm.remove(inviteId: id)
            let sig = try XCTUnwrap(mock.revokeCalls.first.flatMap { HexUtil.decode($0.signatureHex) })
            let signer = admin ? adminRoot().publicKey : aid().publicKey
            XCTAssertTrue(signer.isValidSignature(sig, for: bytes), admin ? "admin root signs the revoke" : "the AID signs its own revoke")
        }
    }

    func testLoadReadsTrueMode() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 3)
        let vm = makeVM(mock)
        await vm.load()
        XCTAssertEqual(vm.phase, .ready)
        XCTAssertTrue(vm.restricted)
        XCTAssertEqual(vm.allowCount, 3)
    }

    func testSetModeSignsValidEnvelopeUnderIrk() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, now: { 1700 })
        await vm.setMode(restricted: true)
        XCTAssertTrue(vm.restricted)
        XCTAssertEqual(mock.setModeCalls.count, 1)
        let call = mock.setModeCalls[0]
        XCTAssertEqual(call.request["mode"], "restricted")
        // The box mode toggle stays owner-IRK signed (the box pins the IRK).
        let bytes = try! ServiceInvite.canonicalSetAccessMode(serverId: server, serviceRef: serviceRef, mode: "restricted", issuedAt: 1700)
        let sig = Data(HexUtil.decode(call.signatureHex)!)
        XCTAssertTrue(irk().publicKey.isValidSignature(sig, for: bytes))
    }

    func testAddPersonAidSignsCreateAndReturnsV2Link() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, now: { 1700 })
        let link = await vm.addPerson(name: "Alex", photo: nil)
        XCTAssertNotNil(link)
        // Canonical v2 link: BARE leading secret (no k=) + the author AID, no
        // inviteId for an auto invite.
        XCTAssertNotNil(link!.range(of: "https://\(server)/invite#[0-9a-f]{64}&a=", options: .regularExpression))
        XCTAssertTrue(link!.contains("&a=\(HexUtil.encode(aid().publicKey.rawRepresentation))"))
        XCTAssertFalse(link!.contains("&i="), "auto invite link omits the inviteId")
        XCTAssertFalse(link!.contains("k="), "canonical link has a bare secret, no k= prefix")

        XCTAssertEqual(mock.createCalls.count, 1)
        let call = mock.createCalls[0]
        XCTAssertEqual(call.request["serviceRef"], serviceRef)
        XCTAssertEqual(call.request["authorAID"], HexUtil.encode(aid().publicKey.rawRepresentation))
        // No approvalMode / maxRedemptions for a personal-auto invite.
        XCTAssertNil(call.request["approvalMode"])
        XCTAssertNil(call.request["maxRedemptions"])
        // The create sig verifies under the AID (v2 switch from IRK) over the bytes.
        let inviteId = call.request["inviteId"]!
        let encBundle = call.request["encryptedBundle"]!
        let bytes = try! ServiceInvite.canonicalCreate(
            inviteId: inviteId, authorAID: aid().publicKey.rawRepresentation, serviceRef: serviceRef,
            secretHash: call.request["secretHash"]!, encryptedBundle: encBundle, issuedAt: 1700)
        let sig = Data(HexUtil.decode(call.signatureHex)!)
        XCTAssertTrue(aid().publicKey.isValidSignature(sig, for: bytes), "v2 create must be AID-signed")
        XCTAssertFalse(irk().publicKey.isValidSignature(sig, for: bytes), "v2 create must NOT be IRK-signed")
        // inviteId is a random 128-bit hex (NOT the structured devicePub form).
        XCTAssertEqual(inviteId.count, 64)
    }

    func testAddManualInviteSetsApprovalModeAndInviteIdInLink() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, now: { 1700 })
        let link = await vm.addPerson(name: "Sam", photo: nil, tier: .personalManual)
        XCTAssertNotNil(link)
        let call = mock.createCalls[0]
        XCTAssertEqual(call.request["approvalMode"], "manual")
        // The manual link carries the inviteId as the canonical `&i=` (the friend
        // needs it to sign the acceptance). No local create cache — the author's
        // box fetches the signed create from .com at finalize (any-device).
        let inviteId = call.request["inviteId"]!
        XCTAssertTrue(link!.contains("&i=\(inviteId)"))
    }

    func testAddGroupInviteSetsCapsAndExpiry() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, now: { 1700 })
        let link = await vm.addPerson(name: "Chess club", photo: nil, tier: .group(maxRedemptions: 10, expiresAt: 1_700_009_999_999))
        XCTAssertNotNil(link)
        let call = mock.createCalls[0]
        XCTAssertEqual(call.request["maxRedemptions"], "10")
        XCTAssertEqual(call.request["expiresAt"], "1700009999999")
        XCTAssertNil(call.request["approvalMode"], "group is auto-approve")
        // The create sig (with caps appended) verifies under the AID.
        let inviteId = call.request["inviteId"]!
        let bytes = try! ServiceInvite.canonicalCreate(
            inviteId: inviteId, authorAID: aid().publicKey.rawRepresentation, serviceRef: serviceRef,
            secretHash: call.request["secretHash"]!, encryptedBundle: call.request["encryptedBundle"]!,
            issuedAt: 1700, maxRedemptions: 10, expiresAt: 1_700_009_999_999)
        XCTAssertTrue(aid().publicKey.isValidSignature(Data(HexUtil.decode(call.signatureHex)!), for: bytes))
    }

    func testRefreshPeopleSignsListQueryUnderAid() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 1)
        let vm = makeVM(mock, now: { 1700 })
        await vm.load()
        XCTAssertGreaterThanOrEqual(mock.listCalls.count, 1)
        let call = mock.listCalls.last!
        XCTAssertEqual(call.query["authorAID"], HexUtil.encode(aid().publicKey.rawRepresentation))
        XCTAssertEqual(call.query["scope"], "list")
        XCTAssertEqual(call.query["cursor"], "0")
        // The list query is OWNER-SIGNED (v2 §C2) under the AID.
        let bytes = try! ServiceInvite.canonicalListQuery(
            username: username, authorAID: HexUtil.encode(aid().publicKey.rawRepresentation),
            scope: "list", cursor: 0, issuedAt: 1700)
        XCTAssertTrue(aid().publicKey.isValidSignature(Data(HexUtil.decode(call.signatureHex)!), for: bytes))
    }

    func testListPeopleDecryptsBundlesAndFiltersRevoked() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 1)
        let id1 = "aa" + String(repeating: "0", count: 62)
        let id2 = "bb" + String(repeating: "0", count: 62)
        let b1 = try! ServiceInvite.sealBundle(.init(name: "Alex", photo: nil), householdKey: household, inviteId: id1)
        let b2 = try! ServiceInvite.sealBundle(.init(name: "Sam", photo: nil), householdKey: household, inviteId: id2)
        mock.rows = [
            ServiceInviteRow(inviteId: id1, serviceRef: serviceRef, encryptedBundleHex: b1, boundAidHex: "ff", boundAt: 1, createdAt: 1, revokedAt: nil),
            ServiceInviteRow(inviteId: id2, serviceRef: serviceRef, encryptedBundleHex: b2, boundAidHex: nil, boundAt: nil, createdAt: 2, revokedAt: 99), // revoked → filtered
        ]
        let vm = makeVM(mock)
        await vm.load()
        XCTAssertEqual(vm.people.count, 1)
        XCTAssertEqual(vm.people[0].name, "Alex")
        XCTAssertTrue(vm.people[0].bound)
        XCTAssertFalse(vm.people[0].isGroup)
    }

    func testGroupRowSurfacesBoundSetAndCap() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 2)
        let id = "cc" + String(repeating: "0", count: 62)
        let sealed = try! ServiceInvite.sealBundle(.init(name: "Chess club", photo: nil), householdKey: household, inviteId: id)
        let m1 = "a1" + String(repeating: "0", count: 62)
        let m2 = "a2" + String(repeating: "0", count: 62)
        mock.rows = [
            ServiceInviteRow(
                inviteId: id, serviceRef: serviceRef, encryptedBundleHex: sealed,
                boundAidHex: nil, boundAt: nil, createdAt: 1, revokedAt: nil,
                boundAidsHex: [m1, m2], maxRedemptions: 10, expiresAt: nil, redemptions: 2, approvalMode: "auto"),
        ]
        let vm = makeVM(mock)
        await vm.load()
        XCTAssertEqual(vm.people.count, 1)
        let g = vm.people[0]
        XCTAssertTrue(g.isGroup)
        XCTAssertEqual(g.groupMax, 10)
        XCTAssertEqual(Set(g.groupBoundAIDs), Set([m1, m2]))
        XCTAssertTrue(g.bound)
    }

    func testRemoveUnredeemedInviteRevokesComOnlyUnderAid() async {
        // No people loaded ⇒ no bound AID ⇒ `.com` revoke only, NO box prune.
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, now: { 1700 })
        await vm.remove(inviteId: "deadbeef")
        XCTAssertEqual(mock.revokeCalls.count, 1)
        XCTAssertEqual(mock.revokeCalls[0].inviteId, "deadbeef")
        XCTAssertTrue(mock.removeAllowCalls.isEmpty, "no box prune for an unredeemed invite")
    }

    func testRemoveBoundFriendPrunesBoxAllowList() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 1)
        let id = "aa" + String(repeating: "0", count: 62)
        let friendAID = "a1f3c968acbff6ca2b8267282715e72559cc09bf1e25aecbfd316650a4012b6c"
        let sealed = try! ServiceInvite.sealBundle(.init(name: "Alex", photo: nil), householdKey: household, inviteId: id)
        mock.rows = [
            ServiceInviteRow(inviteId: id, serviceRef: serviceRef, encryptedBundleHex: sealed, boundAidHex: friendAID, boundAt: 1, createdAt: 1, revokedAt: nil),
        ]
        let vm = makeVM(mock, isAdmin: true, now: { 1700 })
        await vm.load()
        XCTAssertEqual(vm.people.count, 1)

        await vm.remove(inviteId: id)
        // The `.com` revoke is admin-root signed; the box prune is IRK-signed.
        XCTAssertEqual(mock.revokeCalls.count, 1)
        XCTAssertEqual(mock.removeAllowCalls.count, 1, "a redeemed friend must be pruned from the box")
        let call = mock.removeAllowCalls[0]
        XCTAssertEqual(call.request["aid"], friendAID)
        let bytes = try! ServiceInvite.canonicalRemoveServiceAllow(serverId: server, serviceRef: serviceRef, aid: friendAID, issuedAt: 1700)
        XCTAssertTrue(irk().publicKey.isValidSignature(Data(HexUtil.decode(call.signatureHex)!), for: bytes), "box prune must be owner-IRK signed")
    }

    func testRemoveGroupPrunesEveryBoundAid() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 3)
        let id = "cc" + String(repeating: "0", count: 62)
        let sealed = try! ServiceInvite.sealBundle(.init(name: "Chess club", photo: nil), householdKey: household, inviteId: id)
        let m1 = "a1" + String(repeating: "0", count: 62)
        let m2 = "a2" + String(repeating: "0", count: 62)
        let m3 = "a3" + String(repeating: "0", count: 62)
        mock.rows = [
            ServiceInviteRow(
                inviteId: id, serviceRef: serviceRef, encryptedBundleHex: sealed,
                boundAidHex: nil, boundAt: nil, createdAt: 1, revokedAt: nil,
                boundAidsHex: [m1, m2, m3], maxRedemptions: 10, expiresAt: nil, redemptions: 3, approvalMode: "auto"),
        ]
        let vm = makeVM(mock, isAdmin: true, now: { 1700 })
        await vm.load()
        await vm.remove(inviteId: id)
        // One `.com` revoke + a box prune for EVERY bound member.
        XCTAssertEqual(mock.revokeCalls.count, 1)
        XCTAssertEqual(mock.removeAllowCalls.count, 3, "group revoke prunes every member")
        XCTAssertEqual(Set(mock.removeAllowCalls.map { $0.request["aid"] }), Set([m1, m2, m3]))
    }

    func testRemoveBoxPruneFailureSurfaces() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 1)
        let id = "aa" + String(repeating: "0", count: 62)
        let sealed = try! ServiceInvite.sealBundle(.init(name: "Alex", photo: nil), householdKey: household, inviteId: id)
        mock.rows = [
            ServiceInviteRow(inviteId: id, serviceRef: serviceRef, encryptedBundleHex: sealed, boundAidHex: "a1f3c968acbff6ca2b8267282715e72559cc09bf1e25aecbfd316650a4012b6c", boundAt: 1, createdAt: 1, revokedAt: nil),
        ]
        let vm = makeVM(mock, isAdmin: true)
        await vm.load()
        mock.removeAllowError = ScreensClientError.http(status: 403, message: "bad sig")
        await vm.remove(inviteId: id)
        XCTAssertEqual(mock.revokeCalls.count, 1)
        XCTAssertEqual(mock.removeAllowCalls.count, 1, "the box prune was attempted")
        if case .failed = vm.phase {} else { XCTFail("a box-prune failure must surface") }
    }

    func testSetModeFailureSurfaces() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ScreensClientError.http(status: 403, message: "bad sig")
        let vm = makeVM(mock)
        await vm.setMode(restricted: true)
        if case .failed = vm.phase {} else { XCTFail("expected .failed") }
    }
}
