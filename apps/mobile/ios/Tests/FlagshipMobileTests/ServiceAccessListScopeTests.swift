import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// A separate access list on each server (a Pro option, feat/marketplace):
/// the switch on Access control, the server picker that re-targets the whole
/// screen, and the plan screen's warning.
@MainActor
final class ServiceAccessListScopeTests: XCTestCase {
    private let home = "home.alice.flagship.services"
    private let office = "office.alice.flagship.services"
    private let serviceRef = "alice--notes"
    private let ownDevice = String(repeating: "d0", count: 16)
    private let household = Data(repeating: 0x33, count: 32)

    private func key(_ b: UInt8) -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: b, count: 32))
    }
    private var adminRoot: Curve25519.Signing.PrivateKey { key(0x0a) }
    private var deviceKey: Curve25519.Signing.PrivateKey { key(0xd0) }

    private final class Prompts { var admin = 0; var device = 0 }

    private func box(scope: String? = "account", plan: String = "pro", pending: Bool = false,
                     self fqdn: String? = nil, members: [AppMember] = [],
                     invites: [AppMemberInviteRole] = []) -> MockScreensClient {
        let s = MockScreensClient()
        s.simulatedLatency = 0
        let me = fqdn ?? home
        s.mockMembers[serviceRef] = AppMembersResponse(
            serviceId: serviceRef, mode: "open", defaultRole: "member",
            accountMembers: [.device(id: ownDevice, pub: HexUtil.encode(deviceKey.publicKey.rawRepresentation),
                                     admin: true, rank: "master")],
            members: members, invites: invites)
        if let scope {
            s.mockListScope[serviceRef] = AppListScopeState(
                serviceRef: serviceRef, scope: scope, pending: pending, plan: plan,
                selfFqdn: me, leader: home, servers: [home, office])
        }
        return s
    }

    private func makeVM(_ access: MockServiceAccessClient = MockServiceAccessClient(),
                        screens: MockScreensClient, isAdmin: Bool = true, prompts: Prompts = Prompts(),
                        pods: [String: MockScreensClient] = [:],
                        names: [String: String] = [:]) -> ServiceAccessViewModel {
        let aid = key(5), hh = household, root = adminRoot, d = deviceKey
        return ServiceAccessViewModel(
            client: access, serverDomain: home, serviceRef: serviceRef, username: "alice",
            controlBase: URL(string: "https://flagshipserver.com")!,
            authorAidKeys: { _ in (aid, hh) },
            screens: screens,
            podScreens: { fqdn in pods[fqdn] ?? screens },
            serverNames: names,
            isAdminDevice: isAdmin,
            adminSigner: { _ in prompts.admin += 1; return root },
            deviceId: ownDevice,
            deviceSigner: { _ in prompts.device += 1; return d },
            ownDeviceKey: { d },
            deviceNames: { nil },
            now: { 1_760_000_000_000 })
    }

    // ─── The switch ──────────────────────────────────────────────────────────

    func testNonAdminDeviceGetsNoSwitchOnlyTheReadOnlyLineWhenOn() async {
        let off = makeVM(screens: box(scope: "account"), isAdmin: false)
        await off.load()
        XCTAssertNotNil(off.listScope)
        XCTAssertFalse(off.showsScopeToggle, "the switch is an admin device's alone")
        XCTAssertNil(off.scopeReadOnlyNote)
        XCTAssertNil(off.scopeProNote)

        let on = makeVM(screens: box(scope: "server"), isAdmin: false)
        await on.load()
        XCTAssertFalse(on.showsScopeToggle)
        XCTAssertEqual(on.scopeReadOnlyNote, "Each server has its own list.")
        XCTAssertTrue(on.showsServerPicker, "any device picks which server's list it sees")
        let r1 = await on.setSeparateLists(false)
        XCTAssertFalse(r1, "a non-admin device can't sign it")
    }

    func testAnOlderBoxHidesTheSwitch() async {
        let vm = makeVM(screens: box(scope: nil))
        await vm.load()
        XCTAssertEqual(vm.phase, .ready)
        XCTAssertNil(vm.listScope)
        XCTAssertFalse(vm.showsScopeToggle)
        XCTAssertFalse(vm.showsServerPicker)
    }

    func testWithoutProTheSwitchIsLockedAndNothingIsSigned() async {
        let screens = box(scope: "account", plan: "free")
        let prompts = Prompts()
        let vm = makeVM(screens: screens, prompts: prompts)
        await vm.load()
        XCTAssertTrue(vm.showsScopeToggle)
        XCTAssertFalse(vm.scopeOn)
        XCTAssertFalse(vm.canToggleScope)
        XCTAssertEqual(vm.scopeProNote, "Comes with Pro.")
        let r2 = await vm.setSeparateLists(true)
        XCTAssertFalse(r2)
        XCTAssertEqual(prompts.admin, 0)
        XCTAssertTrue(screens.setAppListScopeCalls.isEmpty)
    }

    func testTurningOnSignsTheListScopeOrderWithTheAdminRootAndPostsItToTheShownServer() async throws {
        let screens = box(scope: "account", plan: "pro")
        let prompts = Prompts()
        let vm = makeVM(screens: screens, prompts: prompts)
        await vm.load()
        XCTAssertTrue(vm.canToggleScope)
        XCTAssertNil(vm.scopeProNote)
        XCTAssertFalse(vm.showsServerPicker, "one list: no picker")

        let ok = await vm.setSeparateLists(true)
        XCTAssertTrue(ok)
        XCTAssertEqual(prompts.admin, 1, "one admin-root prompt")
        XCTAssertEqual(prompts.device, 0, "never the account device key")
        let call = try XCTUnwrap(screens.setAppListScopeCalls.first)
        XCTAssertEqual(call.serviceId, serviceRef)
        XCTAssertEqual(call.req.order, AppListScopeOrder(serviceRef: serviceRef, scope: "server", issuedAt: 1_760_000_000_000))
        let bytes = try call.req.order.canonicalBytes()
        XCTAssertEqual(String(data: bytes, encoding: .utf8),
                       "flagship/app-list-scope/v1|alice--notes|server|1760000000000")
        let sig = try XCTUnwrap(HexUtil.decode(call.req.signature))
        XCTAssertTrue(adminRoot.publicKey.isValidSignature(sig, for: bytes), "signed by the admin root")
        XCTAssertFalse(deviceKey.publicKey.isValidSignature(sig, for: bytes))
        XCTAssertTrue(vm.scopeOn)
        XCTAssertTrue(vm.showsServerPicker)
        XCTAssertEqual(vm.pickerServers, [home, office])
    }

    func testA402ShowsTheProLine() async {
        let screens = box(scope: "account", plan: "pro")
        screens.mockListScopeStatus = 402
        let vm = makeVM(screens: screens)
        await vm.load()
        let r3 = await vm.setSeparateLists(true)
        XCTAssertFalse(r3)
        XCTAssertTrue(vm.scopeNeedsPro)
        XCTAssertEqual(vm.scopeProNote, "Comes with Pro.")
        XCTAssertFalse(vm.scopeOn)
        XCTAssertNotEqual(vm.phase, .failed("Couldn't give each server its own list. Try again in a moment."),
                          "a 402 is the Pro line, not an error")
    }

    func testA409SignsAgainOnce() async throws {
        let screens = box(scope: "account", plan: "pro")
        screens.mockListScopeStatus = 409
        let prompts = Prompts()
        let vm = makeVM(screens: screens, prompts: prompts)
        await vm.load()
        let r4 = await vm.setSeparateLists(true)
        XCTAssertTrue(r4)
        XCTAssertEqual(screens.setAppListScopeCalls.count, 2)
        XCTAssertEqual(prompts.admin, 1, "the same key signs again")
        XCTAssertGreaterThan(screens.setAppListScopeCalls[1].req.order.issuedAt, screens.setAppListScopeCalls[0].req.order.issuedAt)
    }

    func testPendingShowsTheWaitingLine() async {
        let vm = makeVM(screens: box(scope: "account", plan: "unknown", pending: true))
        await vm.load()
        XCTAssertTrue(vm.scopeOn, "a held order shows the switch on")
        XCTAssertTrue(vm.canToggleScope, "it can still be turned off")
        XCTAssertEqual(vm.scopePendingNote, "Waiting for this server to confirm Pro.")
        XCTAssertNil(vm.scopeProNote)
        XCTAssertFalse(vm.showsServerPicker, "the box still keeps one list")
    }

    func testTurningOffConfirmNamesTheLeader() async throws {
        let named = makeVM(screens: box(scope: "server"), names: [home: "Living room"])
        await named.load()
        XCTAssertEqual(named.scopeOffConfirmText,
                       "Every server will use Living room's list. People who joined on other servers since lose access.")
        let unnamed = makeVM(screens: box(scope: "server"))
        await unnamed.load()
        XCTAssertEqual(unnamed.scopeOffConfirmText,
                       "Every server will use home's list. People who joined on other servers since lose access.")

        let screens = box(scope: "server")
        let vm = makeVM(screens: screens)
        await vm.load()
        let r5 = await vm.setSeparateLists(false)
        XCTAssertTrue(r5)
        let call = try XCTUnwrap(screens.setAppListScopeCalls.first)
        XCTAssertEqual(try call.req.order.canonicalBytes(),
                       Data("flagship/app-list-scope/v1|alice--notes|account|1760000000000".utf8))
        XCTAssertFalse(vm.scopeOn)
        XCTAssertFalse(vm.showsServerPicker)
    }

    // ─── The server picker ───────────────────────────────────────────────────

    func testPickingAServerRetargetsMembersModeRanksAndInviteLinks() async throws {
        let access = MockServiceAccessClient()
        let homeBox = box(scope: "server")
        let officeBox = box(scope: "server", self: office,
                            members: [AppMember(aid: String(repeating: "7b", count: 32), role: "member",
                                                grants: [AppMemberGrant(inviteId: "o1", role: "member")])],
                            invites: [AppMemberInviteRole(inviteId: "o1", role: "member", set: false)])
        let vm = makeVM(access, screens: homeBox, pods: [office: officeBox],
                        names: [home: "Home", office: "Office"])
        await vm.load()
        XCTAssertEqual(vm.shownServer, home)
        XCTAssertEqual(vm.members?.members.count, 0)
        XCTAssertEqual(vm.pickerServers.map(vm.serverName), ["Home", "Office"])

        await vm.showServer(office)
        XCTAssertEqual(vm.shownServer, office)
        XCTAssertEqual(vm.members?.members.count, 1, "members come from the picked server")
        XCTAssertEqual(vm.listScope?.selfFqdn, office)

        await vm.setMode(restricted: true)
        XCTAssertEqual(access.setModeCalls.last?.serverDomain, office, "the mode goes to the picked server")

        let me = try XCTUnwrap(vm.members?.account.first)
        let ranked = await vm.setAccountRank(.manager, for: me)
        XCTAssertTrue(ranked)
        XCTAssertEqual(officeBox.setAppRankCalls.count, 1, "the rank goes to the picked server")
        XCTAssertTrue(homeBox.setAppRankCalls.isEmpty)

        let made = await vm.addPerson(name: "Alex", photo: nil)
        let link = try XCTUnwrap(made)
        XCTAssertTrue(link.hasPrefix("https://\(office)/"), "the invite link points at the picked server: \(link)")

        await vm.showServer(home)
        XCTAssertEqual(vm.shownServer, home)
        XCTAssertEqual(vm.members?.members.count, 0)
    }

    func testPickerOffersOnlyTheAppsServers() async {
        let vm = makeVM(screens: box(scope: "server"))
        await vm.load()
        await vm.showServer("attic.alice.flagship.services")
        XCTAssertEqual(vm.shownServer, home, "a server the app isn't on can't be picked")
    }

    func testTurningOffFromAnotherServerGoesBackToTheHomeServer() async {
        let homeBox = box(scope: "server")
        let officeBox = box(scope: "server", self: office)
        let vm = makeVM(screens: homeBox, pods: [office: officeBox])
        await vm.load()
        await vm.showServer(office)
        let r6 = await vm.setSeparateLists(false)
        XCTAssertTrue(r6)
        XCTAssertEqual(officeBox.setAppListScopeCalls.count, 1, "posted once, to the server the screen shows")
        XCTAssertTrue(homeBox.setAppListScopeCalls.isEmpty)
        XCTAssertEqual(vm.shownServer, home)
    }

    // ─── Narrowing .com's invites to the shown server ───────────────────────

    private func person(_ id: String, bound: String? = nil, group: [String] = [], max: Int? = nil,
                        redemptions: Int? = nil) -> ServiceAccessViewModel.Person {
        .init(inviteId: id, name: id, photo: nil, bound: bound != nil || !group.isEmpty, boundAID: bound,
              groupBoundAIDs: group, groupMax: max, redemptions: redemptions)
    }

    func testInvitesNarrowToTheShownServerOnlyWithSeparateLists() {
        let a = String(repeating: "aa", count: 32)
        let people = [
            person("known", bound: a),
            person("granted", bound: a),
            person("elsewhere", bound: a),
            person("unused"),
            person("used-group", max: 5, redemptions: 1),
        ]
        let members = AppMembersResponse(
            serviceId: serviceRef, mode: "open", defaultRole: "member",
            members: [AppMember(aid: a, role: "member", grants: [AppMemberGrant(inviteId: "granted", role: "member")])],
            invites: [AppMemberInviteRole(inviteId: "known", role: "member", set: false)])
        let separate = AppListScopeState(serviceRef: serviceRef, scope: "server", plan: "pro",
                                         selfFqdn: home, leader: home, servers: [home, office])
        let one = AppListScopeState(serviceRef: serviceRef, scope: "account", plan: "pro",
                                    selfFqdn: home, leader: home, servers: [home, office])
        typealias VM = ServiceAccessViewModel
        XCTAssertEqual(VM.peopleOnShownServer(people, members: members, scope: separate).map(\.inviteId),
                       ["known", "granted", "unused"])
        XCTAssertEqual(VM.peopleOnShownServer(people, members: members, scope: one).count, 5, "one list: all")
        XCTAssertEqual(VM.peopleOnShownServer(people, members: nil, scope: separate).count, 5,
                       "no members answer: all")
    }

    // ─── Plan screen ─────────────────────────────────────────────────────────

    func testPlanWarningCopy() {
        let h = home
        let name: (String) -> String = { $0 == h ? "Home" : "Office" }
        typealias T = TierStatusViewModel
        XCTAssertEqual(T.separateListsWarning(AccessListsSummary(plan: "pro", separateApps: 1, leaders: [home]), name: name),
                       "1 app has a separate access list on each server. When Pro ends it will use Home's list.")
        XCTAssertEqual(T.separateListsWarning(AccessListsSummary(plan: "pro", separateApps: 3, leaders: [home]), name: name),
                       "3 apps have a separate access list on each server. When Pro ends they'll all use Home's list.")
        XCTAssertEqual(T.separateListsWarning(AccessListsSummary(plan: "pro", separateApps: 2, leaders: [home, office]), name: name),
                       "2 apps have a separate access list on each server. When Pro ends each will use its lead server's list.")
        XCTAssertNil(T.separateListsWarning(AccessListsSummary(plan: "pro", separateApps: 0, leaders: []), name: name))
        XCTAssertNil(T.separateListsWarning(AccessListsSummary(plan: "free", separateApps: 2, leaders: [home]), name: name))
        XCTAssertNil(T.separateListsWarning(nil, name: name))
    }

    func testPlanScreenLoadsTheSummaryBestEffort() async {
        let client = MockScreensClient()
        client.simulatedLatency = 0
        let none = TierStatusViewModel(client: client)
        await none.load()
        guard case .loaded = none.state else { return XCTFail("the tier still loads") }
        XCTAssertNil(none.separateListsWarning, "an older box: no card")

        client.mockAccessListsSummary = AccessListsSummary(plan: "pro", separateApps: 1, leaders: [home])
        let named = TierStatusViewModel(client: client, serverNames: [home: "Living room"])
        await named.load()
        XCTAssertEqual(named.separateListsWarning,
                       "1 app has a separate access list on each server. When Pro ends it will use Living room's list.")
        let unnamed = TierStatusViewModel(client: client)
        await unnamed.load()
        XCTAssertEqual(unnamed.separateListsWarning,
                       "1 app has a separate access list on each server. When Pro ends it will use home's list.")
    }

    // ─── Push + activity ─────────────────────────────────────────────────────

    func testAccessListsPushOpensActivityAndTheMergedRowHasATitle() {
        let aps: [AnyHashable: Any] = ["category": "access-lists",
                                       "alert": ["body": "Pro ended, so your apps use one access list on all your servers again."]]
        XCTAssertEqual(PushNotifications.link(forPush: ["aps": aps]), .accountActivity)
        XCTAssertEqual(PushNotifications.link(forPush: ["category": "access-lists"]), .accountActivity)
        let row = BoxActivityEntry(ts: 1, action: "access.lists.merged", kind: "access.lists.merged",
                                   detail: "Pro ended, so apps that had a separate access list on each server went back to one list.")
        XCTAssertEqual(BoxEventLabels.title(row), "Back to one access list")
    }
}
