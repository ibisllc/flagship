import XCTest
@testable import FlagshipCore

final class DeepLinkTests: XCTestCase {

    // MARK: - flagship:// scheme

    // Back-compat: the legacy `unlock-approve(s)` hosts (old pushes /
    // cached Siri shortcuts) now land on the relay approval list — the
    // legacy plaintext flow is gone.
    func test_legacyUnlockApproveHosts_routeToSecretRequests() {
        XCTAssertEqual(DeepLink.parse(URL(string: "flagship://unlock-approve?requestId=req-42")!), .secretRequests)
        XCTAssertEqual(DeepLink.parse(URL(string: "flagship://unlock-approve")!), .secretRequests)
        XCTAssertEqual(DeepLink.parse(URL(string: "flagship://unlock-approvals")!), .secretRequests)
    }

    func test_secretRequests_host_routesToSecretRequests() {
        let url = URL(string: "flagship://secret-requests")!
        XCTAssertEqual(DeepLink.parse(url), .secretRequests)
    }

    // The `secret-request` push synthesizes the singular host form too.
    func test_secretRequest_singularHost_routesToSecretRequests() {
        let url = URL(string: "flagship://secret-request")!
        XCTAssertEqual(DeepLink.parse(url), .secretRequests)
    }

    func test_serverDetail_withPodId_routesToDetail() {
        let url = URL(string: "flagship://server?podId=home-abc123")!
        XCTAssertEqual(DeepLink.parse(url), .serverDetail(podId: "home-abc123"))
    }

    func test_serverDetail_missingPodId_returnsNil() {
        let url = URL(string: "flagship://server")!
        XCTAssertNil(DeepLink.parse(url))
    }

    func test_appDetail_withServiceId_routesToDetail() {
        let url = URL(string: "flagship://app?serviceId=plants")!
        XCTAssertEqual(DeepLink.parse(url), .appDetail(serviceId: "plants"))
    }

    func test_createServer_host_routes() {
        let url = URL(string: "flagship://create-server")!
        XCTAssertEqual(DeepLink.parse(url), .createServer)
    }

    func test_companionDockApproval_routesToSettings() {
        let link = "flagship://dock?server=home.alice.flagship.services&request=\(String(repeating: "ab", count: 16))&code=\(String(repeating: "cd", count: 32))"
        XCTAssertEqual(DeepLink.parse(URL(string: link)!), .companionDockApproval(link: link))
    }

    func test_unknownHost_returnsNil() {
        let url = URL(string: "flagship://nothing-like-this")!
        XCTAssertNil(DeepLink.parse(url))
    }

    func test_nonFlagshipScheme_returnsNil() {
        let url = URL(string: "https://flagshipserver.com/unlock-approve?requestId=x")!
        XCTAssertNil(DeepLink.parse(url))
    }

    // MARK: - DeepLinker pending queue

    @MainActor
    func test_linker_enqueueAndConsume_returnsPending() {
        let l = DeepLinker()
        XCTAssertNil(l.pending)
        l.enqueue(.serverDetail(podId: "p1"))
        XCTAssertEqual(l.pending, .serverDetail(podId: "p1"))
        XCTAssertEqual(l.consume(), .serverDetail(podId: "p1"))
        XCTAssertNil(l.pending)
        XCTAssertNil(l.consume())
    }

    @MainActor
    func test_linker_secondEnqueue_replacesFirst() {
        // Only one pending link at a time — the latest external trigger
        // takes precedence so a stale notification doesn't override a
        // fresh widget tap.
        let l = DeepLinker()
        l.enqueue(.serverDetail(podId: "p1"))
        l.enqueue(.appDetail(serviceId: "wiki"))
        XCTAssertEqual(l.pending, .appDetail(serviceId: "wiki"))
    }

    // MARK: - W10 vibecode deep link

    func test_vibecode_path_form_routes_to_chat() {
        let url = URL(string: "flagship://vibecode/sess-abc-42")!
        XCTAssertEqual(DeepLink.parse(url), .vibeCodeChat(sessionId: "sess-abc-42"))
    }

    func test_vibecode_query_form_routes_to_chat() {
        let url = URL(string: "flagship://vibecode?sessionId=sess-xyz-99")!
        XCTAssertEqual(DeepLink.parse(url), .vibeCodeChat(sessionId: "sess-xyz-99"))
    }

    func test_vibecode_without_id_returns_nil() {
        let url = URL(string: "flagship://vibecode")!
        XCTAssertNil(DeepLink.parse(url))
    }
}
