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

    /// The author's stable AID — the link's author key and the list signer.
    private func aid() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 5, count: 32))
    }
    private let household = Data(repeating: 0x33, count: 32)
    private func adminRoot() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x0a, count: 32))
    }
    /// This device's account device key.
    private func deviceKey() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0xd0, count: 32))
    }
    private var devicePubHex: String { HexUtil.encode(deviceKey().publicKey.rawRepresentation) }
    private let ownDevice = String(repeating: "d0", count: 16)
    private let otherDevice = String(repeating: "1a", count: 16)

    /// Counts how often each signer is asked for (each one is a Face ID in production).
    private final class Prompts { var admin = 0; var aid = 0; var device = 0 }

    /// A box that lists this device in Account members at `rank` (nil = an
    /// older box that lists no account members).
    private func box(isAdmin: Bool, rank: String?, refused: Bool = false,
                     members: [AppMember] = [], invites: [AppMemberInviteRole] = []) -> MockScreensClient {
        let s = MockScreensClient()
        let account: [AppAccountMember]? = rank == nil && !refused ? nil : [
            .device(id: ownDevice, pub: devicePubHex, admin: isAdmin, rank: refused ? nil : rank,
                    set: refused, refused: refused),
        ]
        s.mockMembers[serviceRef] = AppMembersResponse(
            serviceId: serviceRef, mode: "open", defaultRole: "member",
            accountMembers: account, members: members, invites: invites)
        return s
    }

    private func makeVM(
        _ mock: MockServiceAccessClient,
        isAdmin: Bool = false,
        rank: String? = "manager",
        screens: MockScreensClient? = nil,
        prompts: Prompts = Prompts(),
        names: [String: String]? = nil,
        deviceId: String? = nil,
        now: @escaping () -> Int64 = { 1700 }
    ) -> ServiceAccessViewModel {
        let a = aid(); let hh = household; let root = adminRoot(); let d = deviceKey()
        return ServiceAccessViewModel(
            client: mock, serverDomain: server, serviceRef: serviceRef, username: username, controlBase: control,
            authorAidKeys: { _ in prompts.aid += 1; return (a, hh) },
            screens: screens ?? box(isAdmin: isAdmin, rank: rank),
            isAdminDevice: isAdmin,
            adminSigner: { _ in prompts.admin += 1; return root },
            deviceId: deviceId ?? ownDevice.uppercased(),
            deviceSigner: { _ in prompts.device += 1; return d },
            ownDeviceKey: { d },
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

    private func createBytes(_ call: MockServiceAccessClient.CreateCall, maxRedemptions: Int? = nil,
                             expiresAt: Int64? = nil) -> Data {
        try! ServiceInvite.canonicalCreate(
            inviteId: call.request["inviteId"]!, authorAID: aid().publicKey.rawRepresentation, serviceRef: serviceRef,
            secretHash: call.request["secretHash"]!, encryptedBundle: call.request["encryptedBundle"]!, issuedAt: 1700,
            maxRedemptions: maxRedemptions, expiresAt: expiresAt)
    }

    private func sig(_ hex: String) -> Data { Data(HexUtil.decode(hex)!) }

    // ─── Who can invite ──────────────────────────────────────────────────────

    func testAdminDeviceSignsCreateWithAdminRootUnderOnePromptAndSendsDeviceId() async {
        let mock = MockServiceAccessClient()
        let prompts = Prompts()
        let vm = makeVM(mock, isAdmin: true, rank: "master", prompts: prompts)
        await vm.load()
        let link = await vm.addPerson(name: "Alex", photo: nil)
        XCTAssertNotNil(link)
        XCTAssertEqual(prompts.admin, 1, "the admin root is asked for once")
        XCTAssertEqual(prompts.device, 0)
        let call = mock.createCalls[0]
        XCTAssertEqual(call.request["deviceId"], ownDevice, "the account device id rides the create, lowercase")
        XCTAssertEqual(call.request["authorAID"], HexUtil.encode(aid().publicKey.rawRepresentation))
        XCTAssertTrue(adminRoot().publicKey.isValidSignature(sig(call.signatureHex), for: createBytes(call)),
                      "an admin device signs with the admin root")
    }

    func testManagerDeviceSignsCreateWithItsDeviceKeyAndNeverAsksForTheAdminRoot() async {
        let mock = MockServiceAccessClient()
        let prompts = Prompts()
        let vm = makeVM(mock, rank: "manager", prompts: prompts)
        await vm.load()
        XCTAssertEqual(vm.myRank, .manager)
        XCTAssertTrue(vm.canInvite)
        XCTAssertNil(vm.inviteBlockedReason)
        let link = await vm.addPerson(name: "Alex", photo: nil, role: .master)
        XCTAssertNotNil(link)
        XCTAssertEqual(prompts.admin, 0)
        let call = mock.createCalls[0]
        XCTAssertEqual(call.request["deviceId"], ownDevice)
        let s = sig(call.signatureHex)
        XCTAssertTrue(deviceKey().publicKey.isValidSignature(s, for: createBytes(call)),
                      "a non-admin device signs with its account device key")
        XCTAssertFalse(aid().publicKey.isValidSignature(s, for: createBytes(call)), "the AID no longer signs creates")
        XCTAssertFalse(vm.canChangeRanks)
    }

    func testMasterDeviceWithoutAdminRootInvitesToo() async {
        let vm = makeVM(MockServiceAccessClient(), rank: "master")
        await vm.load()
        XCTAssertTrue(vm.canInvite)
    }

    func testMemberRankOrRefusedDeviceCannotInviteAndSaysWhy() async {
        for (rank, refused) in [("member", false), ("member", true)] {
            let mock = MockServiceAccessClient()
            let vm = makeVM(mock, screens: box(isAdmin: false, rank: rank, refused: refused))
            await vm.load()
            XCTAssertFalse(vm.canInvite)
            XCTAssertEqual(vm.inviteBlockedReason, "Only an admin can let you invite people to this app.")
            let link = await vm.addPerson(name: "Alex", photo: nil)
            XCTAssertNil(link)
            XCTAssertTrue(mock.createCalls.isEmpty, "below Manager nothing is signed or sent")
        }
    }

    func testUnknownRankWaitsForTheBoxBeforeOfferingAdd() async {
        let vm = makeVM(MockServiceAccessClient(), rank: nil)
        XCTAssertFalse(vm.canInvite)
        XCTAssertNil(vm.inviteBlockedReason, "no why-line before the box answers")
    }

    func testThisDeviceIsFoundByItsDeviceKeyAndNamedOnThePhone() async {
        let s = MockScreensClient()
        s.mockMembers[serviceRef] = AppMembersResponse(
            serviceId: serviceRef, mode: "open", defaultRole: "member",
            accountMembers: [
                .device(id: otherDevice, pub: devicePubHex, admin: false, rank: "manager"),
                .device(id: ownDevice, pub: String(repeating: "ee", count: 32), admin: true, rank: "master"),
                .device(id: String(repeating: "2b", count: 16), pub: String(repeating: "2b", count: 32),
                        admin: false, rank: nil, set: true, refused: true),
                .coManager(shareId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", label: "  ", rank: "manager"),
            ],
            members: [], invites: [])
        let vm = makeVM(MockServiceAccessClient(), screens: s, names: [otherDevice: "Harry's iPad"])
        await vm.load()
        let rows = vm.members?.account ?? []
        XCTAssertEqual(vm.me?.deviceId, otherDevice, "the device key wins over the device id")
        XCTAssertTrue(vm.isThisDevice(rows[0]))
        XCTAssertFalse(vm.isThisDevice(rows[1]))
        XCTAssertEqual(vm.accountName(rows[0]), "Harry's iPad")
        XCTAssertEqual(vm.accountDetail(rows[0]), "Device · This device")
        XCTAssertEqual(vm.accountDetail(rows[1]), "Admin device")
        XCTAssertEqual(vm.accountName(rows[2]), "Device 2B2B2B")
        XCTAssertNil(rows[2].role)
        XCTAssertEqual(vm.accountName(rows[3]), "Shared account")
        XCTAssertEqual(vm.accountDetail(rows[3]), "Co-manages this server")
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

    func testNonAdminMayWithdrawOnlyItsOwnInvitesWithItsDeviceKey() async throws {
        let mock = MockServiceAccessClient()
        let mine = "a1" + String(repeating: "0", count: 62)
        let adminOne = "a2" + String(repeating: "0", count: 62)
        let othersMember = "a3" + String(repeating: "0", count: 62)
        let old = "a4" + String(repeating: "0", count: 62)
        let boxKnows = "a5" + String(repeating: "0", count: 62)
        let friend = String(repeating: "f1", count: 32)
        mock.rows = [
            row(mine, "Sam", tier: "member", device: ownDevice, bound: friend),
            row(adminOne, "Priya", tier: "admin", device: ownDevice),
            row(othersMember, "Kai", tier: "member", device: otherDevice),
            row(old, "Old"),
            row(boxKnows, "Lee"),
        ]
        let screens = box(isAdmin: false, rank: "manager", invites: [
            AppMemberInviteRole(inviteId: boxKnows, role: "member", set: false, tier: "member",
                                creatorPub: devicePubHex, creatorDeviceId: nil),
        ])
        let prompts = Prompts()
        let vm = makeVM(mock, screens: screens, prompts: prompts)
        await vm.load()
        let person = { (id: String) in vm.people.first { $0.inviteId == id }! }
        XCTAssertTrue(vm.canRemove(person(mine)))
        XCTAssertFalse(vm.canRemove(person(adminOne)))
        XCTAssertFalse(vm.canRemove(person(othersMember)))
        XCTAssertFalse(vm.canRemove(person(old)))
        XCTAssertTrue(vm.canRemove(person(boxKnows)), "the box's record of the creator key counts")

        await vm.remove(inviteId: othersMember)
        XCTAssertTrue(mock.revokeCalls.isEmpty, "never revokes another device's invite")

        await vm.remove(inviteId: mine)
        XCTAssertEqual(mock.revokeCalls.map(\.inviteId), [mine])
        XCTAssertEqual(prompts.admin, 0)
        let bytes = try ServiceInvite.canonicalRevoke(inviteId: mine, issuedAt: 1700)
        XCTAssertTrue(deviceKey().publicKey.isValidSignature(sig(mock.revokeCalls[0].signatureHex), for: bytes))
        XCTAssertEqual(mock.withdrawCalls.count, 1, "the box drops who joined through it at once")
        XCTAssertEqual(mock.withdrawCalls[0].revoke["inviteId"], mine)
        XCTAssertEqual(mock.withdrawCalls[0].signatureHex, mock.revokeCalls[0].signatureHex, "the same signed revoke")
        XCTAssertTrue(mock.removeAllowCalls.isEmpty, "removing people one by one is an admin's")
    }

    func testDemotedDeviceCanNoLongerWithdrawItsInvite() async {
        let mock = MockServiceAccessClient()
        let mine = "a1" + String(repeating: "0", count: 62)
        mock.rows = [row(mine, "Sam", tier: "member", device: ownDevice)]
        let vm = makeVM(mock, rank: "member")
        await vm.load()
        XCTAssertFalse(vm.canRemove(vm.people[0]))
        await vm.remove(inviteId: mine)
        XCTAssertTrue(mock.revokeCalls.isEmpty)
    }

    func testAdminMayRemoveAnyRowAndSignsTheRevokeWithTheAdminRoot() async {
        let mock = MockServiceAccessClient()
        let theirs = "a3" + String(repeating: "0", count: 62)
        mock.rows = [row(theirs, "Kai", tier: "member", device: otherDevice)]
        let prompts = Prompts()
        let vm = makeVM(mock, isAdmin: true, rank: "master", prompts: prompts)
        await vm.load()
        XCTAssertTrue(vm.canRemove(vm.people[0]))
        XCTAssertTrue(vm.canChangeRanks)
        await vm.remove(inviteId: theirs)
        XCTAssertEqual(mock.revokeCalls.map(\.inviteId), [theirs])
        XCTAssertEqual(prompts.admin, 1)
    }

    func testLiveClientReadsCreatorFieldsAndSendsDeviceId() async throws {
        let device = ownDevice
        final class Sent: @unchecked Sendable { var body: [String: Any]?; var path: String? }
        let sent = Sent()
        StubURLProtocol.handler = { req in
            if req.httpMethod == "POST", let stream = req.httpBodyStream {
                stream.open(); defer { stream.close() }
                var data = Data(); var buf = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let n = stream.read(&buf, maxLength: buf.count); if n <= 0 { break }; data.append(buf, count: n) }
                sent.body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                sent.path = req.url?.path
                return (HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                        Data(#"{"created":true,"inviteId":"i1","tier":"member","ok":true,"pruned":2}"#.utf8))
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

        let pruned = try await client.withdrawInvite(serverDomain: server, revoke: ["inviteId": "i1", "issuedAt": 1700],
                                                     signatureHex: "AB")
        XCTAssertEqual(pruned, 2)
        XCTAssertEqual(sent.path, "/api/service-access/invite-withdraw")
        XCTAssertEqual((sent.body?["revoke"] as? [String: Any])?["inviteId"] as? String, "i1")
        XCTAssertEqual(sent.body?["signature"] as? String, "ab")
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

    func testAdminSetsModeWithAV2OrderUnderTheAdminRoot() async throws {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, isAdmin: true, rank: "master")
        await vm.setMode(restricted: true)
        XCTAssertTrue(vm.restricted)
        XCTAssertEqual(mock.setModeCalls.count, 1)
        let call = mock.setModeCalls[0]
        XCTAssertEqual(call.request["mode"], "restricted")
        XCTAssertEqual(call.request["serviceRef"], serviceRef)
        XCTAssertNil(call.request["serverId"], "v2 names the app, not the server")
        let bytes = try ServiceAccessModeOrder(serviceRef: serviceRef, restricted: true, issuedAt: 1700).canonicalBytes()
        XCTAssertEqual(String(data: bytes, encoding: .utf8), "flagship/service-access-mode/v2|alice--notes|restricted|1700")
        XCTAssertTrue(adminRoot().publicKey.isValidSignature(sig(call.signatureHex), for: bytes))
    }

    func testNonAdminCannotChangeTheMode() async {
        let mock = MockServiceAccessClient()
        let prompts = Prompts()
        let vm = makeVM(mock, rank: "master", prompts: prompts)
        XCTAssertFalse(vm.canChangeMode)
        await vm.setMode(restricted: true)
        XCTAssertFalse(vm.restricted)
        XCTAssertTrue(mock.setModeCalls.isEmpty)
        XCTAssertEqual(prompts.admin + prompts.device, 0)
    }

    func testAddPersonReturnsV2Link() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock)
        await vm.load()
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
        XCTAssertNil(call.request["approvalMode"])
        XCTAssertNil(call.request["maxRedemptions"])
        XCTAssertTrue(deviceKey().publicKey.isValidSignature(sig(call.signatureHex), for: createBytes(call)))
        // inviteId is a random 128-bit hex (NOT the structured devicePub form).
        XCTAssertEqual(call.request["inviteId"]?.count, 64)
    }

    func testAddManualInviteSetsApprovalModeAndInviteIdInLink() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock)
        await vm.load()
        let link = await vm.addPerson(name: "Sam", photo: nil, tier: .personalManual)
        XCTAssertNotNil(link)
        let call = mock.createCalls[0]
        XCTAssertEqual(call.request["approvalMode"], "manual")
        let inviteId = call.request["inviteId"]!
        XCTAssertTrue(link!.contains("&i=\(inviteId)"))
    }

    func testAddGroupInviteSetsCapsAndExpiry() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock)
        await vm.load()
        let link = await vm.addPerson(name: "Chess club", photo: nil, tier: .group(maxRedemptions: 10, expiresAt: 1_700_009_999_999))
        XCTAssertNotNil(link)
        let call = mock.createCalls[0]
        XCTAssertEqual(call.request["maxRedemptions"], "10")
        XCTAssertEqual(call.request["expiresAt"], "1700009999999")
        XCTAssertNil(call.request["approvalMode"], "group is auto-approve")
        XCTAssertTrue(deviceKey().publicKey.isValidSignature(
            sig(call.signatureHex), for: createBytes(call, maxRedemptions: 10, expiresAt: 1_700_009_999_999)))
    }

    func testRefreshPeopleSignsListQueryUnderAid() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 1)
        let vm = makeVM(mock)
        await vm.load()
        XCTAssertGreaterThanOrEqual(mock.listCalls.count, 1)
        let call = mock.listCalls.last!
        XCTAssertEqual(call.query["authorAID"], HexUtil.encode(aid().publicKey.rawRepresentation))
        XCTAssertEqual(call.query["scope"], "list")
        XCTAssertEqual(call.query["cursor"], "0")
        let bytes = try! ServiceInvite.canonicalListQuery(
            username: username, authorAID: HexUtil.encode(aid().publicKey.rawRepresentation),
            scope: "list", cursor: 0, issuedAt: 1700)
        XCTAssertTrue(aid().publicKey.isValidSignature(sig(call.signatureHex), for: bytes))
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
            ServiceInviteRow(inviteId: id2, serviceRef: serviceRef, encryptedBundleHex: b2, boundAidHex: nil, boundAt: nil, createdAt: 2, revokedAt: 99),
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

    func testRemoveUnredeemedInviteRevokesOnComOnly() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, isAdmin: true, rank: "master")
        await vm.remove(inviteId: "deadbeef")
        XCTAssertEqual(mock.revokeCalls.count, 1)
        XCTAssertEqual(mock.revokeCalls[0].inviteId, "deadbeef")
        XCTAssertTrue(mock.withdrawCalls.isEmpty, "nobody joined, so nothing to drop on the box")
        XCTAssertTrue(mock.removeAllowCalls.isEmpty)
    }

    func testAdminRemoveWithdrawsOnTheBoxUnderOneSignature() async throws {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 1)
        let id = "aa" + String(repeating: "0", count: 62)
        let friendAID = "a1f3c968acbff6ca2b8267282715e72559cc09bf1e25aecbfd316650a4012b6c"
        mock.rows = [row(id, "Alex", bound: friendAID)]
        let prompts = Prompts()
        let screens = box(isAdmin: true, rank: "master",
                          members: [AppMember(aid: friendAID, role: "member", grants: [AppMemberGrant(inviteId: id, role: "member")])])
        let vm = makeVM(mock, isAdmin: true, screens: screens, prompts: prompts)
        await vm.load()
        await vm.remove(inviteId: id)
        XCTAssertEqual(prompts.admin, 1)
        XCTAssertEqual(mock.revokeCalls.count, 1)
        XCTAssertEqual(mock.withdrawCalls.count, 1)
        let bytes = try ServiceInvite.canonicalRevoke(inviteId: id, issuedAt: 1700)
        XCTAssertTrue(adminRoot().publicKey.isValidSignature(sig(mock.withdrawCalls[0].signatureHex), for: bytes))
        XCTAssertTrue(mock.removeAllowCalls.isEmpty, "the withdraw covers a person who joined through it")
    }

    func testAdminRemovesAPersonWhoJoinedBeforeGrantsWithAV2Order() async throws {
        let mock = MockServiceAccessClient()
        let id = "aa" + String(repeating: "0", count: 62)
        let friendAID = "a1f3c968acbff6ca2b8267282715e72559cc09bf1e25aecbfd316650a4012b6c"
        mock.rows = [row(id, "Alex", bound: friendAID)]
        let screens = box(isAdmin: true, rank: "master",
                          members: [AppMember(aid: friendAID, role: "manager", grants: [], direct: "manager")])
        let vm = makeVM(mock, isAdmin: true, screens: screens)
        await vm.load()
        await vm.remove(inviteId: id)
        XCTAssertEqual(mock.removeAllowCalls.count, 1)
        let call = mock.removeAllowCalls[0]
        XCTAssertEqual(call.request["aid"], friendAID)
        XCTAssertNil(call.request["serverId"])
        let bytes = try ServiceAllowRemoveOrder(serviceRef: serviceRef, aid: friendAID, issuedAt: 1700).canonicalBytes()
        XCTAssertTrue(adminRoot().publicKey.isValidSignature(sig(call.signatureHex), for: bytes),
                      "the removal is an admin-root-signed v2 order")
    }

    func testRemoveGroupWithdrawsEveryoneInOneCall() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 3)
        let id = "cc" + String(repeating: "0", count: 62)
        let sealed = try! ServiceInvite.sealBundle(.init(name: "Chess club", photo: nil), householdKey: household, inviteId: id)
        let m = ["a1", "a2", "a3"].map { $0 + String(repeating: "0", count: 62) }
        mock.rows = [
            ServiceInviteRow(
                inviteId: id, serviceRef: serviceRef, encryptedBundleHex: sealed,
                boundAidHex: nil, boundAt: nil, createdAt: 1, revokedAt: nil,
                boundAidsHex: m, maxRedemptions: 10, expiresAt: nil, redemptions: 3, approvalMode: "auto"),
        ]
        let vm = makeVM(mock, isAdmin: true, rank: "master")
        await vm.load()
        await vm.remove(inviteId: id)
        XCTAssertEqual(mock.revokeCalls.count, 1)
        XCTAssertEqual(mock.withdrawCalls.count, 1, "one withdraw drops the whole group")
    }

    func testRemoveBoxFailureSurfaces() async {
        let mock = MockServiceAccessClient()
        mock.state = ServiceAccessState(mode: "restricted", allowCount: 1)
        let id = "aa" + String(repeating: "0", count: 62)
        mock.rows = [row(id, "Alex", bound: "a1f3c968acbff6ca2b8267282715e72559cc09bf1e25aecbfd316650a4012b6c")]
        let vm = makeVM(mock, isAdmin: true, rank: "master")
        await vm.load()
        mock.withdrawError = ScreensClientError.http(status: 403, message: "bad sig")
        await vm.remove(inviteId: id)
        XCTAssertEqual(mock.revokeCalls.count, 1)
        XCTAssertEqual(mock.withdrawCalls.count, 1, "the box leg was attempted")
        if case .failed = vm.phase {} else { XCTFail("a box failure must surface") }
    }

    func testSetModeFailureSurfaces() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ScreensClientError.http(status: 403, message: "bad sig")
        let vm = makeVM(mock, isAdmin: true, rank: "master")
        await vm.setMode(restricted: true)
        if case .failed = vm.phase {} else { XCTFail("expected .failed") }
    }
}
