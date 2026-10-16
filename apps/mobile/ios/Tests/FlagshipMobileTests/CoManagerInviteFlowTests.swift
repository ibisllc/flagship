import XCTest
import CryptoKit
@testable import FlagshipUI
import FlagshipAPI
import FlagshipCore

/// Co-manager invites (docs/service-access-gating.md "Co-manager invites") on
/// iOS, against `ShareCoInvitesMockBox`, which answers with the box's wire and
/// checks every signature under the share's member key.
@MainActor
final class CoManagerInviteFlowTests: XCTestCase {
    private let umk = Data(repeating: 0x5b, count: 32)
    private let shareId = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"
    private let now: Int64 = 1_792_000_000_000

    private var entry: SharedServerEntry {
        SharedServerEntry(entryId: String(repeating: "c3", count: 16), shareId: shareId, secretHex: String(repeating: "5e", count: 32),
                          serverDomain: "Home.Harry.flagship.services", serverName: "Home", acceptedAt: 1)
    }

    private func makeFlow(_ apps: [String: ShareCoInvitesMockBox.App]) throws -> (ServerShareMemberFlow, ShareCoInvitesMockBox) {
        let member = try ServerShare.deriveShareMemberKey(umkSeed: umk, shareId: shareId)
        let now = self.now
        let box = ShareCoInvitesMockBox(apps: apps, memberPub: member.publicKey.rawRepresentation, now: { now })
        let client = ServerShareClient(com: box, box: box, boxBase: { URL(string: "https://\($0)") })
        let seed = umk
        return (ServerShareMemberFlow(client: client, umkSeed: { _ in seed }, now: { now }), box)
    }

    func test_personalInvite_signedWithTheMemberKey_linkOnTheSharedServer_thenWithdrawn() async throws {
        let (flow, box) = try makeFlow(["harry--chess": .init(canInvite: true)])
        let state = try await flow.coInvites(entry, shareToken: "fss_t", serviceRef: "harry--chess")
        XCTAssertTrue(state.canInvite)
        XCTAssertEqual(state.ownerAid, ShareCoInvitesMockBox.ownerAid)
        XCTAssertTrue(state.invites.isEmpty)

        let made = try await flow.createCoInvite(entry, shareToken: "fss_t", serviceRef: "harry--chess",
                                                 ownerAid: state.ownerAid, name: "  Alex ")
        let body = try XCTUnwrap(box.lastCreateBody)
        let req = try XCTUnwrap(body["request"] as? [String: Any])
        XCTAssertEqual(req["authorAID"] as? String, ShareCoInvitesMockBox.ownerAid, "authorAID is the owner's AID")
        XCTAssertNil(req["approvalMode"], "never sends approvalMode")
        XCTAssertNil(req["maxRedemptions"])
        XCTAssertNil(req["expiresAt"])
        XCTAssertEqual(req["issuedAt"] as? NSNumber, NSNumber(value: now))
        XCTAssertEqual(made.inviteId.count, 64)
        let prefix = "https://home.harry.flagship.services/invite#"
        XCTAssertTrue(made.link.hasPrefix(prefix), made.link)
        XCTAssertTrue(made.link.hasSuffix("&a=\(ShareCoInvitesMockBox.ownerAid)&i=\(made.inviteId)&s=harry--chess"), made.link)
        let secretHex = String(made.link.dropFirst(prefix.count).prefix(64))
        XCTAssertEqual(req["secretHash"] as? String, ServiceInvite.secretHash(secret: try XCTUnwrap(HexUtil.decode(secretHex))))
        XCTAssertEqual(box.sessionTokens.last, "fss_t")

        let key = try ServerShare.deriveShareInviteBundleKey(umkSeed: umk, shareId: shareId)
        let opened = try ServiceInvite.openBundle(try XCTUnwrap(req["encryptedBundle"] as? String), householdKey: key, inviteId: made.inviteId)
        XCTAssertEqual(opened.name, "Alex")

        let listed = try await flow.coInvites(entry, shareToken: "fss_t", serviceRef: "harry--chess")
        XCTAssertEqual(listed.invites.map(\.name), ["Alex"])
        XCTAssertEqual(ShareCoInviteCopy.statusText(listed.invites[0], now: now), "Not opened yet")

        try await flow.withdrawCoInvite(entry, shareToken: "fss_t", inviteId: made.inviteId)
        let revoke = try XCTUnwrap(box.lastWithdrawBody?["revoke"] as? [String: Any])
        XCTAssertEqual(revoke["inviteId"] as? String, made.inviteId)
        let after = try await flow.coInvites(entry, shareToken: "fss_t", serviceRef: "harry--chess")
        XCTAssertTrue(after.invites.isEmpty)
    }

