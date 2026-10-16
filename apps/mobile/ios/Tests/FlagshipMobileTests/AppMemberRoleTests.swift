import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipUI
import FlagshipCore

/// The Access control rows' ranks and targets and the view model's ranks
/// (the rank order's vectors are in AppAccessOrdersVectorTests).
@MainActor
final class AppMemberRoleTests: XCTestCase {

    func test_rowRolesTargetsAndAlsoIn() {
        let sam = String(repeating: "ab", count: 32)
        let old = String(repeating: "cd", count: 32)
        let m = AppMembersResponse(
            serviceId: "a--notes", mode: "open", defaultRole: "member",
            descriptions: ["manager": "Runs tournaments"],
            members: [
                AppMember(aid: sam, role: "manager", grants: [
                    AppMemberGrant(inviteId: "sam", role: "manager"),
                    AppMemberGrant(inviteId: "family", role: "member"),
                ]),
                AppMember(aid: old, role: "master", grants: [], direct: "master"),
            ],
            invites: [
                AppMemberInviteRole(inviteId: "sam", role: "manager", set: true),
                AppMemberInviteRole(inviteId: "family", role: "member", set: true),
            ])
        XCTAssertEqual(AppMemberRole.allCases.map(\.label), ["Member", "Manager", "Master"])
        XCTAssertEqual(AppMemberRole.allCases.filter(\.crowned), [.master])
        XCTAssertEqual(m.description(of: .manager), "Runs tournaments")
        XCTAssertNil(m.description(of: .master))
        XCTAssertEqual(m.rowRole(inviteId: "sam", boundAID: sam), "manager")
        XCTAssertEqual(m.roleTarget(inviteId: "sam", boundAID: sam), "invite:sam")
        XCTAssertEqual(m.rowRole(inviteId: "old", boundAID: old), "master")
        XCTAssertEqual(m.roleTarget(inviteId: "old", boundAID: old), "aid:\(old)")
        XCTAssertEqual(m.rowRole(inviteId: "new", boundAID: nil), "member")
        let others = m.otherGrants(inviteId: "sam", boundAID: sam) { $0 == "family" ? "Family" : nil }
        XCTAssertEqual(AppMembersResponse.alsoInText(others), "also in Family: Member")
        // Only the AIDs for whom this was the last grant are pruned on the box.
        XCTAssertEqual(m.aidsToPrune(inviteId: "family", aids: [sam, old, "ef"]), [old, "ef"])
        XCTAssertEqual(m.aidsToPrune(inviteId: "sam", aids: [sam]), [])
    }

    // MARK: view model

