import XCTest
@testable import FlagshipCore
@testable import FlagshipUI
@testable import FlagshipAPI

/// #91 — `AiChatAlertPoller` drains the daemon→phone alert outbox
/// (`GET /api/phone/alerts`), feeds the operations sliver, raises a local
/// notification (once per session+tool), and ACKs the range. This is the iOS
/// mirror of the webapp `webappAiChatAlerts` / Android `AiChatAlertPollTest`
/// cases — they line up one-for-one. The drain client + the notifier are
/// injected, so nothing touches URLSession or UNUserNotificationCenter.
@MainActor
final class AiChatAlertPollerTests: XCTestCase {

    /// A scripted PhoneAlertClient: serves a queued response and records ACKs.
    private final class FakeClient: PhoneAlertClient, @unchecked Sendable {
        var response: PhoneAlertsResponse
        var throwOnFetch = false
        private(set) var ackedThrough: [Int] = []
        private(set) var fetchSinceCalls: [Int] = []

        init(_ response: PhoneAlertsResponse) { self.response = response }

        func fetchAlerts(since: Int) async throws -> PhoneAlertsResponse {
            fetchSinceCalls.append(since)
            if throwOnFetch { throw ScreensClientError.http(status: 503, message: "blip") }
            return response
        }
        func ackAlerts(throughId: Int) async throws { ackedThrough.append(throughId) }
    }

    private func aiChatEnv(_ id: Int, _ sessionId: String, _ request: PhoneAlert.AiChatRequest, _ toolUseId: String) -> PhoneAlertEnvelope {
        PhoneAlertEnvelope(id: id, emittedAt: 1000 + id, alert: .aiChatNeedsYou(sessionId: sessionId, request: request, toolUseId: toolUseId))
    }

    private func makePoller(
        _ client: FakeClient,
        ops: ActiveOperationsCenter,
        notified: @escaping (String, PhoneAlert.AiChatRequest) -> Void
    ) -> AiChatAlertPoller {
        AiChatAlertPoller(
            operations: ops,
            client: client,
            isActive: { true },
            notify: { sessionId, request in notified(sessionId, request) },
            pollIntervalNanos: 1
        )
    }

    func test_drain_feedsSliver_notifies_andAcks() async {
        let ops = ActiveOperationsCenter()
        let client = FakeClient(PhoneAlertsResponse(events: [aiChatEnv(7, "sess-a", .talkToUser, "tool-1")], size: 1))
        var notified: [(String, PhoneAlert.AiChatRequest)] = []
        let poller = makePoller(client, ops: ops) { notified.append(($0, $1)) }

        let handled = await poller.drainOnce()

        XCTAssertEqual(handled, 1)
        // The sliver got a build op deep-linking to the chat.
        XCTAssertEqual(ops.operations.count, 1)
        XCTAssertEqual(ops.operations.first?.id, "build:sess-a")
        XCTAssertEqual(ops.operations.first?.target, .vibeCodeChat(sessionId: "sess-a"))
        // One notification, and the range was ACK'd through id 7.
        XCTAssertEqual(notified.count, 1)
        XCTAssertEqual(notified.first?.0, "sess-a")
        XCTAssertEqual(client.ackedThrough, [7])
        XCTAssertEqual(client.fetchSinceCalls, [0])
    }

    func test_dedup_reDrainSameTool_doesNotReNotify() async {
        let ops = ActiveOperationsCenter()
        let client = FakeClient(PhoneAlertsResponse(events: [aiChatEnv(1, "sess-a", .talkToUser, "tool-1")], size: 1))
        var notifyCount = 0
        let poller = makePoller(client, ops: ops) { _, _ in notifyCount += 1 }

        _ = await poller.drainOnce()
        // The cursor advanced past id 1, so re-serving the SAME envelope means
        // fetch(since: 1) returns it again only if the box hadn't dropped it —
        // model that by leaving the response in place. The dedup set keeps the
        // notifier from firing twice for the same (session, tool).
        _ = await poller.drainOnce()

        XCTAssertEqual(notifyCount, 1)
    }

    func test_newToolSameSession_reNotifies() async {
        let ops = ActiveOperationsCenter()
        let client = FakeClient(PhoneAlertsResponse(events: [aiChatEnv(1, "sess-a", .talkToUser, "tool-1")], size: 1))
        var requests: [PhoneAlert.AiChatRequest] = []
        let poller = makePoller(client, ops: ops) { _, r in requests.append(r) }

        _ = await poller.drainOnce()
        // The AI emits its NEXT tool in the same session — a genuinely new
        // "needs you", so a fresh notification fires.
        client.response = PhoneAlertsResponse(events: [aiChatEnv(2, "sess-a", .requestEnvVar, "tool-2")], size: 1)
        _ = await poller.drainOnce()

        XCTAssertEqual(requests, [.talkToUser, .requestEnvVar])
    }

    func test_nonAiChatEnvelope_skippedButCursorAdvances() async {
        let ops = ActiveOperationsCenter()
        let client = FakeClient(PhoneAlertsResponse(
            events: [
                PhoneAlertEnvelope(id: 3, emittedAt: 1, alert: .other(kind: "browser-input-needed")),
                aiChatEnv(4, "sess-b", .requestEnvVar, "tool-9"),
            ],
            size: 2
        ))
        var notified = 0
        let poller = makePoller(client, ops: ops) { _, _ in notified += 1 }

        let handled = await poller.drainOnce()

        XCTAssertEqual(handled, 1)
        XCTAssertEqual(ops.operations.count, 1)
        XCTAssertEqual(ops.operations.first?.id, "build:sess-b")
        XCTAssertEqual(notified, 1)
        // Cursor (and ACK) covers BOTH so this loop doesn't re-drain the
        // browser alert (its own surface handles it).
        XCTAssertEqual(client.ackedThrough, [4])
    }

    func test_empty_noAckNoNotify() async {
        let ops = ActiveOperationsCenter()
        let client = FakeClient(PhoneAlertsResponse(events: [], size: 0))
        var notified = 0
        let poller = makePoller(client, ops: ops) { _, _ in notified += 1 }

        let handled = await poller.drainOnce()

        XCTAssertEqual(handled, 0)
        XCTAssertTrue(ops.operations.isEmpty)
        XCTAssertEqual(notified, 0)
        XCTAssertTrue(client.ackedThrough.isEmpty)
    }

    func test_transportError_handlesZero_andReDrainsFromSameCursor() async {
        let ops = ActiveOperationsCenter()
        let client = FakeClient(PhoneAlertsResponse(events: [aiChatEnv(5, "sess-c", .talkToUser, "tool-1")], size: 1))
        client.throwOnFetch = true
        let poller = makePoller(client, ops: ops) { _, _ in }

        let handled = await poller.drainOnce()
        XCTAssertEqual(handled, 0)
        XCTAssertTrue(client.ackedThrough.isEmpty)

        // Recovery: the cursor never advanced (still 0), so the next drain
        // re-fetches from 0 and succeeds.
        client.throwOnFetch = false
        let handled2 = await poller.drainOnce()
        XCTAssertEqual(handled2, 1)
        XCTAssertEqual(client.fetchSinceCalls, [0, 0])
        XCTAssertEqual(client.ackedThrough, [5])
    }
}
