import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore
@testable import FlagshipUI

/// The iOS app-copy order against THE reference,
/// `packages/protocol/test-vectors/app-copy/vectors.json`, loaded from disk.
final class AppCopyVectorTests: XCTestCase {

    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/app-copy/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    func test_canonicalBytesAndPinnedSignatures() throws {
        let v = try vectors()
        let umk = try XCTUnwrap(HexUtil.decode(v["umkSeedHex"] as! String))
        let seed = try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: umk))
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(HexUtil.encode(key.publicKey.rawRepresentation), v["pub"] as? String)
        let all = try XCTUnwrap(v["cases"] as? [[String: Any]])
        XCTAssertFalse(all.isEmpty)
        for c in all {
            let grant = AppCopyGrant(
                sourceServer: c["sourceServer"] as! String, targetServer: c["targetServer"] as! String,
                serviceId: c["serviceId"] as! String, issuedAt: (c["issuedAt"] as! NSNumber).int64Value)
            XCTAssertEqual(String(data: grant.canonicalBytes(), encoding: .utf8), c["canonical"] as? String)
            let pinned = try XCTUnwrap(HexUtil.decode(c["signature"] as! String))
            XCTAssertTrue(key.publicKey.isValidSignature(pinned, for: grant.canonicalBytes()))
            let req = try AppCopyOrder.signed(sourceServer: grant.sourceServer, targetServer: grant.targetServer,
                                              serviceId: grant.serviceId, key: key, issuedAt: grant.issuedAt)
            XCTAssertEqual(req.grant, grant)
            XCTAssertTrue(key.publicKey.isValidSignature(HexUtil.decode(req.signature)!, for: grant.canonicalBytes()))
            let tampered = [
                AppCopyGrant(sourceServer: "other.harry.flagship.services", targetServer: grant.targetServer,
                             serviceId: grant.serviceId, issuedAt: grant.issuedAt),
                AppCopyGrant(sourceServer: grant.sourceServer, targetServer: "other.harry.flagship.services",
                             serviceId: grant.serviceId, issuedAt: grant.issuedAt),
                AppCopyGrant(sourceServer: grant.targetServer, targetServer: grant.sourceServer,
                             serviceId: grant.serviceId, issuedAt: grant.issuedAt),
                AppCopyGrant(sourceServer: grant.sourceServer, targetServer: grant.targetServer,
                             serviceId: grant.serviceId + "x", issuedAt: grant.issuedAt),
                AppCopyGrant(sourceServer: grant.sourceServer, targetServer: grant.targetServer,
                             serviceId: grant.serviceId, issuedAt: grant.issuedAt + 1),
            ]
            for t in tampered {
                XCTAssertFalse(key.publicKey.isValidSignature(pinned, for: t.canonicalBytes()),
                               String(data: t.canonicalBytes(), encoding: .utf8) ?? "")
            }
        }
    }

    func test_requestBodyShape() throws {
        let req = AppCopyRequest(grant: AppCopyGrant(sourceServer: "a.u.flagship.services",
                                                     targetServer: "b.u.flagship.services",
                                                     serviceId: "u--notes", issuedAt: 7),
                                 signature: "ab")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["grant", "signature"])
        let g = try XCTUnwrap(body["grant"] as? [String: Any])
        XCTAssertEqual(g.keys.sorted(), ["issuedAt", "serviceId", "sourceServer", "targetServer"])
        XCTAssertEqual(g["issuedAt"] as? Int, 7)
    }

    func test_copiesAndCopyingDecode() throws {
        let copies = try JSONDecoder().decode(AppCopiesResponse.self, from: Data("""
        {"copies":[{"copyId":"c1","serviceId":"u--notes","appName":"Notes","sourceServer":"a.u.flagship.services",
          "state":"copying","progress":0.4,"startedAt":5},
         {"copyId":"c2","serviceId":"u--wiki","appName":"Wiki","sourceServer":"a.u.flagship.services",
          "state":"failed","reason":"disk full","startedAt":6}]}
        """.utf8))
        XCTAssertEqual(copies.copies.map(\.state), ["copying", "failed"])
        XCTAssertEqual(copies.copies.first?.progress, 0.4)
        XCTAssertTrue(copies.copies[0].isUnderway)
        XCTAssertFalse(copies.copies[1].isUnderway)
        let app = try JSONDecoder().decode(AppSummary.self, from: Data("""
        {"serviceId":"u--notes","creator":"u","slug":"notes","urlLabel":"notes","url":"https://notes.b/",
         "status":"stopped","installedAt":1,"copying":{"state":"installing","progress":90}}
        """.utf8))
        XCTAssertEqual(app.copying, AppCopying(state: "installing", progress: 90))
        XCTAssertEqual(AppPlacementCopy.copying(state: "copying", progress: 0.4), "Copying… 40%")
        XCTAssertEqual(AppPlacementCopy.copying(state: "installing", progress: 90), "Installing… 90%")
        XCTAssertEqual(AppPlacementCopy.copying(state: "copying", progress: nil), "Copying…")
    }
}

