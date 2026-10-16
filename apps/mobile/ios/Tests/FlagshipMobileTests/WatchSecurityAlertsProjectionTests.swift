import XCTest
@testable import FlagshipCore

/// Spec for the watch security-alerts projection — the pure FlagshipCore
/// helper that backs `WatchSecurityAlertsView`. The SwiftUI facade is a
/// thin renderer over these outputs (same split as
/// `ProvisionTimelineLadder` / its tests), so a regression here is the
/// canary that the watch surface will also drift.
final class WatchSecurityAlertsProjectionTests: XCTestCase {

    private typealias P = WatchProtocol.SecurityAlertsProjection

    private func approval(_ id: String, at ms: Int64) -> WatchProtocol.PendingApproval {
        WatchProtocol.PendingApproval(requestId: id, serverFqdn: "\(id).alice.flagship.services", requestedAt: ms, ip: nil)
    }

    private func event(_ seq: Int, _ kind: String, at ms: Int64) -> WatchProtocol.SecurityAlert {
        WatchProtocol.SecurityAlert(seq: seq, kind: kind, detail: "", devicePrefix: "ab12cd", postedAt: ms)
    }

    // MARK: - Empty / nil

    func test_nilContext_isEmpty_noApprovals_noEvents() {
        XCTAssertTrue(P.isEmpty(nil))
        XCTAssertTrue(P.approvals(in: nil).isEmpty)
        XCTAssertTrue(P.events(in: nil).isEmpty)
    }

    func test_emptyContext_isEmpty() {
        let ctx = WatchProtocol.SecurityAlertsContext()
        XCTAssertTrue(P.isEmpty(ctx))
        XCTAssertTrue(ctx.isEmpty)
    }

    func test_contextWithOnlyApprovals_isNotEmpty() {
        let ctx = WatchProtocol.SecurityAlertsContext(pendingApprovals: [approval("a", at: 1)])
        XCTAssertFalse(P.isEmpty(ctx))
        XCTAssertFalse(ctx.isEmpty)
    }

    func test_contextWithOnlyEvents_isNotEmpty() {
        let ctx = WatchProtocol.SecurityAlertsContext(recentEvents: [event(1, "device-replaced", at: 1)])
        XCTAssertFalse(P.isEmpty(ctx))
    }

    // MARK: - Approvals ordering

    func test_approvals_sortedOldestFirst() {
        let ctx = WatchProtocol.SecurityAlertsContext(pendingApprovals: [
            approval("newest", at: 3_000),
            approval("oldest", at: 1_000),
            approval("middle", at: 2_000),
        ])
        XCTAssertEqual(P.approvals(in: ctx).map(\.requestId), ["oldest", "middle", "newest"])
    }

    // MARK: - Events ordering / dedupe / trim

    func test_events_sortedNewestFirstBySeq() {
        let ctx = WatchProtocol.SecurityAlertsContext(recentEvents: [
            event(1, "device-added", at: 1_000),
            event(3, "device-replaced", at: 3_000),
            event(2, "device-disconnected", at: 2_000),
        ])
        XCTAssertEqual(P.events(in: ctx).map(\.seq), [3, 2, 1])
    }

    func test_events_dedupedBySeq() {
        let ctx = WatchProtocol.SecurityAlertsContext(recentEvents: [
            event(5, "device-replaced", at: 5_000),
            event(5, "device-replaced", at: 5_000),
            event(4, "device-added", at: 4_000),
        ])
        XCTAssertEqual(P.events(in: ctx).map(\.seq), [5, 4])
    }

    func test_events_trimmedToMaxEvents() {
        let many = (1...20).map { event($0, "device-added", at: Int64($0) * 1_000) }
        let ctx = WatchProtocol.SecurityAlertsContext(recentEvents: many)
        let out = P.events(in: ctx)
        XCTAssertEqual(out.count, P.maxEvents)
        // Newest-first → seq 20 down to (20 - maxEvents + 1).
        XCTAssertEqual(out.first?.seq, 20)
        XCTAssertEqual(out.last?.seq, 20 - P.maxEvents + 1)
    }

    // MARK: - Label / icon mapping (mirrors AuditLogViewModel)

    func test_label_knownKinds() {
        XCTAssertEqual(P.label(for: "device-replaced"), "Replaced device")
        XCTAssertEqual(P.label(for: "device-disconnected"), "Disconnected device")
        XCTAssertEqual(P.label(for: "wipe-restart"), "Wiped & restarted")
        XCTAssertEqual(P.label(for: "recovery-set-up"), "Set up recovery")
    }

    func test_label_unknownKind_isHumanized() {
        XCTAssertEqual(P.label(for: "future-event-2027"), "Future event 2027")
    }

