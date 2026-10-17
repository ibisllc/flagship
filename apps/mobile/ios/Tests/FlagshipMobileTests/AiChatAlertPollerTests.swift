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
        var server: String?
        private(set) var ackedThrough: [Int] = []
        private(set) var fetchSinceCalls: [Int] = []

        init(_ response: PhoneAlertsResponse) { self.response = response }

        func fetchAlerts(since: Int) async throws -> PhoneAlertsResponse {
            fetchSinceCalls.append(since)
            if throwOnFetch { throw ScreensClientError.http(status: 503, message: "blip") }
            return response
        }
        func ackAlerts(throughId: Int) async throws { ackedThrough.append(throughId) }
        func boundServer() async -> String? { server }
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
            notify: { sessionId, request, _ in notified(sessionId, request) },
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

    func test_storageFull_notifiesOncePerApp_andAcks() async {
        let ops = ActiveOperationsCenter()
        let env = { (id: Int) in PhoneAlertEnvelope(id: id, emittedAt: id, alert: .appStorageFull(serviceId: "a--wiki", store: "files")) }
        let client = FakeClient(PhoneAlertsResponse(events: [env(3), env(4)], size: 2))
        client.server = "home.a.flagship.services"
        var storage: [(String, String?)] = []
        let poller = AiChatAlertPoller(
            operations: ops, client: client, isActive: { true },
            notify: { _, _, _ in XCTFail("not an AI chat alert") },
            notifyStorageFull: { storage.append(($0, $1)) },
            pollIntervalNanos: 1
        )
        _ = await poller.drainOnce()
        XCTAssertEqual(storage.count, 1)
        XCTAssertEqual(storage.first?.0, "a--wiki")
        XCTAssertEqual(storage.first?.1, "home.a.flagship.services")
        XCTAssertEqual(client.ackedThrough, [4])
        XCTAssertTrue(ops.operations.isEmpty)
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

    /// The alert names the box it came from: the sliver and the notification
    /// open the chat there, whichever server the app shows by then.
    func test_alertNamesItsServer() async {
        let ops = ActiveOperationsCenter()
        let client = FakeClient(PhoneAlertsResponse(events: [aiChatEnv(3, "sess-d", .requestEnvVar, "tool-1")], size: 1))
        client.server = "home2.bright-maple.flagship.services"
        var servers: [String?] = []
        let poller = AiChatAlertPoller(operations: ops, client: client, isActive: { true },
                                       notify: { _, _, server in servers.append(server) }, pollIntervalNanos: 1)
        _ = await poller.drainOnce()
        XCTAssertEqual(ops.operations.first?.target,
                       .vibeCodeChatOnServer(sessionId: "sess-d", serverFqdn: "home2.bright-maple.flagship.services"))
        XCTAssertEqual(servers, ["home2.bright-maple.flagship.services"])
    }

    /// Each box numbers its own alerts: switching servers starts that
    /// server's drain from its own cursor, not the last server's.
    func test_eachServerKeepsItsOwnCursor() async {
        let ops = ActiveOperationsCenter()
        let client = FakeClient(PhoneAlertsResponse(events: [aiChatEnv(9, "sess-a", .talkToUser, "tool-1")], size: 1))
        client.server = "home.x"
        let poller = makePoller(client, ops: ops) { _, _ in }
        _ = await poller.drainOnce()
        client.server = "home2.x"
        client.response = PhoneAlertsResponse(events: [aiChatEnv(2, "sess-b", .talkToUser, "tool-1")], size: 1)
        let handled = await poller.drainOnce()
        XCTAssertEqual(handled, 1)
        client.server = "home.x"
        client.response = PhoneAlertsResponse(events: [], size: 0)
        _ = await poller.drainOnce()
        XCTAssertEqual(client.fetchSinceCalls, [0, 0, 9])
    }

    /// A content-free `generic` push now also means a build chat waits on the
    /// owner: the wake drains at once instead of on the next 5 s tick, and
    /// only while the app is usable.
    func test_wakePushDrainsAtOnce() async throws {
        let ops = ActiveOperationsCenter()
        let client = FakeClient(PhoneAlertsResponse(events: [], size: 0))
        var notified: [String] = []
        var active = true
        let poller = AiChatAlertPoller(operations: ops, client: client, isActive: { active },
                                       notify: { sessionId, _, _ in notified.append(sessionId) },
                                       pollIntervalNanos: 3_600_000_000_000)
        poller.start()
        defer { poller.stop() }
        try await waitUntil { client.fetchSinceCalls.count == 1 }

        client.response = PhoneAlertsResponse(events: [aiChatEnv(4, "sess-w", .talkToUser, "tool-1")], size: 1)
        PhoneAlertEvents.postWake()
        try await waitUntil { notified == ["sess-w"] }
        XCTAssertEqual(client.ackedThrough, [4])
        XCTAssertEqual(ops.operations.first?.id, "build:sess-w")

        active = false
        PhoneAlertEvents.postWake()
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(client.fetchSinceCalls.count, 2, "A locked app doesn't drain on a wake.")
    }

    private func waitUntil(_ condition: @escaping @MainActor () -> Bool, timeout: TimeInterval = 5) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { XCTFail("Timed out waiting"); return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }
}
