import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipUI
import FlagshipCore

/// The iOS member-role order against THE reference,
/// `packages/protocol/test-vectors/app-member-role/vectors.json` (loaded from
/// disk, never transcribed), plus the Access control view model's ranks.
@MainActor
final class AppMemberRoleTests: XCTestCase {

    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/app-member-role/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func order(_ c: [String: Any]) -> AppMemberRoleOrder {
        AppMemberRoleOrder(serverDomain: c["serverDomain"] as! String, serviceId: c["serviceId"] as! String,
                           target: c["target"] as! String, role: c["role"] as! String,
                           issuedAt: (c["issuedAt"] as! NSNumber).int64Value)
    }

    func test_vectors_canonicalBytesAndPinnedSignatures() throws {
        let v = try vectors()
        let umk = try XCTUnwrap(HexUtil.decode(v["umkSeedHex"] as! String))
        let seed = try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: umk))
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(HexUtil.encode(key.publicKey.rawRepresentation), v["pub"] as? String)
        let cases = try XCTUnwrap(v["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let o = order(c)
            let bytes = try o.canonicalBytes()
            XCTAssertEqual(String(data: bytes, encoding: .utf8), c["canonical"] as? String)
            let pinned = try XCTUnwrap(HexUtil.decode(c["signature"] as! String))
            XCTAssertTrue(key.publicKey.isValidSignature(pinned, for: bytes))
            // CryptoKit signs randomized: ours differs from the pinned one but verifies.
            XCTAssertTrue(key.publicKey.isValidSignature(try key.signature(for: bytes), for: bytes))
        }
    }

    func test_vectors_refusals() throws {
        let invalid = try XCTUnwrap(try vectors()["invalid"] as? [[String: Any]])
        XCTAssertFalse(invalid.isEmpty)
        for c in invalid {
            XCTAssertThrowsError(try order(c).canonicalBytes(), c["why"] as? String ?? "")
        }
    }

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

    private func makeVM(_ access: MockServiceAccessClient, _ screens: MockScreensClient,
                        roleKey: Curve25519.Signing.PrivateKey) -> ServiceAccessViewModel {
        let a = key(5); let i = key(9); let hh = Data(repeating: 0x33, count: 32)
        access.listsCreatedInvites = true
        return ServiceAccessViewModel(
            client: access, serverDomain: server, serviceRef: serviceRef, username: "alice",
            controlBase: URL(string: "https://flagshipserver.com")!,
            authorAidKeys: { _ in (a, hh) }, irkSigner: { _ in i },
            screens: screens, roleSigner: { _ in roleKey }, now: { 1_700_000_000_000 })
    }

    func test_newInviteWithAnotherRoleSendsASignedOrder_defaultSendsNone() async throws {
        let access = MockServiceAccessClient()
        let screens = MockScreensClient()
        let rk = key(7)
        let vm = makeVM(access, screens, roleKey: rk)
        await vm.load()
        XCTAssertNotNil(vm.members)
        _ = await vm.addPerson(name: "Alex", photo: nil, tier: .personalAuto, role: .member)
        XCTAssertTrue(screens.setAppMemberRoleCalls.isEmpty, "the app's default role needs no order")
        _ = await vm.addPerson(name: "Club", photo: nil, tier: .group(maxRedemptions: 5, expiresAt: nil), role: .manager)
        XCTAssertEqual(screens.setAppMemberRoleCalls.count, 1)
        let sent = screens.setAppMemberRoleCalls[0].req
        let inviteId = try XCTUnwrap(access.createCalls.last?.request["inviteId"])
        XCTAssertEqual(sent.order.target, "invite:\(inviteId)")
        XCTAssertEqual(sent.order.role, "manager")
        XCTAssertEqual(sent.order.serverDomain, server)
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
