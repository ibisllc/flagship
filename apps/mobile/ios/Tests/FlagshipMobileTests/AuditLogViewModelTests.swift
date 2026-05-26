import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

/// P5 — AuditLogViewModel pagination + kind→label mapping.
///
/// Mirrors the canonical webapp `views/audit-log.js`:
///   - `since` is an EXCLUSIVE LOWER bound; the Worker returns the newest
///     `limit` rows (DESC by seq). The VM grows the requested window on
///     each `loadMore`.
///   - The server caps `limit` at 50 — once we've grown to 50, the VM
///     hides "load more".
///   - The kind→label / kind→icon maps are pinned to docs/revocation-ui.md
///     and match the iOS Activity tab + Android + webapp byte-for-byte.
@MainActor
final class AuditLogViewModelTests: XCTestCase {

    private func makeServer() -> MockFlagshipServerClient {
        let c = MockFlagshipServerClient()
        c.simulatedLatency = 0
        return c
    }

    private func seedEvents(_ count: Int, on server: MockFlagshipServerClient, user: String = "harry") {
        // Newest first by seq so the VM's sort is exercised on a list
        // that's already DESC + matches the Worker.
        let base: Int64 = 1_700_000_000_000
        let events = (1...count).map { i in
            AuditEvent(
                seq: i,
                eventKind: "device-replaced",
                detail: "iPhone \(i)",
                devicePrefix: "abc\(i)",
                postedAt: base + Int64(i) * 1000
            )
        }
        server.auditEventsByUser[user] = events
    }

    // MARK: - Label / icon mapping

    func test_label_for_knownKinds_matchesCanonical() {
        XCTAssertEqual(AuditLogViewModel.label(for: "device-disconnected"), "Disconnected device")
        XCTAssertEqual(AuditLogViewModel.label(for: "device-replaced"),     "Replaced device")
        XCTAssertEqual(AuditLogViewModel.label(for: "device-added"),        "Added device")
        XCTAssertEqual(AuditLogViewModel.label(for: "wipe-restart"),        "Wiped & restarted account")
        XCTAssertEqual(AuditLogViewModel.label(for: "recovery-set-up"),     "Set up recovery")
        XCTAssertEqual(AuditLogViewModel.label(for: "recovery-rotated"),    "Rotated recovery passkey")
        XCTAssertEqual(AuditLogViewModel.label(for: "app-renamed"),         "Renamed app URL")
    }

    func test_label_for_unknownKind_fallsBackToRawString() {
        XCTAssertEqual(AuditLogViewModel.label(for: "future-event-kind"), "future-event-kind")
    }

    func test_icon_for_knownKinds_matchesRevocationUiDocs() {
        XCTAssertEqual(AuditLogViewModel.icon(for: "device-disconnected"), "lock.open.trianglebadge.exclamationmark")
        XCTAssertEqual(AuditLogViewModel.icon(for: "device-replaced"),     "arrow.triangle.2.circlepath.circle")
        XCTAssertEqual(AuditLogViewModel.icon(for: "device-added"),        "plus.circle")
        XCTAssertEqual(AuditLogViewModel.icon(for: "wipe-restart"),        "trash.fill")
        XCTAssertEqual(AuditLogViewModel.icon(for: "recovery-set-up"),     "key.horizontal.fill")
        XCTAssertEqual(AuditLogViewModel.icon(for: "recovery-rotated"),    "arrow.triangle.2.circlepath")
        XCTAssertEqual(AuditLogViewModel.icon(for: "app-renamed"),         "link.circle")
    }

    func test_icon_for_unknownKind_fallsBackToCircle() {
        XCTAssertEqual(AuditLogViewModel.icon(for: "?"), "circle.fill")
    }

    // MARK: - Loading / empty / failure

    func test_load_emptyUsername_loadsEmpty() async {
        let server = makeServer()
        let vm = AuditLogViewModel(server: server, username: "", pageSize: 10)
        await vm.load()
        XCTAssertEqual(vm.status, .loaded)
        XCTAssertTrue(vm.events.isEmpty)
        XCTAssertFalse(vm.canLoadMore)
    }

    func test_load_noEvents_loadsEmpty_andHidesLoadMore() async {
        let server = makeServer()
        let vm = AuditLogViewModel(server: server, username: "harry", pageSize: 10)
        await vm.load()
        XCTAssertEqual(vm.status, .loaded)
        XCTAssertTrue(vm.events.isEmpty)
        XCTAssertFalse(vm.canLoadMore)
    }