/// §1: the leader is the default target.
final class AppPlacementLeaderTests: XCTestCase {

    private func pods(_ aStatus: PodInfo.Status = .online, _ bStatus: PodInfo.Status = .online) -> [PodInfo] {
        [PodInfo(podId: "a", name: "A", fqdn: "a.u.flagship.services", status: aStatus),
         PodInfo(podId: "b", name: "B", fqdn: "b.u.flagship.services", status: bStatus)]
    }

    func test_setLeader_alsoMakesItCurrent() {
        let s = AppState(isPaired: true, currentUser: "u", pods: pods(), leaderPodId: "a", currentPodId: "a")
        s.setLeader("b")
        XCTAssertEqual(s.leaderPodId, "b")
        XCTAssertEqual(s.currentPodId, "b")
        XCTAssertEqual(s.currentPod?.podId, "b")
        XCTAssertEqual(s.sessionPod?.podId, "b")
    }

    func test_currentPod_prefersOnlineLeaderWithSessionOverAStaleChoice() {
        // The old box is still `current` but has gone offline.
        let s = AppState(isPaired: true, currentUser: "u", pods: pods(.offline, .online),
                         leaderPodId: "b", currentPodId: "a")
        s.sessionPodIds = [PodInfo.podId(forFqdn: "b.u.flagship.services")]
        XCTAssertEqual(s.currentPod?.podId, "b")
    }

    func test_currentPod_aChosenLiveServerWithASessionStays() {
        let s = AppState(isPaired: true, currentUser: "u", pods: pods(), leaderPodId: "a", currentPodId: "b")
        s.sessionPodIds = [PodInfo.podId(forFqdn: "a.u.flagship.services"),
                           PodInfo.podId(forFqdn: "b.u.flagship.services")]
        XCTAssertEqual(s.currentPod?.podId, "b")
    }

    func test_currentPod_aChoiceWithoutASessionFallsBackToTheLiveLeader() {
        let s = AppState(isPaired: true, currentUser: "u", pods: pods(), leaderPodId: "a", currentPodId: "b")
        s.sessionPodIds = [PodInfo.podId(forFqdn: "a.u.flagship.services")]
        XCTAssertEqual(s.currentPod?.podId, "a")
    }

    func test_currentPod_leaderWithoutASessionDoesNotWin() {
        let s = AppState(isPaired: true, currentUser: "u", pods: pods(), leaderPodId: "a", currentPodId: "b")
        s.sessionPodIds = [PodInfo.podId(forFqdn: "b.u.flagship.services")]
        XCTAssertEqual(s.currentPod?.podId, "b")
    }
}

/// §2: choosing where a new app runs.
@MainActor
final class CreationTargetTests: XCTestCase {

    private let pods = [
        PodInfo(podId: "a", name: "Home", fqdn: "home.u.flagship.services", status: .online),
        PodInfo(podId: "b", name: "Leticia", fqdn: "leticia.u.flagship.services", status: .online),
        PodInfo(podId: "p", name: "Pending", fqdn: "pending.u.flagship.services", status: .pending),
    ]

    func test_defaultsToTheLeader() {
        let t = CreationTarget(pods: pods, leaderPodId: "b")
        XCTAssertEqual(t.selectedFqdn, "leticia.u.flagship.services")
        XCTAssertEqual(t.selectedName, "Leticia")
        XCTAssertTrue(t.showsPicker)
        XCTAssertEqual(t.choices.map(\.podId), ["a", "b"], "a pending server isn't a choice")
        t.select(pods[0])
        XCTAssertEqual(t.selectedFqdn, "home.u.flagship.services")
    }

