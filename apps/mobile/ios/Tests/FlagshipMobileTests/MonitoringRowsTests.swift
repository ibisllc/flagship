import XCTest
@testable import FlagshipUI
@testable import FlagshipAPI

/// The server page's single Monitoring pane: row order, names and the short
/// value each row shows collapsed. Android and the webapp mirror these.
final class MonitoringRowsTests: XCTestCase {
    private let now: Int64 = 1_760_000_000_000
    private let gb: Int64 = 1024 * 1024 * 1024

    private func metrics(diskUsed: Int64 = 50) -> ServerMetricsResponse {
        ServerMetricsResponse(
            collectedAt: now, cpuPercent: 23.4,
            loadAvg1: 0.5, loadAvg5: 0.6, loadAvg15: 0.7,
            memUsedBytes: 4 * gb, memTotalBytes: 16 * gb,
            diskUsedBytes: diskUsed * gb, diskTotalBytes: 100 * gb,
            diskIOReadBytesPerSec: 0, diskIOWriteBytesPerSec: 0,
            netRxBytesPerSec: 2048, netTxBytesPerSec: 3 * 1024 * 1024,
            cpuHistory: [], memHistory: [], ioHistory: [], netHistory: []
        )
    }

    private func health(receivedAt: Int64? = nil, tunnel: Bool = true) -> BoxHealth {
        BoxHealth(at: now, uptimeS: 3600, memTotalMB: 4096, memAvailMB: 2048, swapUsedMB: 0,
                  oomKills: 0, daemon: .init(state: "active", restarts: 0, lastExit: 0),
                  tunnel: tunnel, diskUsedPct: 40, receivedAt: receivedAt ?? now)
    }

    private func cert(_ notAfter: Int64?) -> MonitoringCert {
        MonitoringCert(notAfter: notAfter, notBefore: nil, issuer: nil, sans: [])
    }

    func test_orderAndLabels() {
        let rows = MonitoringRows.build(
            health: health(), metrics: .loaded(metrics()), cert: cert(now + 86_400_000 * 40), nowMs: now
        )
        XCTAssertEqual(rows.map(\.title), ["Health", "CPU", "Memory", "Disk", "Network", "Certificate"])
        XCTAssertEqual(rows.map(\.key), MonitoringRow.Key.allCases)
    }

    func test_collapsedValues() {
        let rows = MonitoringRows.build(
            health: health(), metrics: .loaded(metrics()), cert: cert(now + 86_400_000 * 40), nowMs: now
        )
        let v = Dictionary(uniqueKeysWithValues: rows.map { ($0.key, $0.value) })
        XCTAssertEqual(v[.health], "Healthy")
        XCTAssertEqual(v[.cpu], "23%")
        XCTAssertEqual(v[.memory], "4.0 GB of 16.0 GB")
        XCTAssertEqual(v[.disk], "50% used")
        XCTAssertEqual(v[.network], "↓ 2 KB/s  ↑ 3.0 MB/s")
        XCTAssertTrue(v[.certificate]??.hasPrefix("Valid until ") ?? false)
    }

    func test_healthProblemsAndStaleReports() {
        let bad = MonitoringRows.build(health: health(tunnel: false), metrics: nil, cert: nil, nowMs: now)
        XCTAssertEqual(bad.map(\.title), ["Health"])
        XCTAssertEqual(bad.first?.value, "Needs attention")
        XCTAssertEqual(bad.first?.tone, .warning)
        let stale = MonitoringRows.build(health: health(receivedAt: now - 10 * 60_000), metrics: nil, cert: nil, nowMs: now)
        XCTAssertEqual(stale.first?.value, "No report")
    }

    func test_loadingAndFailedMetrics() {
        let loading = MonitoringRows.build(health: nil, metrics: .loading, cert: nil, nowMs: now)
        XCTAssertEqual(loading.map(\.title), ["CPU", "Memory", "Disk", "Network"])
        XCTAssertTrue(loading.allSatisfy { $0.value == nil })
        let failed = MonitoringRows.build(health: nil, metrics: .failed("down"), cert: nil, nowMs: now)
        XCTAssertTrue(failed.allSatisfy { $0.value == "Unavailable" })
    }

    func test_diskTone() {
        func tone(_ used: Int64) -> MonitoringRow.Tone? {
            MonitoringRows.build(health: nil, metrics: .loaded(metrics(diskUsed: used)), cert: nil, nowMs: now)
                .first { $0.key == .disk }?.tone
        }
        XCTAssertEqual(tone(50), .normal)
        XCTAssertEqual(tone(80), .warning)
        XCTAssertEqual(tone(95), .danger)
    }

    func test_certificateStates() {
        let pending = MonitoringRows.build(health: nil, metrics: nil, cert: cert(nil), nowMs: now)
        XCTAssertEqual(pending.first?.value, "Provisioning")
        let expired = MonitoringRows.build(health: nil, metrics: nil, cert: cert(now - 1), nowMs: now)
        XCTAssertEqual(expired.first?.value, "Expired")
        XCTAssertEqual(expired.first?.tone, .danger)
    }

    func test_percentGuardsAnEmptyTotal() {
        XCTAssertEqual(MonitoringRows.percent(5, of: 0), 0)
        XCTAssertEqual(MonitoringRows.percent(150, of: 100), 1)
    }
}
