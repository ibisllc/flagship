import XCTest
import CryptoKit
@testable import Flagship
@testable import FlagshipAPI
@testable import FlagshipUI
import FlagshipCore

/// Suggested access lists (drafts, docs/ai-privacy-and-staging.md §3a) on
/// iOS: the card on the app's page, the list badge, and the alert's
/// Review / Not now.
@MainActor
final class AppAccessDraftTests: XCTestCase {

    private let plants = "bright-maple--plants"

    private func makeClient(pod: String = "home") -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        c.podContext = pod
        return c
    }

    private func draft(createdAt: Int64 = 1_760_000_000_000) -> AppAccessDraft {
        let list = "allow api.open-meteo.com   # forecasts\nallow tile.openstreetmap.org\n" + AppAccessList.defaultList
        return AppAccessDraft(list: list, listSha256: AppAccessList.sha256Hex(list),
                              hosts: [AppAccessDraftHost(host: "api.open-meteo.com", why: "forecasts"),
                                      AppAccessDraftHost(host: "tile.openstreetmap.org")],
                              createdAt: createdAt)
    }

    // MARK: - Wire

    func test_decodesDraftsFromTheBox() throws {
        let state = try JSONDecoder().decode(AppAccessState.self, from: Data(#"""
            {"list":"","listSha256":"e3","pending":[],"draft":{"list":"allow a.com   # maps\n","listSha256":"ab",
             "hosts":[{"host":"a.com","why":"maps"},{"host":"b.com","why":"  "}],"createdAt":7}}
            """#.utf8))
        XCTAssertEqual(state.draft?.hosts, [AppAccessDraftHost(host: "a.com", why: "maps"), AppAccessDraftHost(host: "b.com")])
        XCTAssertEqual(state.draft?.createdAt, 7)
        let none = try JSONDecoder().decode(AppAccessState.self, from: Data(#"{"list":"","pending":[],"draft":null}"#.utf8))
        XCTAssertNil(none.draft)
        let older = try JSONDecoder().decode(AppAccessState.self, from: Data(#"{"list":"","pending":[]}"#.utf8))
        XCTAssertNil(older.draft)

        let summary = try JSONDecoder().decode(AppAccessSummary.self, from: Data(#"{"rules":1,"pending":0,"draft":true}"#.utf8))
        XCTAssertTrue(summary.draft)
        XCTAssertFalse(try JSONDecoder().decode(AppAccessSummary.self, from: Data(#"{"rules":1,"pending":0}"#.utf8)).draft)

        // One array on the wire: drafts and single hosts, plus a kind this
        // build doesn't know, which is skipped rather than failing the list.
        let reqs = try JSONDecoder().decode(AppAccessRequestsResponse.self, from: Data(#"""
            {"requests":[
              {"serviceId":"a--w","appName":"Weather","kind":"draft","hosts":[{"host":"x.com","why":"data"}],"createdAt":9},
              {"serviceId":"a--w","appName":"Weather","host":"y.com","source":"attempt","attempts":1,"firstSeen":1,"lastSeen":2},
              {"serviceId":"a--w","kind":"something-new"},
              {"serviceId":"a--w","appName":"Weather","source":"attempt"},
              {"serviceId":"a--w","kind":"draft","hosts":"not-a-list"},
              "garbage",
              {"serviceId":"a--w","appName":"Weather","host":"z.com"}
            ]}
            """#.utf8))
        XCTAssertEqual(reqs.drafts, [AppAccessDraftEntry(serviceId: "a--w", appName: "Weather",
                                                         hosts: [AppAccessDraftHost(host: "x.com", why: "data")], createdAt: 9)])
        // A malformed entry (no host, a bad draft, not an object) is dropped
        // on its own; the rest of the list still arrives.
        XCTAssertEqual(reqs.requests.map(\.host), ["y.com", "z.com"])
        // Round trip keeps the kind.
        let again = try JSONDecoder().decode(AppAccessRequestsResponse.self, from: JSONEncoder().encode(reqs))
        XCTAssertEqual(again, reqs)
    }

    func test_listBadge() {
        XCTAssertEqual(AppAccessCopy.listBadge(access: AppAccessSummary(rules: 0, pending: 0, draft: true), egress: nil), .draft)
        XCTAssertEqual(AppAccessCopy.listBadge(access: AppAccessSummary(rules: 0, pending: 2, draft: true), egress: nil), .draft)
        XCTAssertEqual(AppAccessCopy.listBadge(access: AppAccessSummary(rules: 0, pending: 2), egress: nil), .pending)
        XCTAssertNil(AppAccessCopy.listBadge(access: AppAccessSummary(rules: 3, pending: 0), egress: nil))
        XCTAssertNil(AppAccessCopy.listBadge(access: nil, egress: nil))
    }

    func test_appsListCarriesTheDraftFlag() async throws {
        let client = makeClient()
        client.mockAccessDrafts[plants] = draft()
        let apps = try await client.appsList().apps
        XCTAssertEqual(apps.first { $0.serviceId == plants }?.access?.draft, true)
        XCTAssertEqual(apps.first { $0.serviceId == "bright-maple--wiki" }?.access?.draft, false)
    }

    // MARK: - The app's page

    private func controller(_ client: MockScreensClient, key: Curve25519.Signing.PrivateKey,
                            canChange: Bool = true) -> AppAccessController {
        AppAccessController(serviceId: plants, appName: "Plants", client: client,
                            serverDomain: "home.bright-maple.flagship.services", canChange: canChange,
                            signer: { _ in key })
    }

    func test_card_showsOnlyWhileADraftWaits() async {
        let client = makeClient()
        let c = controller(client, key: Curve25519.Signing.PrivateKey())
        await c.load()
        XCTAssertNil(c.draft)
        XCTAssertNil(c.makeDraftEditor())

        client.mockAccessDrafts[plants] = draft()
        await c.load()
        XCTAssertEqual(c.draft?.hosts.map(\.host), ["api.open-meteo.com", "tile.openstreetmap.org"])
        XCTAssertEqual(c.draft?.hosts.first?.why, "forecasts")
    }

    func test_review_prefillsTheDraft_andSaveSignsIt_whichClearsTheDraft() async throws {
        let client = makeClient(pod: "home2")
        client.mockAccessDrafts[plants] = draft()
        let key = Curve25519.Signing.PrivateKey()
        client.mockAccessVerifyKey = key.publicKey.rawRepresentation
        let c = controller(client, key: key)
        await c.load()
        let editor = try XCTUnwrap(c.makeDraftEditor())
        XCTAssertEqual(editor.text, draft().list)
        XCTAssertEqual(editor.note, AppAccessCopy.draftEditorNote)
        XCTAssertTrue(editor.canSave)

        // The owner may edit before saving.
        editor.text = "allow api.open-meteo.com   # forecasts\n" + AppAccessList.defaultList
        let saved = await editor.save()
        XCTAssertTrue(saved, editor.errorMessage ?? "")
        let call = try XCTUnwrap(client.serviceAccessSetCalls.last)
        XCTAssertEqual(call.req.list, AppAccessList.normalize(editor.text))
        // The grant names the box the client talks to, never the fallback.
        XCTAssertEqual(call.req.grant.serverDomain, "home2.bright-maple.flagship.services")
        XCTAssertTrue(key.publicKey.isValidSignature(HexUtil.decode(call.req.signature)!, for: call.req.grant.canonicalBytes()))
        XCTAssertNil(c.draft)
        XCTAssertNil(client.mockAccessDrafts[plants])
        XCTAssertEqual(c.ruleCount, 1)
    }

    func test_dismiss_isUnsignedAndClearsTheCard() async {
        let client = makeClient()
        client.mockAccessDrafts[plants] = draft()
        var prompts = 0
        let c = AppAccessController(serviceId: plants, appName: "Plants", client: client,
                                    serverDomain: nil, signer: { _ in prompts += 1; return Curve25519.Signing.PrivateKey() })
        await c.load()
        let ok = await c.dismissDraft()
        XCTAssertTrue(ok)
        XCTAssertEqual(client.serviceAccessDraftDismissCalls, [plants])
        XCTAssertEqual(prompts, 0, "Dismiss opens nothing, so it asks for no Face ID")
        XCTAssertTrue(client.serviceAccessSetCalls.isEmpty)
        XCTAssertNil(c.draft)
        // The list and the waiting hosts stay as they were.
        XCTAssertEqual(c.access?.list, AppAccessList.defaultList)
        XCTAssertEqual(c.pending.count, 2)
    }

    func test_ignoringAHostKeepsTheDraft() async {
        let client = makeClient()
        client.mockAccessDrafts[plants] = draft()
        let c = controller(client, key: Curve25519.Signing.PrivateKey())
        await c.load()
        _ = await c.ignore(host: "tile.openstreetmap.org")
        XCTAssertNotNil(c.draft)
    }

    func test_restricted_seesTheCardButCantAct() async {
        let client = makeClient()
        client.mockAccessDrafts[plants] = draft()
        let c = controller(client, key: Curve25519.Signing.PrivateKey(), canChange: false)
        await c.load()
        XCTAssertNotNil(c.draft)
        let dismissed = await c.dismissDraft()
        XCTAssertFalse(dismissed)
        XCTAssertTrue(client.serviceAccessDraftDismissCalls.isEmpty)
        XCTAssertEqual(c.makeDraftEditor()?.canSave, false)
    }

    // MARK: - The alert queue

    private func center(_ client: MockScreensClient, key: Curve25519.Signing.PrivateKey,
                        domain: String = "home.bright-maple.flagship.services",
                        defaults: UserDefaults? = nil, now: @escaping () -> Date = Date.init) -> AppAccessAlertCenter {
        AppAccessAlertCenter(boxes: { [.init(serverDomain: domain, client: client)] }, signer: { _ in key },
                             defaults: defaults ?? UserDefaults(suiteName: "draft-\(UUID().uuidString)")!, now: now)
    }

    func test_alert_listsTheDraftFirst() async {
        let client = makeClient()
        client.mockAccessDrafts[plants] = draft()
        let center = center(client, key: Curve25519.Signing.PrivateKey())
        await center.refresh()
        XCTAssertEqual(center.current?.draft?.serviceId, plants)
        XCTAssertEqual(center.current?.appName, "Plants")
        XCTAssertNil(center.current?.request)
        XCTAssertEqual(center.queue.compactMap(\.request?.host), ["api.open-meteo.com", "tile.openstreetmap.org"])
        XCTAssertEqual(AppAccessCopy.suggestsList(app: "Plants"), "Plants suggests an access list")
    }

    func test_alert_review_opensTheEditorWithTheDraft_andSaveAnswersIt() async throws {
        let client = makeClient()
        client.mockAccessDrafts[plants] = draft()
        let key = Curve25519.Signing.PrivateKey()
        client.mockAccessVerifyKey = key.publicKey.rawRepresentation
        let center = center(client, key: key)
        await center.refresh()
        await center.reviewDraft()
        let editor = try XCTUnwrap(center.editor)
        XCTAssertEqual(editor.text, draft().list)
        let saved = await editor.save()
        XCTAssertTrue(saved, editor.errorMessage ?? "")
        XCTAssertEqual(center.stage, .saved)
        XCTAssertEqual(client.serviceAccessSetCalls.last?.req.grant.serverDomain, "home.bright-maple.flagship.services")
        center.editorClosed()
        // Answered: the next item is a single host (now allowed by the list,
        // so it drops out on the next refresh).
        XCTAssertNil(center.editor)
        XCTAssertNil(center.current?.draft)
        await center.refresh()
        XCTAssertFalse(center.queue.contains { $0.draft != nil })
    }

    func test_alert_cancellingTheEditorGoesBackToTheQuestion() async throws {
        let client = makeClient()
        client.mockAccessDrafts[plants] = draft()
        let center = center(client, key: Curve25519.Signing.PrivateKey())
        await center.refresh()
        let id = try XCTUnwrap(center.current?.id)
        await center.reviewDraft()
        XCTAssertNotNil(center.editor)
        center.editorClosed()
        XCTAssertNil(center.editor)
        XCTAssertEqual(center.current?.id, id)
        XCTAssertEqual(center.stage, .ask)
        XCTAssertTrue(client.serviceAccessSetCalls.isEmpty)
    }

    func test_alert_notNow_quietsThisDraft_butANewerOneAsks() async {
        let client = makeClient()
        client.mockAccessDrafts[plants] = draft(createdAt: 1)
        let defaults = UserDefaults(suiteName: "draft-\(UUID().uuidString)")!
        let first = center(client, key: Curve25519.Signing.PrivateKey(), defaults: defaults)
        await first.refresh()
        XCTAssertNotNil(first.current?.draft)
        first.notNow()
        XCTAssertNil(first.current?.draft)
        XCTAssertNotNil(client.mockAccessDrafts[plants], "Not now leaves the draft on the box")

        let second = center(client, key: Curve25519.Signing.PrivateKey(), defaults: defaults)
        await second.refresh()
        XCTAssertFalse(second.queue.contains { $0.draft != nil })

        client.mockAccessDrafts[plants] = draft(createdAt: 2)
        let third = center(client, key: Curve25519.Signing.PrivateKey(), defaults: defaults)
        await third.refresh()
        XCTAssertEqual(third.current?.draft?.createdAt, 2)
    }

    func test_alert_reviewOfADraftAnsweredElsewhere() async {
        let client = makeClient()
        client.mockAccessDrafts[plants] = draft()
        let center = center(client, key: Curve25519.Signing.PrivateKey())
        await center.refresh()
        client.mockAccessDrafts[plants] = nil
        await center.reviewDraft()
        XCTAssertEqual(center.stage, .failed(AppAccessCopy.draftGone))
        XCTAssertNil(center.editor)
    }
}