    func test_offlineLeaderFallsBackToAnOnlineServer() {
        var p = pods
        p[1] = PodInfo(podId: "b", name: "Leticia", fqdn: "leticia.u.flagship.services", status: .offline)
        XCTAssertEqual(CreationTarget(pods: p, leaderPodId: "b").selectedFqdn, "home.u.flagship.services")
    }

    func test_pinnedFromAServerPageIsNotAskedAgain() {
        let t = CreationTarget(pods: pods, leaderPodId: "b", pinnedFqdn: "Home.u.flagship.services")
        XCTAssertTrue(t.isPinned)
        XCTAssertFalse(t.showsPicker)
        XCTAssertEqual(t.selectedFqdn, "home.u.flagship.services")
        t.select(pods[1])
        XCTAssertEqual(t.selectedFqdn, "home.u.flagship.services", "a pinned target can't change")
        t.refresh(pods: pods, leaderPodId: "b")
        XCTAssertEqual(t.selectedFqdn, "home.u.flagship.services")
    }

    func test_oneServerShowsNoPicker() {
        XCTAssertFalse(CreationTarget(pods: [pods[0]], leaderPodId: "a").showsPicker)
    }

    func test_theCreationRequestGoesToTheChosenBox() async throws {
        let home = MockScreensClient(); home.simulatedLatency = 0
        let leticia = MockScreensClient(); leticia.simulatedLatency = 0
        let factory = PodScreensClientFactory { fqdn in fqdn.hasPrefix("leticia") ? leticia : home }
        let t = CreationTarget(pods: pods, leaderPodId: "a")
        t.select(pods[1])
        let client = await factory.client(forFqdn: try XCTUnwrap(t.selectedFqdn))
        _ = try await client.buildMcpCreate(BuildMcpRequest())
        XCTAssertEqual(leticia.buildMcpCreateCalls.count, 1)
        XCTAssertEqual(home.buildMcpCreateCalls.count, 0)
    }

    func test_liveFactoryBindsTheBoxAndItsOwnToken() async {
        let store = SessionStore(defaults: UserDefaults(suiteName: "placement-\(UUID().uuidString)")!)
        await store.setSessionToken("tok-b", forPodId: PodInfo.podId(forFqdn: "leticia.u.flagship.services"))
        let factory = PodScreensClientFactory.live(urlSession: .shared, store: store)
        let bound = await factory.client(forFqdn: "Leticia.u.flagship.services")
        let domain = await bound.boxDomain()
        XCTAssertEqual(domain, "leticia.u.flagship.services")
        let unpaired = await factory.client(forFqdn: "home.u.flagship.services")
        do {
            _ = try await unpaired.appsList()
            XCTFail("no token for this box: nothing is sent")
        } catch ScreensClientError.noSessionToken {
        } catch {
            XCTFail("unexpected \(error)")
        }
    }
}

/// §3–§5: a server's apps and an app's "Runs on".
@MainActor
final class AppRunsOnTests: XCTestCase {

    private let serviceId = "u--notes"
    private let homeFqdn = "home.bright-maple.flagship.services"
    private let leticiaFqdn = "leticia.bright-maple.flagship.services"
    private let officeFqdn = "office.bright-maple.flagship.services"
    private let key = Curve25519.Signing.PrivateKey()

    private var pods: [PodInfo] {
        [PodInfo(podId: "h", name: "Home", fqdn: homeFqdn, status: .online),
         PodInfo(podId: "l", name: "Leticia", fqdn: leticiaFqdn, status: .online),
         PodInfo(podId: "o", name: "Office", fqdn: officeFqdn, status: .online)]
    }

    private func app(_ id: String, copying: AppCopying? = nil) -> AppSummary {
        AppSummary(serviceId: id, creator: "u", slug: ServicesSlug.slug(of: id), urlLabel: ServicesSlug.slug(of: id),
                   summary: nil, url: "https://\(ServicesSlug.slug(of: id)).x/", status: "running", version: nil,
                   installedAt: 1, copying: copying)
    }