    func test_label_serverKinds() {
        XCTAssertEqual(P.label(for: "server-online"), "Server came online")
        XCTAssertEqual(P.label(for: "server-created"), "Created server")
    }

    func test_icon_unknownKind_neutralShield() {
        XCTAssertEqual(P.icon(for: "future-event-2027"), "shield.lefthalf.filled")
    }

    func test_icon_knownKind() {
        XCTAssertEqual(P.icon(for: "device-replaced"), "arrow.triangle.2.circlepath.circle")
    }

    // MARK: - Wire round-trip (phone encodes, watch decodes)

    func test_securityAlertsContext_codableRoundTrip() throws {
        let ctx = WatchProtocol.SecurityAlertsContext(
            pendingApprovals: [approval("a", at: 1_000)],
            recentEvents: [event(7, "device-replaced", at: 7_000)],
            updatedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let data = try JSONEncoder().encode(ctx)
        let back = try JSONDecoder().decode(WatchProtocol.SecurityAlertsContext.self, from: data)
        XCTAssertEqual(back, ctx)
        XCTAssertEqual(P.approvals(in: back).map(\.requestId), ["a"])
        XCTAssertEqual(P.events(in: back).map(\.seq), [7])
    }

    // MARK: - What the phone publishes, whichever screen is open

    private typealias Phone = WatchProtocol.PhoneProjection

    func test_phone_waitingBoxesComeFromTheInbox_liveUnlocksOnly() {
        let inbox = [
            BoxRequest(nonceHex: "aa", serverDomain: "Home.alice.flagship.services", type: .unlockKey, issuedAt: 10, expiresAt: 2_000),
            BoxRequest(nonceHex: "bb", serverDomain: "office.alice.flagship.services", type: .entitlement, issuedAt: 11, expiresAt: 2_000),
            BoxRequest(nonceHex: "cc", serverDomain: "old.alice.flagship.services", type: .unlockKey, issuedAt: 1, expiresAt: 500),
        ]
        let rows = Phone.approvals(inbox: inbox, nowMs: 1_000)
        XCTAssertEqual(rows.map(\.requestId), ["home.alice.flagship.services#aa"], "live unlock requests only")
        XCTAssertEqual(rows.first?.serverFqdn, "Home.alice.flagship.services")
        XCTAssertEqual(rows.first?.requestedAt, 10)
    }

    func test_phone_screenRowsEnrichTheInboxRows() {
        let inbox = [WatchProtocol.PendingApproval(requestId: "home.x#aa", serverFqdn: "home.x", requestedAt: 5, ip: nil)]
        let screen = [WatchProtocol.PendingApproval(requestId: "Home.x#aa", serverFqdn: "Home.x", requestedAt: 5, ip: "203.0.113.9")]
        let merged = Phone.merged(inbox: inbox, screen: screen)
        XCTAssertEqual(merged.count, 1, "the same request, whatever the case of its server")
        XCTAssertEqual(merged.first?.ip, "203.0.113.9")
    }

    func test_phone_serverListNamesWaitingAndLeader_dropsRevoked() {
        let pods = [
            PodInfo(podId: "h", name: "Home", fqdn: "Home.x", status: .online),
            PodInfo(podId: "o", name: "Office", fqdn: "office.x", status: .offline),
            PodInfo(podId: "g", name: "Gone", fqdn: "gone.x", status: .offline, revokedAt: 1),
        ]
        let list = Phone.servers(pods: pods, leaderPodId: "o", isWaiting: { $0.podId == "o" })
        XCTAssertEqual(list.map(\.fqdn), ["home.x", "office.x"])
        XCTAssertEqual(list.map(\.state), ["online", "waiting"])
        XCTAssertEqual(list.map(\.isLeader), [false, true])
    }

    func test_serverSummary_lines() {
        typealias S = WatchProtocol.ServersProjection
        func ctx(_ states: [String]) -> WatchProtocol.ServersContext {
            .init(servers: states.enumerated().map { .init(name: "s\($0)", fqdn: "s\($0).x", state: $1, isLeader: false) })
        }
        XCTAssertEqual(S.line(S.summary(nil)), "No servers")
        XCTAssertEqual(S.line(S.summary(ctx(["online"]))), "Online")
        XCTAssertEqual(S.line(S.summary(ctx(["online", "online"]))), "All 2 online")
        XCTAssertEqual(S.line(S.summary(ctx(["online", "offline", "online"]))), "2 of 3 online")
        XCTAssertEqual(S.line(S.summary(ctx(["waiting", "online"]))), "1 waiting")
        XCTAssertEqual(S.label(for: "waiting"), "Waiting to start")
        let encoded = try! JSONEncoder().encode(ctx(["online"]))
        XCTAssertEqual(try! JSONDecoder().decode(WatchProtocol.ServersContext.self, from: encoded).servers.first?.state, "online")
    }
}
