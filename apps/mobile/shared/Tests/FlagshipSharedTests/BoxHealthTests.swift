import XCTest
@testable import FlagshipAPI

final class BoxHealthTests: XCTestCase {
    private let now: Int64 = 1_800_000_000_000

    private func report(
        receivedAgoMs: Int64 = 30_000, oom: Int = 0, state: String = "active", restarts: Int = 0,
        lastExit: Int = 0, tunnel: Bool = true, disk: Int = 40, uptimeS: Int64 = 7_380
    ) -> BoxHealth {
        BoxHealth(at: now - receivedAgoMs, uptimeS: uptimeS, memTotalMB: 3_900, memAvailMB: 120,
                  swapUsedMB: 0, oomKills: oom,
                  daemon: .init(state: state, restarts: restarts, lastExit: lastExit),
                  tunnel: tunnel, diskUsedPct: disk, receivedAt: now - receivedAgoMs)
    }

    func testHealthyReadsMemoryDiskAndUptime() {
        let v = report().verdict(nowMs: now)
        XCTAssertTrue(v.ok)
        XCTAssertEqual(v.lines, ["Healthy · 120 MB free of 3900 MB · disk 40% · up 2h 3m"])
        XCTAssertEqual(BoxHealth.uptime(300), "5m")
        XCTAssertEqual(BoxHealth.uptime(90_000 + 3_600), "1d 2h")
    }

    func testStaleReportIsTheOnlyFinding() {
        let v = report(receivedAgoMs: 7 * 60_000, oom: 3).verdict(nowMs: now)
        XCTAssertFalse(v.ok)
        XCTAssertEqual(v.lines, ["No health report for 7 min. The server itself may be off or frozen."])
    }

    func testEveryIssueIsListed() {
        let v = report(oom: 2, state: "failed", restarts: 5, lastExit: 137, tunnel: false, disk: 93).verdict(nowMs: now)
        XCTAssertEqual(v.lines, [
            "Ran out of memory 2× since it started (120 MB free of 3900 MB now).",
            "The server software isn't running (failed; restarted 5×, last exit code 137).",
            "Can't reach the Flagship relay.",
            "Disk is 93% full.",
        ])
    }

    func testRepeatedRestartsWhileActive() {
        let v = report(restarts: 4, lastExit: 1).verdict(nowMs: now)
        XCTAssertEqual(v.lines, ["The server software restarted 4× since it started (last exit code 1)."])
    }

    func testDecodesFromPodsAndIgnoresGarbage() throws {
        let json = """
        {"serverDomain":"a.b.flagship.services","identityPubKey":"00","health":{"v":1,"domain":"a.b.flagship.services","at":1,"uptimeS":2,"memTotalMB":3,"memAvailMB":4,"swapUsedMB":0,"oomKills":0,"daemon":{"state":"active","restarts":0,"lastExit":0},"tunnel":true,"diskUsedPct":5,"receivedAt":6}}
        """
        let e = try JSONDecoder().decode(PodDirectoryEntry.self, from: Data(json.utf8))
        XCTAssertEqual(e.health?.receivedAt, 6)
        let bad = #"{"serverDomain":"a","identityPubKey":"00","health":{"v":"x"}}"#
        XCTAssertNil(try JSONDecoder().decode(PodDirectoryEntry.self, from: Data(bad.utf8)).health)
    }
}
