import XCTest
@testable import FlagshipCore

final class DeepLinkTests: XCTestCase {

    // MARK: - flagship:// scheme

    func test_unlockApprove_withConcreteRequestId_routesToId() {
        let url = URL(string: "flagship://unlock-approve?requestId=req-42")!
        XCTAssertEqual(DeepLink.parse(url), .unlockApprove(requestId: "req-42"))
    }

    func test_unlockApprove_withSentinelLatest_routesToList() {
        // Siri / App-Intents sends "latest" when there's no specific
        // request to target. Should fall through to the queue view.
        let url = URL(string: "flagship://unlock-approve?requestId=latest")!
        XCTAssertEqual(DeepLink.parse(url), .unlockApprovalsList)
    }

    func test_unlockApprove_withSentinelAny_routesToList() {
        let url = URL(string: "flagship://unlock-approve?requestId=any")!
        XCTAssertEqual(DeepLink.parse(url), .unlockApprovalsList)
    }

    func test_unlockApprove_missingRequestId_routesToList() {
        let url = URL(string: "flagship://unlock-approve")!
        XCTAssertEqual(DeepLink.parse(url), .unlockApprovalsList)
    }

    func test_unlockApprovalsHost_routesToList() {
        let url = URL(string: "flagship://unlock-approvals")!
        XCTAssertEqual(DeepLink.parse(url), .unlockApprovalsList)
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

    func test_marketplace_host_routes() {
        let url = URL(string: "flagship://marketplace")!
        XCTAssertEqual(DeepLink.parse(url), .marketplace)
    }

    func test_createServer_host_routes() {
        let url = URL(string: "flagship://create-server")!
        XCTAssertEqual(DeepLink.parse(url), .createServer)
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
        l.enqueue(.marketplace)
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
