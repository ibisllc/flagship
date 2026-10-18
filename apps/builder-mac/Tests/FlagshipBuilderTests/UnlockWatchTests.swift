import XCTest
@testable import FlagshipBuilderCore

/// A hosted server's name must not be looked up before the box has reported
/// in: the name does not exist until the box registers it, and routers cache
/// the NXDOMAIN for the zone's negative TTL (30 minutes seen on Windows
/// 2026-10-18), which left Studio on "Waiting for you to unlock" for a healthy
/// server.
final class UnlockWatchTests: XCTestCase {
    private let domain = "home.u-x.flagship.services"
    private let healthURL = URL(string: "https://flagshipserver.com/api/order/AB12cd34ef56/health")!
    private let poweredOn = Date(timeIntervalSince1970: 1_800_000_000)

    private func body(receivedAt: Date, uptimeS: Int, daemon: String = "active", tunnel: Bool = true) -> Data {
        Data("""
        {"serverDomain":"\(domain)","health":{"v":1,"uptimeS":\(uptimeS),"memTotalMB":3900,"memAvailMB":800,\
        "oomKills":0,"daemon":{"state":"\(daemon)","restarts":0,"lastExit":0},"tunnel":\(tunnel),\
        "diskUsedPct":5,"receivedAt":\(Int64(receivedAt.timeIntervalSince1970 * 1000))}}
        """.utf8)
    }

    private actor Recorder {
        var polls: [URL] = []
        var lookedUp: [URL] = []
        func poll(_ url: URL) -> Int { polls.append(url); return polls.count }
        func look(_ url: URL) -> Int { lookedUp.append(url); return lookedUp.count }
    }

    func testNoNameLookupHappensBeforeOrAfterTheFirstHealthReport() async {
        let recorder = Recorder()
        let reportedAt = poweredOn.addingTimeInterval(49)
        let now = poweredOn.addingTimeInterval(50)
        let report = body(receivedAt: reportedAt, uptimeS: 40)
        let unlocked = await UnlockWatch.run(
            serverDomain: domain, healthURL: healthURL, poweredOnAt: poweredOn,
            now: { now },
            fetchHealth: { url in
                // The box finally reports in on the third ask.
                await recorder.poll(url) >= 3 ? report : nil
            },
            probeName: { url in _ = await recorder.look(url); return true },
            interval: .milliseconds(5))
        XCTAssertTrue(unlocked)
        let polls = await recorder.polls
        XCTAssertGreaterThanOrEqual(polls.count, 3)
        XCTAssertTrue(polls.allSatisfy { $0 == healthURL })
        let looked = await recorder.lookedUp
        XCTAssertTrue(looked.isEmpty)
    }

    func testAReportFromThePreviousBootOrAnUnreadyDaemonDoesNotCount() async {
        let recorder = Recorder()
        let now = poweredOn.addingTimeInterval(30)
        let bodies: [Data?] = [
            body(receivedAt: poweredOn.addingTimeInterval(-10), uptimeS: 3000),
            body(receivedAt: now, uptimeS: 20, daemon: "activating"),
            body(receivedAt: now, uptimeS: 20, tunnel: false),
            nil,
        ]
        let task = Task {
            await UnlockWatch.run(
                serverDomain: domain, healthURL: healthURL, poweredOnAt: poweredOn,
                now: { now },
                fetchHealth: { url in
                    let n = await recorder.poll(url)
                    return n <= bodies.count ? bodies[n - 1] : nil
                },
                probeName: { url in _ = await recorder.look(url); return true },
                interval: .milliseconds(5))
        }
        while await recorder.polls.count < 6 { try? await Task.sleep(for: .milliseconds(5)) }
        task.cancel()
        let unlocked = await task.value
        XCTAssertFalse(unlocked)
        let looked = await recorder.lookedUp
        XCTAssertTrue(looked.isEmpty)
    }

    func testAServerWithoutAnOrderSerialFallsBackToItsName() async {
        let recorder = Recorder()
        let unlocked = await UnlockWatch.run(
            serverDomain: domain, healthURL: nil, poweredOnAt: poweredOn,
            now: { self.poweredOn },
            fetchHealth: { url in _ = await recorder.poll(url); return nil },
            probeName: { url in await recorder.look(url) >= 2 },
            interval: .milliseconds(5))
        XCTAssertTrue(unlocked)
        let polls = await recorder.polls
        XCTAssertTrue(polls.isEmpty)
        let looked = await recorder.lookedUp
        XCTAssertEqual(looked.first?.absoluteString, "https://\(domain)/")
    }
}