    func test_groupInvite_signsItsLimits() async throws {
        let (flow, box) = try makeFlow(["harry--chess": .init(canInvite: true)])
        let group = ShareCoInviteGroup.fromForm(maxUses: "10", days: "30", now: now)
        XCTAssertEqual(group, ShareCoInviteGroup(maxRedemptions: 10, expiresAt: now + 30 * 86_400_000))
        _ = try await flow.createCoInvite(entry, shareToken: "fss_t", serviceRef: "harry--chess",
                                          ownerAid: ShareCoInvitesMockBox.ownerAid, name: "Chess club", group: group)
        let req = try XCTUnwrap(box.lastCreateBody?["request"] as? [String: Any])
        XCTAssertEqual(req["maxRedemptions"] as? Int, 10)
        XCTAssertEqual((req["expiresAt"] as? NSNumber)?.int64Value, now + 30 * 86_400_000)
        XCTAssertEqual(ShareCoInviteGroup.fromForm(maxUses: "x", days: "", now: now), ShareCoInviteGroup(maxRedemptions: 10))
        XCTAssertEqual(ShareCoInviteGroup.fromForm(maxUses: "0", days: "0", now: now), ShareCoInviteGroup(maxRedemptions: 0))
    }

    func test_demoted_showsTheBoxSentence_andNamesThatWontOpenAreSomeone() async throws {
        let (flow, _) = try makeFlow([
            "harry--wiki": .init(canInvite: false, why: "demoted", rank: "member", invites: [
                ["inviteId": String(repeating: "a7", count: 32), "createdAt": now, "encryptedBundle": "00",
                 "maxRedemptions": 10, "expiresAt": now - 1, "joined": 3],
            ]),
        ])
        let state = try await flow.coInvites(entry, shareToken: "fss_t", serviceRef: "harry--wiki")
        XCTAssertFalse(state.canInvite)
        XCTAssertEqual(state.whyText, "An admin made you a Member of this app, so you can't invite people to it.")
        XCTAssertEqual(state.invites.first?.displayName, "Someone")
        XCTAssertEqual(ShareCoInviteCopy.statusText(state.invites[0], now: now), "3 of 10 joined · expired")
        do {
            _ = try await flow.createCoInvite(entry, shareToken: "fss_t", serviceRef: "harry--wiki",
                                              ownerAid: ShareCoInvitesMockBox.ownerAid, name: "Jo")
            XCTFail("a demoted co-manager can't invite")
        } catch let e as ShareInviteRefusal {
            XCTAssertEqual(e.code, "demoted")
            XCTAssertEqual(e.message, "An admin made you a Member of this app, so you can't invite people to it.")
        }
    }

    func test_refusalWording() async throws {
        XCTAssertEqual(ShareInviteRefusal(ServerShareHTTPError(status: 403, error: "invalid-signature", code: "invalid-signature"),
                                          fallback: ShareCoInviteCopy.createFailed).message,
                       "Couldn't create the invite. Try again.")
        XCTAssertEqual(ShareInviteRefusal(ServerShareHTTPError(status: 400, error: "bad", code: "malformed"),
                                          fallback: ShareCoInviteCopy.createFailed).message,
                       "Couldn't create the invite. Try again.")
        XCTAssertEqual(ShareInviteRefusal(ServerShareHTTPError(status: 409, error: "You have 200 open invites.", code: "too-many-invites"),
                                          fallback: ShareCoInviteCopy.createFailed).message,
                       "You have 200 open invites.")
        XCTAssertEqual(ShareInviteRefusal(ServerShareHTTPError(status: 500, error: "boom", code: nil),
                                          fallback: ShareCoInviteCopy.withdrawFailed).message,
                       "Couldn't withdraw the invite. Try again.")

        let (flow, _) = try makeFlow(["harry--chess": .init(canInvite: true)])
        do {
            _ = try await flow.createCoInvite(entry, shareToken: "t", serviceRef: "harry--chess", ownerAid: ShareCoInvitesMockBox.ownerAid, name: " ")
            XCTFail("needs a name")
        } catch let e as ShareInviteRefusal { XCTAssertEqual(e.message, "Give them a name.") }
        do {
            _ = try await flow.createCoInvite(entry, shareToken: "t", serviceRef: "harry--chess", ownerAid: ShareCoInvitesMockBox.ownerAid,
                                              name: "", group: .init(maxRedemptions: 1))
            XCTFail("needs a name")
        } catch let e as ShareInviteRefusal { XCTAssertEqual(e.message, "Give the group a name.") }
        do {
            _ = try await flow.withdrawCoInvite(entry, shareToken: "t", inviteId: String(repeating: "ee", count: 32))
            XCTFail("not one of mine")
        } catch let e as ShareInviteRefusal {
            XCTAssertEqual(e.code, "not-yours")
            XCTAssertEqual(e.message, "That isn't one of your invites.")
        }
    }