    private func box(_ context: String, apps: [AppSummary]) -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        c.podContext = context
        c.appsListFixture = AppsListResponse(apps: apps)
        return c
    }

    private struct Boxes {
        let home: MockScreensClient
        let leticia: MockScreensClient
        let office: MockScreensClient
        var factory: PodScreensClientFactory {
            let (h, l, o) = (home, leticia, office)
            return PodScreensClientFactory { fqdn in
                fqdn.hasPrefix("home") ? h : fqdn.hasPrefix("leticia") ? l : o
            }
        }
    }

    private func controller(_ boxes: Boxes, uninstall: MockServiceUninstallClient = MockServiceUninstallClient(),
                            page: String? = nil) -> AppRunsOnController {
        let key = self.key
        return AppRunsOnController(
            serviceId: serviceId, appName: "Notes", pods: pods, pageFqdn: page ?? homeFqdn,
            clients: boxes.factory, uninstallClient: uninstall,
            signer: { _ in key }, irkSigner: { _ in key })
    }

    func test_runsOnTicksExactlyTheServersThatHaveTheApp() async {
        let boxes = Boxes(home: box("home", apps: [app(serviceId)]),
                          leticia: box("leticia", apps: [app("u--wiki")]),
                          office: box("office", apps: []))
        boxes.office.appsListError = ScreensClientError.http(status: 503, message: "")
        let c = controller(boxes)
        XCTAssertTrue(c.rows.allSatisfy { $0.presence == .checking })
        await c.load()
        XCTAssertEqual(c.row(homeFqdn)?.presence, .installed)
        XCTAssertEqual(c.row(leticiaFqdn)?.presence, .absent)
        XCTAssertEqual(c.row(officeFqdn)?.presence, .unknown(AppPlacementCopy.unknown))
        XCTAssertEqual(c.rows.filter(\.isTicked).map(\.fqdn), [homeFqdn], "unknown is never ticked")
    }

    func test_aServerWithoutASessionIsUnknown() async {
        let boxes = Boxes(home: box("home", apps: [app(serviceId)]), leticia: box("leticia", apps: []),
                          office: box("office", apps: []))
        boxes.leticia.appsListError = ScreensClientError.noSessionToken
        let c = controller(boxes)
        await c.load()
        XCTAssertEqual(c.row(leticiaFqdn)?.presence, .unknown(AppPlacementCopy.notPaired))
        let refused = await c.tick(leticiaFqdn)
        XCTAssertFalse(refused, "an unknown server can't be ticked")
        XCTAssertTrue(boxes.leticia.serviceCopyCalls.isEmpty)
    }

    func test_aCopyInProgressShowsAsCopying() async {
        let boxes = Boxes(home: box("home", apps: [app(serviceId)]),
                          leticia: box("leticia", apps: [app(serviceId, copying: AppCopying(state: "copying", progress: 0.3))]),
                          office: box("office", apps: []))
        let c = controller(boxes)
        await c.load()
        XCTAssertEqual(c.row(leticiaFqdn)?.presence, .copying(state: "copying", progress: 0.3))
        XCTAssertTrue(c.row(leticiaFqdn)?.isTicked ?? false)
        XCTAssertEqual(c.installedCount, 1, "a copy underway is not a finished copy")
        XCTAssertNotNil(c.untickRefusal(homeFqdn), "the only finished copy can't be unticked")
    }

    func test_tickSignsTheCopyAndPostsItToTheTarget() async throws {
        let boxes = Boxes(home: box("home", apps: [app(serviceId)]), leticia: box("leticia", apps: []),
                          office: box("office", apps: []))
        boxes.leticia.mockCopyVerifyKey = key.publicKey.rawRepresentation
        let c = controller(boxes)
        await c.load()
        let ok = await c.tick(leticiaFqdn)
        XCTAssertTrue(ok, c.message ?? "")
        let sent = try XCTUnwrap(boxes.leticia.serviceCopyCalls.first)
        XCTAssertEqual(boxes.leticia.serviceCopyCalls.count, 1)
        XCTAssertEqual(sent.grant.sourceServer, homeFqdn)
        XCTAssertEqual(sent.grant.targetServer, leticiaFqdn)
        XCTAssertEqual(sent.grant.serviceId, serviceId)
        XCTAssertTrue(key.publicKey.isValidSignature(try XCTUnwrap(HexUtil.decode(sent.signature)),
                                                     for: sent.grant.canonicalBytes()))
        XCTAssertTrue(boxes.home.serviceCopyCalls.isEmpty, "the order goes to the target, not the source")
        XCTAssertEqual(c.row(leticiaFqdn)?.presence, .copying(state: "copying", progress: 0))
        XCTAssertTrue(c.hasCopying)
    }

    func test_copyingFinishesThroughPolling() async {
        let boxes = Boxes(home: box("home", apps: [app(serviceId)]), leticia: box("leticia", apps: []),
                          office: box("office", apps: []))
        let c = controller(boxes)
        await c.load()
        _ = await c.tick(leticiaFqdn)
        let copyId = boxes.leticia.mockCopies.first?.copyId ?? ""
        boxes.leticia.mockCopies = [AppCopyEntry(copyId: copyId, serviceId: serviceId, appName: "Notes",
                                                 sourceServer: homeFqdn, state: "installing", progress: 0.8, startedAt: 1)]
        await c.pollCopies()
        XCTAssertEqual(c.row(leticiaFqdn)?.presence, .copying(state: "installing", progress: 0.8))
        boxes.leticia.mockCopies = [AppCopyEntry(copyId: copyId, serviceId: serviceId, appName: "Notes",
                                                 sourceServer: homeFqdn, state: "done", startedAt: 1)]
        boxes.leticia.appsListFixture = AppsListResponse(apps: [app(serviceId)])
        await c.pollCopies()
        XCTAssertEqual(c.row(leticiaFqdn)?.presence, .installed)
        XCTAssertFalse(c.hasCopying)
    }

    func test_aFailedCopyUnticksWithTheReason() async {
        let boxes = Boxes(home: box("home", apps: [app(serviceId)]), leticia: box("leticia", apps: []),
                          office: box("office", apps: []))
        let c = controller(boxes)
        await c.load()
        _ = await c.tick(leticiaFqdn)
        boxes.leticia.mockCopies = [AppCopyEntry(copyId: "x", serviceId: serviceId, appName: "Notes",
                                                 sourceServer: homeFqdn, state: "failed", reason: "disk full",
                                                 startedAt: 1)]
        await c.pollCopies()
        XCTAssertEqual(c.row(leticiaFqdn)?.presence, .absent)
        XCTAssertEqual(c.message, "Couldn't copy Notes to Leticia: disk full")
    }

    func test_anOlderBoxThatDoesNotKnowCopiesSaysItNeedsAnUpdate() async {
        let boxes = Boxes(home: box("home", apps: [app(serviceId)]), leticia: box("leticia", apps: []),
                          office: box("office", apps: []))
        boxes.leticia.serviceCopyError = ScreensClientError.http(status: 404, message: "Not Found")
        let c = controller(boxes)
        await c.load()
        let ok = await c.tick(leticiaFqdn)
        XCTAssertFalse(ok)
        XCTAssertEqual(c.message, "This server needs an update to receive copies.")
        XCTAssertEqual(c.row(leticiaFqdn)?.presence, .absent)
    }

    func test_refusalsReadPlainly() {
        func msg(_ status: Int, _ body: String = "") -> String {
            AppPlacementCopy.copyError(ScreensClientError.http(status: status, message: body), app: "Notes", server: "Leticia")
        }
        XCTAssertEqual(msg(409), "Notes is already on Leticia, or a copy there is already underway.")
        XCTAssertEqual(msg(403, #"{"error":"the order is stale: sign it again"}"#),
                       "Your phone's clock is too far off from the server's. Check the date and time, then try again.")
        XCTAssertEqual(msg(403, #"{"error":"the order is for a different server"}"#),
                       "This copy was signed for a different server. Reload the page and try again.")
        XCTAssertEqual(msg(403, #"{"error":"the source isn't one of this account's servers"}"#),
                       "The server to copy from isn't one of your servers any more. Reload the page and try again.")
        XCTAssertEqual(msg(403, #"{"error":"companion sessions can't copy apps: open your owner app"}"#),
                       "Only the account owner's phone can copy apps.")
        XCTAssertEqual(msg(403, #"{"error":"invalid signature"}"#),
                       "Leticia didn't accept your signature. Only the account owner's phone can copy apps.")
        XCTAssertEqual(AppPlacementCopy.copyError(ScreensClientError.notImplemented("app copy"), app: "Notes", server: "Leticia"),
                       AppPlacementCopy.needsUpdate)
    }

    func test_a409FromTheTargetIsShown() async {
        let boxes = Boxes(home: box("home", apps: [app(serviceId)]), leticia: box("leticia", apps: []),
                          office: box("office", apps: []))
        boxes.leticia.serviceCopyError = ScreensClientError.http(status: 409, message: #"{"error":"the app is already being copied here"}"#)
        let c = controller(boxes)
        await c.load()
        _ = await c.tick(leticiaFqdn)
        XCTAssertEqual(c.message, "Notes is already on Leticia, or a copy there is already underway.")
    }

    func test_untickSendsTheSignedUninstallToThatServer() async throws {
        let uninstall = MockServiceUninstallClient()
        let boxes = Boxes(home: box("home", apps: [app(serviceId)]), leticia: box("leticia", apps: [app(serviceId)]),
                          office: box("office", apps: []))
        let c = controller(boxes, uninstall: uninstall)
        await c.load()
        XCTAssertNil(c.untickRefusal(leticiaFqdn))
        let ok = await c.untick(leticiaFqdn)
        XCTAssertTrue(ok, c.message ?? "")
        let sent = try XCTUnwrap(uninstall.sent.first)
        XCTAssertEqual(uninstall.sent.count, 1)
        XCTAssertEqual(sent.serverDomain, leticiaFqdn)
        XCTAssertEqual(sent.serviceId, serviceId)
        XCTAssertEqual(sent.request["serverId"], leticiaFqdn)
        XCTAssertEqual(sent.request["slug"], "notes")
        let order = UninstallServiceOrder(serverId: leticiaFqdn, creator: "u", slug: "notes",
                                          issuedAt: Int64(sent.request["issuedAt"] ?? "") ?? 0)
        XCTAssertTrue(key.publicKey.isValidSignature(try XCTUnwrap(HexUtil.decode(sent.signatureHex)),
                                                     for: order.canonicalBytes()))
        XCTAssertEqual(c.row(leticiaFqdn)?.presence, .absent)
        XCTAssertFalse(c.removedFromPage)
    }

    func test_unticksThePageServerFlagsThePageGone() async {
        let uninstall = MockServiceUninstallClient()
        let boxes = Boxes(home: box("home", apps: [app(serviceId)]), leticia: box("leticia", apps: [app(serviceId)]),
                          office: box("office", apps: []))
        let c = controller(boxes, uninstall: uninstall, page: homeFqdn)
        await c.load()
        _ = await c.untick(homeFqdn)
        XCTAssertTrue(c.removedFromPage)
    }

    func test_theLastCopyCannotBeUnticked() async {
        let uninstall = MockServiceUninstallClient()
        let boxes = Boxes(home: box("home", apps: [app(serviceId)]), leticia: box("leticia", apps: []),
                          office: box("office", apps: []))
        let c = controller(boxes, uninstall: uninstall)
        await c.load()
        XCTAssertEqual(c.untickRefusal(homeFqdn), AppPlacementCopy.lastCopy("Notes"))
        let ok = await c.untick(homeFqdn)
        XCTAssertFalse(ok)
        XCTAssertEqual(c.message, AppPlacementCopy.lastCopy("Notes"))
        XCTAssertTrue(uninstall.sent.isEmpty)
        XCTAssertEqual(c.row(homeFqdn)?.presence, .installed)
    }

    func test_anAlreadyUsedOrderIsSignedAgainOnce() async {
        let boxes = Boxes(home: box("home", apps: [app(serviceId)]), leticia: box("leticia", apps: []),
                          office: box("office", apps: []))
        boxes.leticia.serviceCopyError = ScreensClientError.http(
            status: 409, message: #"{"error":"this signed order was already used: sign it again"}"#)
        let c = controller(boxes)
        await c.load()
        let ok = await c.tick(leticiaFqdn)
        XCTAssertTrue(ok, c.message ?? "")
        XCTAssertEqual(boxes.leticia.serviceCopyCalls.count, 2)
        XCTAssertLessThan(boxes.leticia.serviceCopyCalls[0].grant.issuedAt,
                          boxes.leticia.serviceCopyCalls[1].grant.issuedAt)
    }

    func test_aFinishedCopyNamesTheEnvValuesStillToSet() async {
        let boxes = Boxes(home: box("home", apps: [app(serviceId)]), leticia: box("leticia", apps: []),
                          office: box("office", apps: []))
        let c = controller(boxes)
        await c.load()
        _ = await c.tick(leticiaFqdn)
        boxes.leticia.mockCopies = [AppCopyEntry(copyId: "x", serviceId: serviceId, appName: "Notes",
                                                 sourceServer: homeFqdn, state: "done", startedAt: 1,
                                                 pendingEnv: ["STRIPE_KEY"])]
        boxes.leticia.appsListFixture = AppsListResponse(apps: [app(serviceId)])
        await c.pollCopies()
        XCTAssertEqual(c.row(leticiaFqdn)?.presence, .installed)
        XCTAssertEqual(c.message, "Notes is on Leticia. Set this value there under Configure environment: STRIPE_KEY.")
    }

    // MARK: §3 the server page

    func test_serverPageListsItsAppsAndGreysACopy() async {
        let leticia = box("leticia", apps: [app("u--wiki")])
        leticia.mockCopies = [AppCopyEntry(copyId: "c1", serviceId: serviceId, appName: "Notes",
                                           sourceServer: homeFqdn, state: "copying", progress: 0.4, startedAt: 1)]
        let page = ServerAppsController(serverFqdn: leticiaFqdn, clients: .shared(leticia))
        await page.load()
        XCTAssertEqual(page.rows.map(\.serviceId), ["u--wiki", serviceId])
        XCTAssertFalse(page.rows[0].isCopying)
        XCTAssertEqual(page.rows[0].address, "wiki.x")
        XCTAssertEqual(page.rows[1].name, "Notes")
        XCTAssertEqual(page.rows[1].copying, AppCopying(state: "copying", progress: 0.4))
        XCTAssertTrue(page.hasCopying)

        // The copy lands: the apps list now has it, the copies list says done.
        leticia.mockCopies = [AppCopyEntry(copyId: "c1", serviceId: serviceId, appName: "Notes",
                                           sourceServer: homeFqdn, state: "done", startedAt: 1)]
        leticia.appsListFixture = AppsListResponse(apps: [app("u--wiki"), app(serviceId)])
        await page.pollCopies()
        XCTAssertEqual(page.rows.map(\.serviceId), ["u--wiki", serviceId])
        XCTAssertFalse(page.hasCopying)
    }

    func test_serverPageUsesTheAppsListCopyingOnAnOlderCopiesEndpoint() async {
        var copyingRow = app(serviceId, copying: AppCopying(state: "installing", progress: nil))
        copyingRow.name = "My Notes"
        let leticia = box("leticia", apps: [copyingRow])
        leticia.serviceCopiesError = ScreensClientError.http(status: 404, message: "")
        let page = ServerAppsController(serverFqdn: leticiaFqdn, clients: .shared(leticia))
        await page.load()
        XCTAssertEqual(page.rows.first?.copying, AppCopying(state: "installing", progress: nil))
        XCTAssertEqual(page.rows.first?.name, "My Notes", "a copy underway carries its own name")
    }

    func test_serverPageReportsAFailedCopy() async {
        let leticia = box("leticia", apps: [])
        leticia.mockCopies = [AppCopyEntry(copyId: "c1", serviceId: serviceId, appName: "Notes",
                                           sourceServer: homeFqdn, state: "copying", startedAt: 1)]
        let page = ServerAppsController(serverFqdn: leticiaFqdn, clients: .shared(leticia))
        await page.load()
        leticia.mockCopies = [AppCopyEntry(copyId: "c1", serviceId: serviceId, appName: "Notes",
                                           sourceServer: homeFqdn, state: "failed", reason: "no space", startedAt: 1)]
        await page.pollCopies()
        XCTAssertTrue(page.rows.isEmpty)
        XCTAssertEqual(page.failureNote, "Couldn't copy Notes to \(leticiaFqdn): no space")
    }

    func test_pollingStopsWhenNothingIsCopying() async {
        let leticia = box("leticia", apps: [app("u--wiki")])
        let page = ServerAppsController(serverFqdn: leticiaFqdn, clients: .shared(leticia))
        await page.load()
        let before = leticia.serviceCopiesCalls
        await page.pollWhileCopying(interval: .milliseconds(1))
        XCTAssertEqual(leticia.serviceCopiesCalls, before, "no copy underway: no polling")
    }
}
