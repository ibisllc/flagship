import XCTest
import CryptoKit
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

@MainActor
final class KnockAuthorizeViewModelTests: XCTestCase {
    private let server = "home.alice.flagship.services"
    private let svc = "notes"
    private let ref = "alice--notes"
    private let page = "cb2421036efeb738c6017d8ee92e7b89"

    private func aid() -> Curve25519.Signing.PrivateKey {
        try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 9, count: 32))
    }

    /// A fresh, empty UserDefaults-backed owner store per test.
    private func ownerStore() -> InviteOwnerStore {
        let suite = "knock-tests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: suite)!
        d.removePersistentDomain(forName: suite)
        return InviteOwnerStore(defaults: d)
    }

    /// Our OWN server (in AppState pods) ⇒ the global AID signs.
    private func makeVM(
        _ mock: MockServiceAccessClient,
        store: any SecuredSessionStoring,
        ref: String? = nil,
        page: String? = nil,
        now: @escaping () -> Int64 = { 1_700_004_000_000 }
    ) -> KnockAuthorizeViewModel {
        let k = aid()
        return KnockAuthorizeViewModel(
            client: mock,
            store: store,
            serverDomain: server,
            svc: svc,
            serviceRef: ref ?? self.ref,
            pageId: page ?? self.page,
            ownServers: [server],
            owners: ownerStore(),
            aid: { _ in k },
            contactAid: { _, _ in XCTFail("own server must not use a contact AID"); return k },
            now: now)
    }

    // MARK: fixture (packages/protocol/tests/fixtures/serviceAccessGating.vectors.json)

    private struct Fixture {
        let friendUmk: Data
        let authorAidPubHex: String
        let contactAidPubHex: String
        let friendAidPubHex: String
    }

    private func fixture() throws -> Fixture {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var url: URL?
        for _ in 0..<14 {
            let c = dir.appendingPathComponent("packages/protocol/tests/fixtures/serviceAccessGating.vectors.json")
            if FileManager.default.fileExists(atPath: c.path) { url = c; break }
            dir = dir.deletingLastPathComponent()
        }
        let root = try JSONSerialization.jsonObject(with: Data(contentsOf: XCTUnwrap(url))) as! [String: Any]
        let seeds = root["seeds"] as! [String: Any]
        let contact = root["contactAid"] as! [String: Any]
        let derived = root["derived"] as! [String: Any]
        return Fixture(
            friendUmk: HexUtil.decode(seeds["friendUmkSeedHex"] as! String)!,
            authorAidPubHex: contact["authorAidPubHex"] as! String,
            contactAidPubHex: contact["contactAidPubHex"] as! String,
            friendAidPubHex: derived["friendAidPubHex"] as! String)
    }

    /// The friend's VM on a box they were invited to: real UMK derivations from
    /// the fixture seed (global AID + per-owner contact AID).
    private func friendVM(
        _ mock: MockServiceAccessClient,
        fx: Fixture,
        owners: InviteOwnerStore,
        ownServers: [String] = [],
        refreshOwnServers: (@MainActor () async -> [String])? = nil,
        serverDomain: String? = nil
    ) -> KnockAuthorizeViewModel {
        let umk = fx.friendUmk
        return KnockAuthorizeViewModel(
            client: mock,
            store: InMemorySecuredSessionStore(),
            serverDomain: serverDomain ?? server,
            svc: svc,
            serviceRef: ref,
            pageId: page,
            ownServers: ownServers,
            refreshOwnServers: refreshOwnServers,
            owners: owners,
            aid: { _ in ServiceInvite.deriveAccountId(umkSeed: umk)! },
            contactAid: { ownerPub, _ in ServiceInvite.deriveContactAccountId(umkSeed: umk, authorAidPub: ownerPub)! },
            now: { 1_700_004_000_000 })
    }

    func testInvitedServerSignsWithContactAid() async throws {
        let fx = try fixture()
        let owners = ownerStore()
        owners.remember(serverDomain: server, ownerAidHex: fx.authorAidPubHex.uppercased())
        let mock = MockServiceAccessClient()
        let vm = friendVM(mock, fx: fx, owners: owners)
        await vm.authorize()

        XCTAssertEqual(vm.phase, .authorized)
        XCTAssertEqual(mock.authorizeKnockCalls.count, 1)
        let call = mock.authorizeKnockCalls[0]
        // The contact AID the invite bound, NOT the friend's global AID.
        XCTAssertEqual(call.authorization["visitorAID"], fx.contactAidPubHex)
        XCTAssertNotEqual(call.authorization["visitorAID"], fx.friendAidPubHex)
        let contactPub = HexUtil.decode(fx.contactAidPubHex)!
        let bytes = try ServiceInvite.canonicalKnock(
            serverId: server, serviceRef: ref, pageId: page,
            visitorAID: contactPub, issuedAt: 1_700_004_000_000)
        XCTAssertTrue(ServiceInvite.verify(HexUtil.decode(call.signatureHex)!, bytes, pub: contactPub))
    }

    func testInviteOpenedOnAppHostCountsForTheBox() async throws {
        let fx = try fixture()
        let owners = ownerStore()
        owners.remember(serverDomain: "notes.\(server)", ownerAidHex: fx.authorAidPubHex)
        let mock = MockServiceAccessClient()
        let vm = friendVM(mock, fx: fx, owners: owners, serverDomain: server.uppercased())
        await vm.authorize()
        XCTAssertEqual(vm.phase, .authorized)
        XCTAssertEqual(mock.authorizeKnockCalls.first?.authorization["visitorAID"], fx.contactAidPubHex)
    }

    func testOwnServerUsesGlobalAidEvenWithAStoredRecord() async throws {
        let fx = try fixture()
        let owners = ownerStore()
        owners.remember(serverDomain: server, ownerAidHex: fx.authorAidPubHex)
        let mock = MockServiceAccessClient()
        let vm = friendVM(mock, fx: fx, owners: owners, ownServers: [server.uppercased()])
        await vm.authorize()
        XCTAssertEqual(vm.phase, .authorized)
        XCTAssertEqual(mock.authorizeKnockCalls.first?.authorization["visitorAID"], fx.friendAidPubHex)
    }

    func testUnknownServerRefusesAndSendsNothing() async throws {
        let mock = MockServiceAccessClient()
        let store = InMemorySecuredSessionStore()
        var keyAsks = 0
        let vm = KnockAuthorizeViewModel(
            client: mock, store: store,
            serverDomain: "home.mallory.flagship.services", svc: svc, serviceRef: ref, pageId: page,
            ownServers: [server],
            owners: ownerStore(),
            aid: { _ in keyAsks += 1; return self.aid() },
            contactAid: { _, _ in keyAsks += 1; return self.aid() })
        await vm.authorize()
        XCTAssertEqual(vm.phase, .failed(KnockAuthorizeViewModel.notYourServerMessage))
        XCTAssertEqual(KnockAuthorizeViewModel.notYourServerMessage,
                       "This isn't one of your servers. Open its invite link on this phone first, then try again.")
        XCTAssertTrue(mock.authorizeKnockCalls.isEmpty)
        XCTAssertEqual(keyAsks, 0, "no biometric, no signature for a box we don't know")
        XCTAssertTrue(store.list().isEmpty)
    }

    /// A record naming our own AID (an author-chosen `a=`) is ignored: with the
    /// box not in our pods, even after one refresh, nothing is signed.
    func testRecordNamingOurOwnAidNotInPodsRefusesAfterOneRefresh() async throws {
        let fx = try fixture()
        let owners = ownerStore()
        owners.remember(serverDomain: server, ownerAidHex: fx.friendAidPubHex)
        let mock = MockServiceAccessClient()
        var refreshes = 0
        let vm = friendVM(mock, fx: fx, owners: owners, ownServers: [],
                          refreshOwnServers: { refreshes += 1; return ["office.alice.flagship.services"] })
        await vm.authorize()
        XCTAssertEqual(vm.phase, .failed(KnockAuthorizeViewModel.notYourServerMessage))
        XCTAssertEqual(refreshes, 1)
        XCTAssertTrue(mock.authorizeKnockCalls.isEmpty)
    }

    /// The same record on a box the pods DO list: ours, so the global AID.
    func testRecordNamingOurOwnAidInPodsUsesGlobalAid() async throws {
        let fx = try fixture()
        let owners = ownerStore()
        owners.remember(serverDomain: server, ownerAidHex: fx.friendAidPubHex)
        let mock = MockServiceAccessClient()
        var refreshes = 0
        let vm = friendVM(mock, fx: fx, owners: owners, ownServers: [],
                          refreshOwnServers: { refreshes += 1; return [self.server] })
        await vm.authorize()
        XCTAssertEqual(vm.phase, .authorized)
        XCTAssertEqual(refreshes, 1)
        XCTAssertEqual(mock.authorizeKnockCalls.first?.authorization["visitorAID"], fx.friendAidPubHex)
    }

    /// Cold start from a deep link: pods not loaded yet, so one refresh finds
    /// the box among our servers before we'd refuse.
    func testUnlistedServerRefreshesPodsOnceThenUsesGlobalAid() async throws {
        let fx = try fixture()
        let mock = MockServiceAccessClient()
        var refreshes = 0
        let vm = friendVM(mock, fx: fx, owners: ownerStore(), ownServers: [],
                          refreshOwnServers: { refreshes += 1; return ["Home.Alice.Flagship.Services"] })
        await vm.authorize()
        XCTAssertEqual(vm.phase, .authorized)
        XCTAssertEqual(refreshes, 1)
        XCTAssertEqual(mock.authorizeKnockCalls.first?.authorization["visitorAID"], fx.friendAidPubHex)
    }

    func testUnknownServerAfterRefreshRefusesAndSendsNothing() async throws {
        let fx = try fixture()
        let mock = MockServiceAccessClient()
        var refreshes = 0
        let vm = friendVM(mock, fx: fx, owners: ownerStore(), ownServers: ["office.alice.flagship.services"],
                          refreshOwnServers: { refreshes += 1; return ["office.alice.flagship.services"] },
                          serverDomain: "home.mallory.flagship.services")
        await vm.authorize()
        XCTAssertEqual(vm.phase, .failed(KnockAuthorizeViewModel.notYourServerMessage))
        XCTAssertEqual(refreshes, 1)
        XCTAssertTrue(mock.authorizeKnockCalls.isEmpty)
    }

    /// A box already in the pods list needs no refresh.
    func testListedServerDoesNotRefresh() async throws {
        let fx = try fixture()
        let mock = MockServiceAccessClient()
        var refreshes = 0
        let vm = friendVM(mock, fx: fx, owners: ownerStore(), ownServers: [server],
                          refreshOwnServers: { refreshes += 1; return [] })
        await vm.authorize()
        XCTAssertEqual(vm.phase, .authorized)
        XCTAssertEqual(refreshes, 0)
    }

    func testTitleNamesAppAndServer() {
        XCTAssertEqual(KnockAuthorizeViewModel.title(svc: "notes", serverDomain: server), "Open notes on home?")
        XCTAssertEqual(KnockAuthorizeViewModel.title(svc: "", serverDomain: server), "Open home?")
    }

    func testAuthorizeSuccessPersistsSessionAndPostsSignedAuthorization() async {
        let mock = MockServiceAccessClient()
        mock.authorizeKnockResult = AuthorizeKnockResult(
            secretId: String(repeating: "cd", count: 32),
            serviceRef: ref,
            browserAgent: "Mozilla/5.0 (Macintosh)",
            startedAt: 1_700_004_111_000,
            expiresAt: 1_700_004_999_000)
        let store = InMemorySecuredSessionStore()
        let vm = makeVM(mock, store: store)
        await vm.authorize()

        XCTAssertEqual(vm.phase, .authorized)
        // One authorize call with the expected fields.
        XCTAssertEqual(mock.authorizeKnockCalls.count, 1)
        let call = mock.authorizeKnockCalls[0]
        XCTAssertEqual(call.serverDomain, server)
        XCTAssertEqual(call.authorization["serverId"], server)
        XCTAssertEqual(call.authorization["serviceRef"], ref)
        XCTAssertEqual(call.authorization["pageId"], page)
        XCTAssertEqual(call.authorization["visitorAID"], HexUtil.encode(aid().publicKey.rawRepresentation))

        // The posted signature verifies against the canonical knock bytes the
        // box re-derives (CryptoKit sigs are randomized → verify, don't compare).
        let aidPub = aid().publicKey.rawRepresentation
        let bytes = try! ServiceInvite.canonicalKnock(
            serverId: server, serviceRef: ref, pageId: page,
            visitorAID: aidPub, issuedAt: 1_700_004_000_000)
        let sig = HexUtil.decode(call.signatureHex)!
        XCTAssertTrue(ServiceInvite.verify(sig, bytes, pub: aidPub))

        // The session was persisted with the box-returned secretId + metadata.
        let stored = store.list()
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored[0].secretId, String(repeating: "cd", count: 32))
        XCTAssertEqual(stored[0].serverId, server)
        XCTAssertEqual(stored[0].serviceRef, ref)
        XCTAssertEqual(stored[0].serviceUrl, "https://notes.\(server)")
        XCTAssertEqual(stored[0].browserAgent, "Mozilla/5.0 (Macintosh)")
        XCTAssertEqual(stored[0].startedAt, 1_700_004_111_000)
    }

    func testDeniedNotAllowed401() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ServiceAccessError.knockNotAllowed
        let store = InMemorySecuredSessionStore()
        let vm = makeVM(mock, store: store)
        await vm.authorize()
        if case .failed(let msg) = vm.phase {
            XCTAssertTrue(msg.contains("don't have access"))
        } else { XCTFail("expected .failed, got \(vm.phase)") }
        XCTAssertTrue(store.list().isEmpty)
    }

    func testBadRequest403() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ServiceAccessError.knockBadRequest
        let vm = makeVM(mock, store: InMemorySecuredSessionStore())
        await vm.authorize()
        if case .failed(let msg) = vm.phase {
            XCTAssertTrue(msg.contains("refreshing"))
        } else { XCTFail("expected .failed") }
    }

    func testPageExpired404() async {
        let mock = MockServiceAccessClient()
        mock.nextError = ServiceAccessError.knockPageExpired
        let vm = makeVM(mock, store: InMemorySecuredSessionStore())
        await vm.authorize()
        if case .failed(let msg) = vm.phase {
            XCTAssertTrue(msg.contains("expired"))
        } else { XCTFail("expected .failed") }
    }

    func testMalformedRejectedBeforeNetwork() async {
        let mock = MockServiceAccessClient()
        let vm = makeVM(mock, store: InMemorySecuredSessionStore(), ref: "")
        await vm.authorize()
        if case .failed = vm.phase {} else { XCTFail("expected .failed") }
        XCTAssertTrue(mock.authorizeKnockCalls.isEmpty)
    }

    func testServiceUrlFallsBackToApexWhenSvcEmpty() {
        let vm = KnockAuthorizeViewModel(
            client: MockServiceAccessClient(),
            store: InMemorySecuredSessionStore(),
            serverDomain: server, svc: "", serviceRef: ref, pageId: page,
            aid: { _ in self.aid() })
        XCTAssertEqual(vm.serviceUrl, "https://\(server)")
    }
}