    func test_load_returnsEventsNewestFirst() async {
        let server = makeServer()
        seedEvents(5, on: server)
        let vm = AuditLogViewModel(server: server, username: "harry", pageSize: 10)
        await vm.load()
        XCTAssertEqual(vm.status, .loaded)
        XCTAssertEqual(vm.events.count, 5)
        // DESC by seq, regardless of mock insertion order.
        XCTAssertEqual(vm.events.map(\.seq), [5, 4, 3, 2, 1])
        // Window (10) > server-side count (5) → no more to fetch.
        XCTAssertFalse(vm.canLoadMore)
    }

    func test_load_fillsWindow_andOffersLoadMore() async {
        let server = makeServer()
        // Page size 10, seed 25 — first load fills the 10-row window and
        // there's more to fetch.
        seedEvents(25, on: server)
        let vm = AuditLogViewModel(server: server, username: "harry", pageSize: 10)
        await vm.load()
        XCTAssertEqual(vm.events.count, 10)
        XCTAssertTrue(vm.canLoadMore, "window was filled — should offer load-more")
    }

    // MARK: - Pagination (window growth + 50-row cap)

    func test_loadMore_growsWindowByPageSize() async {
        let server = makeServer()
        seedEvents(30, on: server)
        let vm = AuditLogViewModel(server: server, username: "harry", pageSize: 10)
        await vm.load()
        XCTAssertEqual(vm.events.count, 10)
        XCTAssertTrue(vm.canLoadMore)

        await vm.loadMore()
        XCTAssertEqual(vm.events.count, 20)
        XCTAssertTrue(vm.canLoadMore, "30 rows ≥ 20 window — still more")

        await vm.loadMore()
        XCTAssertEqual(vm.events.count, 30)
        // Now we've fetched everything — server returned fewer than the
        // window (30 vs requested 30 — tie at the window means no more
        // history beyond the cap iff window < cap; here 30 < 50 but
        // server only returned 30 — VM detects "fewer than requested" by
        // count >= limit being false next call. Here count == limit so
        // canLoadMore stays true until we actually exhaust the rows.
        // The strict "fewer than window" branch fires when the next
        // loadMore returns < limit, which the next call exercises.
        await vm.loadMore()
        XCTAssertEqual(vm.events.count, 30)
        XCTAssertFalse(vm.canLoadMore, "window now > available rows — no more")
    }

    func test_loadMore_stopsAtServerCap() async {
        let server = makeServer()
        // Seed 60 rows but the server caps at 50, so the VM can never
        // grow past 50 — load-more must hide once window hits maxLimit.
        seedEvents(60, on: server)
        let vm = AuditLogViewModel(server: server, username: "harry", pageSize: 20)
        await vm.load()
        XCTAssertEqual(vm.events.count, 20)
        XCTAssertTrue(vm.canLoadMore)
        await vm.loadMore()
        XCTAssertEqual(vm.events.count, 40)
        XCTAssertTrue(vm.canLoadMore)
        await vm.loadMore()
        // 40 + 20 = 60, clamped at maxLimit (50). The server is also
        // capped at 50 rows per request — `events.count` is therefore 50.
        XCTAssertEqual(vm.events.count, 50)
        XCTAssertFalse(vm.canLoadMore, "window hit server-side cap — no more")
    }

    func test_loadMore_noOp_whenAlreadyAtEnd() async {
        let server = makeServer()
        seedEvents(3, on: server)
        let vm = AuditLogViewModel(server: server, username: "harry", pageSize: 10)
        await vm.load()
        XCTAssertEqual(vm.events.count, 3)
        XCTAssertFalse(vm.canLoadMore)
        // Should not throw, should not change anything.
        await vm.loadMore()
        XCTAssertEqual(vm.events.count, 3)
        XCTAssertFalse(vm.canLoadMore)
    }

    // MARK: - Failure handling

    func test_load_failure_surfacesAsFailed() async {
        let server = makeServer()
        server.shouldFail = true
        let vm = AuditLogViewModel(server: server, username: "harry", pageSize: 10)
        await vm.load()
        if case .failed = vm.status {
            // expected
        } else {
            XCTFail("expected .failed, got \(vm.status)")
        }
    }

    // MARK: - maxLimit constant

    func test_maxLimit_mirrorsServerCap() {
        // Matches MAX_LIMIT in packages/control-plane/src/auditEvents.ts.
        XCTAssertEqual(AuditLogViewModel.maxLimit, 50)
    }
}
