import XCTest
@testable import FlagshipAPI

final class MockScreensClientTests: XCTestCase {

    private func makeClient() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0   // keep tests snappy
        return c
    }

    func test_serverDetail_returnsConsistentSnapshot() async throws {
        let c = makeClient()
        let d = try await c.serverDetail()
        XCTAssertEqual(d.username, "harry")
        XCTAssertEqual(d.serverFqdn, "home.harry.flagship.services")
        XCTAssertGreaterThan(d.appCount, 0)
        XCTAssertFalse(d.recentInstallEvents.isEmpty)
    }

    func test_appsList_returnsKnownApps() async throws {
        let c = makeClient()
        let r = try await c.appsList()
        XCTAssertEqual(r.apps.map(\.appId).sorted(), ["pad", "plants", "wiki"])
    }

    func test_appDetail_returnsRequestedApp() async throws {
        let c = makeClient()
        let r = try await c.appDetail(appId: "plants")
        XCTAssertEqual(r.app.appId, "plants")
        XCTAssertFalse(r.recentLogs.isEmpty)
    }

    func test_appDetail_throwsOnUnknownApp() async {
        let c = makeClient()
        do {
            _ = try await c.appDetail(appId: "nope")
            XCTFail("expected throw")
        } catch let ScreensClientError.http(status, _) {
            XCTAssertEqual(status, 404)
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }

    func test_serverMetrics_returnsSixtySamples() async throws {
        let c = makeClient()
        let m = try await c.serverMetrics(podId: "home")
        XCTAssertEqual(m.cpuHistory.count, 60)
        XCTAssertEqual(m.memHistory.count, 60)
        XCTAssertEqual(m.ioHistory.count, 60)
        XCTAssertEqual(m.netHistory.count, 60)
        XCTAssertGreaterThan(m.memTotalBytes, m.memUsedBytes)
        XCTAssertGreaterThan(m.diskTotalBytes, m.diskUsedBytes)
        XCTAssertTrue(m.cpuPercent >= 0 && m.cpuPercent <= 100)
    }

    func test_serverMetrics_yieldsDistinctSeriesAcrossPods() async throws {
        let c = makeClient()
        let home = try await c.serverMetrics(podId: "home")
        let office = try await c.serverMetrics(podId: "office")
        XCTAssertNotEqual(home.cpuHistory.map(\.value), office.cpuHistory.map(\.value))
    }

    func test_marketplaceBrowse_returnsListings() async throws {
        let c = makeClient()
        let r = try await c.marketplaceBrowse()
        XCTAssertFalse(r.listings.isEmpty)
        XCTAssertTrue(r.listings.contains(where: { $0.alreadyInstalled }))
    }

    func test_ordersSend_succeeds() async throws {
        let c = makeClient()
        let r = try await c.ordersSend(.init(envelope: "Zm9v", kind: "app-policy/v1"))
        XCTAssertTrue(r.ok)
    }

    func test_shouldFail_propagatesAsHttp503() async {
        let c = makeClient()
        c.shouldFail = true
        do {
            _ = try await c.serverDetail()
            XCTFail("expected failure")
        } catch let ScreensClientError.http(status, _) {
            XCTAssertEqual(status, 503)
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }

    // P1.23 post-recovery status

    func test_postRecoveryStatus_defaultIsNullReport() async throws {
        let c = makeClient()
        let r = try await c.postRecoveryStatus()
        XCTAssertNil(r.report)
    }

    func test_postRecoveryStatus_reflectsInjectedSnapshot() async throws {
        let c = makeClient()
        let report = ReissuanceReportPayload(
            startedAt: 1, completedAt: 2, status: "complete",
            oldIrkPrefix: "aaaaaaaaaaaa", newIrkPrefix: "bbbbbbbbbbbb",
            apps: [
                AppReissuanceSummary(
                    appId: "alice--demo", slug: "demo",
                    rewrittenCount: 3, unchangedCount: 0, error: nil, completedAt: 2
                ),
            ],
            totalRewritten: 3, reattachedCount: 1, unchangedCount: 0,
            undoWindowExpiresAt: 99
        )
        c.postRecoveryReport = PostRecoverySnapshot(
            currentIrkPubHex: "dd".replacingOccurrences(of: " ", with: "") + String(repeating: "dd", count: 31),
            state: WatcherState(
                lastSeen: nil, lastSwapTo: "ee", lastSwapAt: 5,
                lastPolledAt: 6, lastError: nil
            ),
            lastReissue: report
        )
        let r = try await c.postRecoveryStatus()
        XCTAssertNotNil(r.report)
        XCTAssertEqual(r.report?.lastReissue?.totalRewritten, 3)
        XCTAssertEqual(r.report?.lastReissue?.apps.first?.slug, "demo")
    }
}
