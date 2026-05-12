import XCTest
@testable import FlagshipAPI

final class ScreensModelsCodableTests: XCTestCase {

    func test_serverDetailResponse_roundTripsThroughJSON() throws {
        let original = ServerDetailResponse(
            serverFqdn: "home.harry.flagship.services",
            username: "harry",
            daemonVersion: "0.18.4",
            startedAt: 1_700_000_000_000,
            uptimeMs: 86_400_000,
            certNotAfter: 1_710_000_000_000,
            certNotBefore: 1_690_000_000_000,
            certSans: ["home.harry.flagship.services", "*.home.harry.flagship.services"],
            appCount: 3,
            pairedSessionCount: 2,
            recentInstallEvents: [
                RecentInstallEvent(at: 1_699_000_000_000, kind: "installed", appId: "plants", detail: "via vibe-code")
            ]
        )
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ServerDetailResponse.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    func test_vibeCodeFrame_roundTripsAllVariants() throws {
        let frames: [VibeCodeFrame] = [
            .token(text: "hello"),
            .manifestEmit(manifestJson: "{\"a\":1}"),
            .repoCreate(repoFullName: "ibisllc/plants"),
            .buildStart,
            .buildLog(line: "step 1/6"),
            .deploy(appId: "plants", url: "https://plants.harry.flagship.services/"),
            .done,
            .error(message: "boom")
        ]
        for frame in frames {
            let data = try JSONEncoder().encode(frame)
            let decoded = try JSONDecoder().decode(VibeCodeFrame.self, from: data)
            XCTAssertEqual(decoded, frame)
        }
    }

    func test_installEvent_roundTripsAllVariants() throws {
        let events: [InstallEvent] = [
            .registered(serial: "ABC123", at: 1),
            .boot(at: 2),
            .tunnelOnline(at: 3),
            .certIssued(at: 4),
            .ready(serverFqdn: "home.harry.flagship.services", at: 5),
            .failed(reason: "no internet", at: 6)
        ]
        for event in events {
            let data = try JSONEncoder().encode(event)
            let decoded = try JSONDecoder().decode(InstallEvent.self, from: data)
            XCTAssertEqual(decoded, event)
        }
    }

    func test_serverMetrics_roundTripsHistoryAndCurrents() throws {
        let now: Int64 = 1_700_000_000_000
        let cpuSamples = (0..<5).map { ServerMetricsResponse.TimedSample(at: now - Int64($0 * 60_000), value: Double($0 * 10)) }
        let ioSamples  = (0..<5).map { ServerMetricsResponse.IOSample(at: now - Int64($0 * 60_000), read: Double($0), write: Double($0) * 2) }
        let original = ServerMetricsResponse(
            collectedAt: now,
            cpuPercent: 23.5,
            loadAvg1: 0.5, loadAvg5: 0.6, loadAvg15: 0.7,
            memUsedBytes: 4 * 1024 * 1024 * 1024,
            memTotalBytes: 16 * 1024 * 1024 * 1024,
            diskUsedBytes: 50 * 1024 * 1024 * 1024,
            diskTotalBytes: 256 * 1024 * 1024 * 1024,
            diskIOReadBytesPerSec: 12345, diskIOWriteBytesPerSec: 6789,
            netRxBytesPerSec: 10000, netTxBytesPerSec: 20000,
            cpuHistory: cpuSamples, memHistory: cpuSamples,
            ioHistory: ioSamples, netHistory: ioSamples
        )
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ServerMetricsResponse.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    func test_unlockApprovalApproveRequest_wireFormat() throws {
        let req = UnlockApprovalApproveRequest(signature: "deadbeef", envelope: "Zm9v")
        let data = try JSONEncoder().encode(req)
        let json = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertTrue(json.contains("\"signature\":\"deadbeef\""))
        XCTAssertTrue(json.contains("\"envelope\":\"Zm9v\""))
    }
}