    private let server = "home.alice.flagship.services"
    private let serviceRef = "alice--notes"
    private func key(_ b: UInt8) -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: b, count: 32))
    }

    private let device = String(repeating: "d0", count: 16)

    private func makeVM(_ access: MockServiceAccessClient, _ screens: MockScreensClient,
                        roleKey: Curve25519.Signing.PrivateKey, isAdmin: Bool = true) -> ServiceAccessViewModel {
        let a = key(5); let hh = Data(repeating: 0x33, count: 32); let d = key(0xd0)
        access.listsCreatedInvites = true
        return ServiceAccessViewModel(
            client: access, serverDomain: server, serviceRef: serviceRef, username: "alice",
            controlBase: URL(string: "https://flagshipserver.com")!,
            authorAidKeys: { _ in (a, hh) },
            screens: screens, isAdminDevice: isAdmin,
            adminSigner: { _ in roleKey }, deviceId: device,
            deviceSigner: { _ in d }, ownDeviceKey: { d }, now: { 1_700_000_000_000 })
    }

    private func seatThisDevice(_ screens: MockScreensClient, admin: Bool, rank: String) {
        screens.mockMembers[serviceRef] = AppMembersResponse(
            serviceId: serviceRef, mode: "open", defaultRole: "member",
            accountMembers: [.device(id: device, pub: HexUtil.encode(key(0xd0).publicKey.rawRepresentation),
                                     admin: admin, rank: rank)],
            members: [], invites: [])
    }

    func test_nonAdminDeviceSendsNoRankOrderAndCannotChangeRanks() async {
        let access = MockServiceAccessClient()
        let screens = MockScreensClient()
        seatThisDevice(screens, admin: false, rank: "manager")
        let vm = makeVM(access, screens, roleKey: key(7), isAdmin: false)
        await vm.load()
        XCTAssertFalse(vm.canChangeRanks)
        XCTAssertTrue(vm.canInvite)
        _ = await vm.addPerson(name: "Club", photo: nil, tier: .group(maxRedemptions: 5, expiresAt: nil), role: .manager)
        XCTAssertEqual(access.createCalls.count, 1)
        XCTAssertTrue(screens.setAppRankCalls.isEmpty, "a member invite never sends a rank order")
        guard let p = vm.people.first else { return XCTFail("no row") }
        let ok = await vm.setRole(.master, for: p)
        XCTAssertFalse(ok)
        XCTAssertTrue(screens.setAppRankCalls.isEmpty, "a non-admin device never changes a rank")
        guard let me = vm.me else { return XCTFail("this device is listed") }
        let refused = await vm.setAccountRank(.refused, for: me)
        XCTAssertFalse(refused)
        XCTAssertTrue(screens.setAppRankCalls.isEmpty)
    }

    func test_adminChangesAndRefusesAccountMembersWithAppRankOrders() async throws {
        let access = MockServiceAccessClient()
        let screens = MockScreensClient()
        let share = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"
        let other = HexUtil.encode(key(0x1a).publicKey.rawRepresentation)
        screens.mockMembers[serviceRef] = AppMembersResponse(
            serviceId: serviceRef, mode: "open", defaultRole: "member",
            accountMembers: [
                .device(id: String(repeating: "1a", count: 16), pub: other, admin: false, rank: "manager"),
                .coManager(shareId: share, label: "Mum", rank: "manager"),
            ],
            members: [], invites: [])
        let rk = key(7)
        let vm = makeVM(access, screens, roleKey: rk)
        await vm.load()
        let rows = vm.members?.account ?? []
        XCTAssertEqual(rows.count, 2)

        let refusedOK = await vm.setAccountRank(.refused, for: rows[0])
        let masterOK = await vm.setAccountRank(.master, for: rows[1])
        XCTAssertTrue(refusedOK)
        XCTAssertTrue(masterOK)
        XCTAssertEqual(screens.setAppRankCalls.map(\.req.order.target), ["device:\(other)", "share:\(share)"])
        XCTAssertEqual(screens.setAppRankCalls.map(\.req.order.rank), ["refused", "master"])
        for call in screens.setAppRankCalls {
            let bytes = try call.req.order.canonicalBytes()
            XCTAssertTrue(String(data: bytes, encoding: .utf8)!.hasPrefix("flagship/app-rank/v1|\(serviceRef)|"))
            XCTAssertTrue(rk.publicKey.isValidSignature(HexUtil.decode(call.req.signature)!, for: bytes),
                          "rank orders are signed with the admin root")
        }
        let after = vm.members?.account ?? []
        XCTAssertTrue(after[0].refused)
        XCTAssertNil(after[0].role)
        XCTAssertEqual(after[1].role, .master)
        let back = await vm.setAccountRank(.member, for: after[0])
        XCTAssertTrue(back, "picking a rank lets a refused device back in")
        XCTAssertEqual(vm.members?.account.first?.role, .member)
    }

    func test_staleRankOrderIsSignedAgainOnce() async {
        let access = MockServiceAccessClient()
        let screens = MockScreensClient()
        seatThisDevice(screens, admin: true, rank: "master")
        let vm = makeVM(access, screens, roleKey: key(7))
        await vm.load()
        guard let me = vm.me else { return XCTFail("this device is listed") }
        screens.mockMemberRoleStatus = 409
        let ok = await vm.setAccountRank(.manager, for: me)
        XCTAssertTrue(ok)
        XCTAssertEqual(screens.setAppRankCalls.count, 2)
        XCTAssertGreaterThan(screens.setAppRankCalls[1].req.order.issuedAt, screens.setAppRankCalls[0].req.order.issuedAt)
    }

    func test_inviteTierFromTheBox() {
        let r = AppMembersResponse(
            serviceId: serviceRef, mode: "open", defaultRole: "member",
            members: [AppMember(aid: String(repeating: "a", count: 64), role: "member",
                                grants: [AppMemberGrant(inviteId: "g1", role: "member", tier: "member")])],
            invites: [AppMemberInviteRole(inviteId: "i1", role: "manager", set: true, tier: "admin"),
                      AppMemberInviteRole(inviteId: "i2", role: "member", set: false)])
        XCTAssertEqual(r.inviteTier("i1"), .admin)
        XCTAssertEqual(r.inviteTier("g1"), .member)
        XCTAssertNil(r.inviteTier("i2"), "old rows carry no tier")
        let json = #"{"serviceId":"s","mode":"open","roles":["member"],"defaultRole":"member","members":[{"aid":"aa","role":"member","grants":[{"inviteId":"x","role":"member","tier":"member"}]}],"invites":[{"inviteId":"x","role":"member","set":false,"tier":null}]}"#
        let decoded = try? JSONDecoder().decode(AppMembersResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded?.members.first?.grants.first?.tier, "member")
        XCTAssertNil(decoded?.invites.first?.tier)
    }

    func test_newInviteWithAnotherRoleSendsASignedOrder_defaultSendsNone() async throws {
        let access = MockServiceAccessClient()
        let screens = MockScreensClient()
        let rk = key(7)
        let vm = makeVM(access, screens, roleKey: rk)
        await vm.load()
        XCTAssertNotNil(vm.members)
        _ = await vm.addPerson(name: "Alex", photo: nil, tier: .personalAuto, role: .member)
        XCTAssertTrue(screens.setAppRankCalls.isEmpty, "the app's default role needs no order")
        _ = await vm.addPerson(name: "Club", photo: nil, tier: .group(maxRedemptions: 5, expiresAt: nil), role: .manager)
        XCTAssertEqual(screens.setAppRankCalls.count, 1)
        let sent = screens.setAppRankCalls[0].req
        let inviteId = try XCTUnwrap(access.createCalls.last?.request["inviteId"])
        XCTAssertEqual(sent.order.target, "invite:\(inviteId)")
        XCTAssertEqual(sent.order.rank, "manager")
        XCTAssertEqual(sent.order.serviceRef, serviceRef)
        XCTAssertTrue(rk.publicKey.isValidSignature(HexUtil.decode(sent.signature)!, for: try sent.order.canonicalBytes()))
    }

    func test_modeChangeKeepsTheMembersList() async {
        let access = MockServiceAccessClient()
        let vm = makeVM(access, MockScreensClient(), roleKey: key(7))
        await vm.load()
        _ = await vm.addPerson(name: "Alex", photo: nil)
        let before = vm.people
        await vm.setMode(restricted: true)
        XCTAssertTrue(vm.restricted)
        XCTAssertEqual(vm.people, before)
        await vm.setMode(restricted: false)
        XCTAssertFalse(vm.restricted)
        XCTAssertEqual(vm.people, before, "the toggle never changes the list")
    }

    func test_refusedRoleChangeReportsAndKeepsTheRole() async {
        let access = MockServiceAccessClient()
        let screens = MockScreensClient()
        let vm = makeVM(access, screens, roleKey: key(7))
        await vm.load()
        _ = await vm.addPerson(name: "Alex", photo: nil)
        guard let p = vm.people.first else { return XCTFail("no row") }
        screens.mockMemberRoleStatus = 403
        let ok = await vm.setRole(.master, for: p)
        XCTAssertFalse(ok)
        XCTAssertEqual(vm.role(for: p), .member)
        if case .failed = vm.phase {} else { XCTFail("a refused change surfaces") }
        let ok2 = await vm.setRole(.master, for: p)
        XCTAssertTrue(ok2)
        XCTAssertEqual(vm.role(for: p), .master)
    }
}
