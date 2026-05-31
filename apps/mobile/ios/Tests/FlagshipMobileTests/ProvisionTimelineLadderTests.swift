import XCTest
@testable import FlagshipAPI
@testable import FlagshipCore

/// Spec for the ProvisionTimelineLadder row projection.
///
/// The watchOS counterpart (`WatchProtocol.ProvisionTimelineLadder` in
/// `App/Shared/WatchProvisionTimeline.swift`) mirrors this algorithm
/// against a wire-type, so a regression here is the canary that the
/// watch view will also drift.
final class ProvisionTimelineLadderTests: XCTestCase {

    // MARK: - Pre-checkpoint

    func test_nilStatus_firstRowCurrentWithWaitingHint_restUpcoming() {
        let rows = ProvisionTimelineLadder.rows(for: nil)
        XCTAssertEqual(rows.count, 8)
        XCTAssertEqual(rows[0].phase, .booting)
        XCTAssertEqual(rows[0].state, .current)
        XCTAssertEqual(rows[0].detail, "Waiting for the box to phone home…")
        for i in 1..<rows.count {
            XCTAssertEqual(rows[i].state, .upcoming, "row \(i) (\(rows[i].phase)) should be upcoming")
            XCTAssertNil(rows[i].detail)
        }
    }

    // MARK: - In-flight progression

    func test_midLadder_priorRowsDone_currentSpinning_laterUpcoming() {
        let status = ProvisionStatus(
            serial: "A1",
            serverDomain: nil,
            phase: .installing,
            detail: "writing rootfs",
            updatedAt: 1_700_000_000_000,
            history: [
                .init(phase: .booting,      detail: nil, ts: 1_700_000_000_000),
                .init(phase: .downloading,  detail: nil, ts: 1_700_000_001_000),
                .init(phase: .partitioning, detail: nil, ts: 1_700_000_002_000),
                .init(phase: .installing,   detail: "writing rootfs", ts: 1_700_000_003_000),
            ]
        )
        let rows = ProvisionTimelineLadder.rows(for: status)
        XCTAssertEqual(rows.map(\.state), [.done, .done, .done, .current, .upcoming, .upcoming, .upcoming, .upcoming])
        XCTAssertEqual(rows[3].phase, .installing)
        XCTAssertEqual(rows[3].detail, "writing rootfs")
        // Earlier rows don't carry their history detail — the timeline
        // only surfaces the current row's detail.
        for i in 0..<3 { XCTAssertNil(rows[i].detail) }
    }

    func test_currentRowDetail_prefersLiveDetail_overHistory() {
        // status.detail wins over the matching history entry's detail.
        let status = ProvisionStatus(
            serial: "A1",
            serverDomain: nil,
            phase: .sealing,
            detail: "live detail",
            updatedAt: 1_700_000_000_000,
            history: [.init(phase: .sealing, detail: "stale detail", ts: 1_700_000_000_000)]
        )
        XCTAssertEqual(ProvisionTimelineLadder.rows(for: status)[5].detail, "live detail")
    }

    func test_currentRowDetail_fallsBackToHistory_whenLiveDetailEmpty() {
        let status = ProvisionStatus(
            serial: "A1",
            serverDomain: nil,
            phase: .sealing,
            detail: nil,
            updatedAt: 1_700_000_000_000,
            history: [.init(phase: .sealing, detail: "from history", ts: 1_700_000_000_000)]
        )
        XCTAssertEqual(ProvisionTimelineLadder.rows(for: status)[5].detail, "from history")
    }

    // MARK: - Terminal live

    func test_live_collapsesToAllDone_lastRowDoneNotCurrent() {
        let status = ProvisionStatus(
            serial: "A1",
            serverDomain: "home.alice.flagship.services",
            phase: .live,
            detail: nil,
            updatedAt: 1_700_000_009_000,
            history: []
        )
        let rows = ProvisionTimelineLadder.rows(for: status)
        XCTAssertTrue(rows.allSatisfy { $0.state == .done }, "every row should be done at terminal live")
        XCTAssertEqual(rows.last?.phase, .live)
        // No spinner on a finished install.
        XCTAssertFalse(rows.contains { $0.state == .current })
    }

    // MARK: - Terminal error

    func test_error_surfaceFailureOnLastNonErrorPhase_priorDone_laterUpcoming() {
        let status = ProvisionStatus(
            serial: "A1",
            serverDomain: nil,
            phase: .error,
            detail: "ACME 429 rate-limited",
            updatedAt: 1_700_000_010_000,
            history: [
                .init(phase: .booting,      detail: nil, ts: 1_700_000_000_000),
                .init(phase: .downloading,  detail: nil, ts: 1_700_000_001_000),
                .init(phase: .partitioning, detail: nil, ts: 1_700_000_002_000),
                .init(phase: .installing,   detail: nil, ts: 1_700_000_003_000),
                .init(phase: .registering,  detail: nil, ts: 1_700_000_004_000),
                .init(phase: .sealing,      detail: nil, ts: 1_700_000_005_000),
                .init(phase: .error,        detail: "ACME 429 rate-limited", ts: 1_700_000_010_000),
            ]
        )
        let rows = ProvisionTimelineLadder.rows(for: status)
        XCTAssertEqual(rows.map(\.state), [.done, .done, .done, .done, .done, .error, .upcoming, .upcoming])
        XCTAssertEqual(rows[5].phase, .sealing)
        XCTAssertEqual(rows[5].detail, "ACME 429 rate-limited")
    }

    func test_error_withEmptyHistory_surfaceFailureOnFirstRow() {
        let status = ProvisionStatus(
            serial: "A1",
            serverDomain: nil,
            phase: .error,
            detail: "box never phoned home",
            updatedAt: 1_700_000_010_000,
            history: []
        )
        let rows = ProvisionTimelineLadder.rows(for: status)
        XCTAssertEqual(rows[0].state, .error)
        XCTAssertEqual(rows[0].detail, "box never phoned home")
        for i in 1..<rows.count { XCTAssertEqual(rows[i].state, .upcoming) }
    }

    func test_error_emptyDetailString_treatedAsNoDetail() {
        let status = ProvisionStatus(
            serial: "A1",
            serverDomain: nil,
            phase: .error,
            detail: "",
            updatedAt: 1_700_000_010_000,
            history: [.init(phase: .booting, detail: nil, ts: 1_700_000_000_000)]
        )
        let rows = ProvisionTimelineLadder.rows(for: status)
        XCTAssertEqual(rows[0].state, .error)
        XCTAssertNil(rows[0].detail)
    }

    // MARK: - Forward-compat sentinel

    func test_unknownPhase_decodesAsUnknown_rendersAsPreCheckpoint() {
        // Worker sends a phase the old client doesn't know about → it
        // decodes to .unknown. Renderer should fall back to the "no
        // checkpoint" UI so we don't silently drop the timeline.
        let raw = """
        {
          "serial": "A1",
          "serverDomain": null,
          "phase": "future-step-2027",
          "detail": null,
          "updatedAt": 1700000000000,
          "history": []
        }
        """.data(using: .utf8)!
        let status = try! JSONDecoder().decode(ProvisionStatus.self, from: raw)
        XCTAssertEqual(status.phase, .unknown)

        let rows = ProvisionTimelineLadder.rows(for: status)
        XCTAssertEqual(rows[0].state, .current)
        XCTAssertEqual(rows[0].detail, "Waiting for the box to phone home…")
        for i in 1..<rows.count { XCTAssertEqual(rows[i].state, .upcoming) }
    }
}