    func test_statusText() {
        func inv(_ joined: Int, _ max: Int? = nil, _ exp: Int64? = nil) -> ShareCoInvite {
            ShareCoInvite(inviteId: "x", name: nil, joined: joined, maxRedemptions: max, expiresAt: exp)
        }
        XCTAssertEqual(ShareCoInviteCopy.statusText(inv(0), now: now), "Not opened yet")
        XCTAssertEqual(ShareCoInviteCopy.statusText(inv(1), now: now), "1 person joined")
        XCTAssertEqual(ShareCoInviteCopy.statusText(inv(4), now: now), "4 people joined")
        XCTAssertEqual(ShareCoInviteCopy.statusText(inv(3, 0), now: now), "3 joined")
        XCTAssertEqual(ShareCoInviteCopy.statusText(inv(3, 10, now + 1), now: now), "3 of 10 joined")
        XCTAssertEqual(ShareCoInviteCopy.statusText(inv(0, nil, now), now: now), "Not opened yet · expired")
        XCTAssertEqual(ShareCoInviteCopy.withdrawMessage("Chess"),
                       "The link stops working, and anyone who joined through it loses access to Chess.")
    }

    func test_controller_createsListsAndWithdraws() async throws {
        let (flow, _) = try makeFlow(["harry--chess": .init(canInvite: true)])
        let entry = self.entry
        let c = CoInviteController(
            serviceRef: "harry--chess", appName: "Chess",
            fetch: { try await flow.coInvites(entry, shareToken: "t", serviceRef: "harry--chess") },
            make: { try await flow.createCoInvite(entry, shareToken: "t", serviceRef: "harry--chess", ownerAid: $0, name: $1, group: $2) },
            drop: { try await flow.withdrawCoInvite(entry, shareToken: "t", inviteId: $0) })
        await c.toggle()
        XCTAssertEqual(c.state?.canInvite, true)
        c.startAdding(.person)
        let ok = await c.create(name: "")
        XCTAssertFalse(ok)
        XCTAssertEqual(c.errorMessage, "Give them a name.")
        let made = await c.create(name: "Alex")
        XCTAssertTrue(made)
        XCTAssertNil(c.adding)
        XCTAssertTrue(c.lastLink?.contains("/invite#") == true)
        XCTAssertEqual(c.state?.invites.map(\.displayName), ["Alex"])
        let gone = await c.withdraw(try XCTUnwrap(c.state?.invites.first?.inviteId))
        XCTAssertTrue(gone)
        XCTAssertEqual(c.state?.invites.count, 0)
        await c.toggle()
        XCTAssertEqual(c.phase, .closed)
    }

    func test_ownerSide_coManagersInvites() throws {
        XCTAssertEqual(AppInviteTier(rawValue: "co-manager"), .coManager)
        XCTAssertEqual(ServiceAccessViewModel.invitedByText(creatorTier: "co-manager", creatorDeviceId: nil, ownDeviceId: nil,
                                                            names: nil, creatorLabel: "Sam"),
                       "Invited by Sam (co-manager)")
        XCTAssertEqual(ServiceAccessViewModel.invitedByText(creatorTier: "co-manager", creatorDeviceId: nil, ownDeviceId: nil,
                                                            names: nil, creatorLabel: nil),
                       "Invited by a co-manager")
        let body = #"{"serviceId":"a--b","mode":"members-only","roles":["member","manager","master"],"defaultRole":"member","members":[],"invites":[{"inviteId":"i1","role":"member","set":false,"tier":"co-manager","creatorPub":"\#(String(repeating: "eb", count: 32))","creatorShareId":"\#(shareId)","creatorLabel":"Sam"}]}"#
        let decoded = try JSONDecoder().decode(AppMembersResponse.self, from: Data(body.utf8))
        XCTAssertEqual(decoded.inviteTier("i1"), .coManager)
        XCTAssertEqual(decoded.invite("i1")?.creatorShareId, shareId)
        XCTAssertEqual(decoded.invite("i1")?.creatorLabel, "Sam")
        XCTAssertEqual(ServiceAccessViewModel.coManagersInvitee, "Someone they invited")
    }
}
