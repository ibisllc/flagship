import XCTest
@testable import FlagshipBuilderCore

final class VMServerHealthTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func orderHealth(_ health: String) -> Data {
        Data("""
        {"serverDomain":"Home.u-x.flagship.services","health":\(health)}
        """.utf8)
    }

    private func health(receivedAt: Int64, oom: Int = 0, state: String = "active", tunnel: Bool = true) -> String {
        #"{"v":1,"domain":"home.u-x.flagship.services","at":1,"uptimeS":93600,"memTotalMB":3900,"memAvailMB":800,"swapUsedMB":0,"oomKills":\#(oom),"daemon":{"state":"\#(state)","restarts":1,"lastExit":0},"tunnel":\#(tunnel),"diskUsedPct":31,"receivedAt":\#(receivedAt)}"#
    }

    func testReadsTheServersReportByItsOrder() throws {
        let ms = Int64(now.timeIntervalSince1970 * 1000) - 20_000
        let h = try XCTUnwrap(VMServerHealth.fromOrderHealth(orderHealth(health(receivedAt: ms)), serverDomain: "home.u-x.flagship.services"))
        XCTAssertEqual(h.verdict(at: now), .init(ok: true, lines: ["Healthy · 800 MB free of 3900 MB · disk 31% · up 1d 2h"]))
        XCTAssertNil(VMServerHealth.fromOrderHealth(orderHealth(health(receivedAt: ms)), serverDomain: "other.u-x.flagship.services"))
        XCTAssertNil(VMServerHealth.fromOrderHealth(orderHealth(#"{"v":"bad"}"#), serverDomain: "home.u-x.flagship.services"))
        XCTAssertNil(VMServerHealth.fromOrderHealth(orderHealth("null"), serverDomain: "home.u-x.flagship.services"))
    }

    func testIssuesAndStaleness() throws {
        let ms = Int64(now.timeIntervalSince1970 * 1000)
        let bad = try XCTUnwrap(VMServerHealth.fromOrderHealth(orderHealth(health(receivedAt: ms, oom: 2, state: "failed", tunnel: false)), serverDomain: "home.u-x.flagship.services"))
        XCTAssertEqual(bad.verdict(at: now).lines, [
            "Ran out of memory 2× since it started (800 MB free of 3900 MB now).",
            "The server software isn't running (failed; restarted 1×, last exit code 0).",
            "Can't reach the Flagship relay.",
        ])
        XCTAssertEqual(bad.verdict(at: now.addingTimeInterval(6 * 60)).lines,
                       ["No health report for 6 min. The server itself may be off or frozen."])
    }

    func testOrderHealthURLRefusesOddSerials() {
        XCTAssertEqual(VMServerHealth.orderHealthURL(serial: "AB12_cd-34", environment: [:])?.absoluteString,
                       "https://flagshipserver.com/api/order/AB12_cd-34/health")
        XCTAssertNil(VMServerHealth.orderHealthURL(serial: "../x/../y"))
        XCTAssertNil(VMServerHealth.orderHealthURL(serial: "short"))
    }
}
