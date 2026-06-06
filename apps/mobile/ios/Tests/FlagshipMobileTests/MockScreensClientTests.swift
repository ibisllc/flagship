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
        XCTAssertGreaterThan(d.serviceCount, 0)
        XCTAssertFalse(d.recentInstallEvents.isEmpty)
    }

    func test_appsList_returnsKnownApps() async throws {
        let c = makeClient()
        let r = try await c.appsList()
        // serviceId is the immutable composite `<creator>--<slug>`.
        XCTAssertEqual(
            r.apps.map(\.serviceId).sorted(),
            ["harry--plants", "harry--wiki", "trent--scratchpad"]
        )
    }

    func test_appDetail_returnsRequestedApp() async throws {
        let c = makeClient()
        let r = try await c.appDetail(serviceId: "harry--plants")
        XCTAssertEqual(r.app.serviceId, "harry--plants")
        XCTAssertFalse(r.recentLogs.isEmpty)
    }

    func test_appDetail_throwsOnUnknownApp() async {
        let c = makeClient()
        do {
            _ = try await c.appDetail(serviceId: "nope")
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
                    serviceId: "alice--demo", slug: "demo",
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

    // MARK: - W10 per-app env-var KV editor + vibecode session state

    func test_serviceEnvList_returnsSortedNamesOnly() async throws {
        let c = makeClient()
        let r = try await c.serviceEnvList(appId: "harry--plants")
        // The mock seeds WEATHER_API_KEY by default; the response shape
        // is name-only by construction (ServiceEnvListResponse has no
        // `values` field).
        XCTAssertTrue(r.names.contains("WEATHER_API_KEY"))
    }

    func test_serviceEnvSet_then_list_includesNewName() async throws {
        let c = makeClient()
        let envelope = ServiceEnvSetEnvelope(
            serverId: "home.harry.flagship.services",
            creator: "harry", slug: "plants",
            env: ["FOO": "bar-NEVER-LEAKED"],
            issuedAt: 1
        )
        let _ = try await c.serviceEnvSet(
            appId: "harry--plants",
            ServiceEnvSetRequest(
                name: "FOO", value: "bar-NEVER-LEAKED",
                request: envelope, signature: "00"
            )
        )
        let r = try await c.serviceEnvList(appId: "harry--plants")
        XCTAssertTrue(r.names.contains("FOO"))
    }

    func test_serviceEnvUnset_dropsName() async throws {
        let c = makeClient()
        let envelope = ServiceEnvSetEnvelope(
            serverId: "home.harry.flagship.services",
            creator: "harry", slug: "plants",
            env: [:], issuedAt: 1
        )
        let _ = try await c.serviceEnvUnset(
            appId: "harry--plants",
            ServiceEnvUnsetRequest(name: "WEATHER_API_KEY", request: envelope, signature: "00")
        )
        let r = try await c.serviceEnvList(appId: "harry--plants")
        XCTAssertFalse(r.names.contains("WEATHER_API_KEY"))
    }

    func test_vibeCodeSessionState_surfacesPendingRequestEnvVar() async throws {
        let c = makeClient()
        let r = try await c.vibeCodeSessionState(sessionId: "sess-42")
        XCTAssertEqual(r.status, "awaiting-tool-response")
        guard let pending = r.pendingRequest else {
            return XCTFail("expected pendingRequest")
        }
        switch pending {
        case .requestEnvVar(_, let name, _, _, _, let secret):
            XCTAssertEqual(name, "WEATHER_API_KEY")
            XCTAssertEqual(secret, true)
        case .talkToUser:
            XCTFail("expected requestEnvVar")
        }
    }

    func test_vibeCodePendingRequest_codable_roundTrip() throws {
        // Wire-shape mirror with the daemon — encode + decode the
        // requestEnvVar variant and verify nothing decays.
        let original = VibeCodePendingRequest.requestEnvVar(
            toolUseId: "tu_1",
            name: "OPENAI_API_KEY",
            description: "your key",
            why: "for completions",
            example: "sk-…",
            secret: true
        )
        let data = try JSONEncoder().encode(original)
        // The encoded JSON must NOT carry any "value" key (structural
        // invariant: pendingRequest is value-free).
        let s = String(data: data, encoding: .utf8) ?? ""
        XCTAssertFalse(s.contains("\"value\""))
        let decoded = try JSONDecoder().decode(VibeCodePendingRequest.self, from: data)
        XCTAssertEqual(decoded, original)
    }
}
