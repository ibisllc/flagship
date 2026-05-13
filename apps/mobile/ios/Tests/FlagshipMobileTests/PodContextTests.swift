import XCTest
@testable import FlagshipAPI

final class PodContextTests: XCTestCase {

    func test_mockServerDetail_variesByPodContext() async throws {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        c.podContext = "home"
        let home = try await c.serverDetail()
        c.podContext = "office"
        let office = try await c.serverDetail()
        XCTAssertEqual(home.serverFqdn, "home.harry.flagship.services")
        XCTAssertEqual(office.serverFqdn, "office.harry.flagship.services")
        XCTAssertTrue(home.certSans?.contains("home.harry.flagship.services") ?? false)
        XCTAssertTrue(office.certSans?.contains("office.harry.flagship.services") ?? false)
    }

    func test_mockServerMetrics_yieldsDistinctSeriesPerPod() async throws {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        let home = try await c.serverMetrics(podId: "home")
        let office = try await c.serverMetrics(podId: "office")
        XCTAssertNotEqual(home.cpuHistory.map(\.value), office.cpuHistory.map(\.value))
        XCTAssertNotEqual(home.netHistory.map(\.read), office.netHistory.map(\.read))
    }
}
