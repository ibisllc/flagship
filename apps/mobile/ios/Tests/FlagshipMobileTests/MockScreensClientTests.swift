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
        XCTAssertEqual(d.username, "bright-maple")
        XCTAssertEqual(d.serverFqdn, "home.bright-maple.flagship.services")
        XCTAssertGreaterThan(d.serviceCount, 0)
        XCTAssertFalse(d.recentInstallEvents.isEmpty)
    }

    func test_appsList_returnsKnownApps() async throws {
        let c = makeClient()
        let r = try await c.appsList()
        // serviceId is the immutable composite `<creator>--<slug>`.
        XCTAssertEqual(
            r.apps.map(\.serviceId).sorted(),
            ["bright-maple--plants", "bright-maple--wiki", "trent--scratchpad"]
        )
    }

    func test_appDetail_returnsRequestedApp() async throws {
        let c = makeClient()
        let r = try await c.appDetail(serviceId: "bright-maple--plants")
        XCTAssertEqual(r.app.serviceId, "bright-maple--plants")
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
        let r = try await c.serviceEnvList(appId: "bright-maple--plants")
        // The mock seeds WEATHER_API_KEY by default; the response shape
        // is name-only by construction (ServiceEnvListResponse has no
        // `values` field).
        XCTAssertTrue(r.names.contains("WEATHER_API_KEY"))
    }

    func test_serviceEnvSet_then_list_includesNewName() async throws {
        let c = makeClient()
        let change = ServiceEnvChange.make(serverId: "home.bright-maple.flagship.services",
                                           serviceId: "bright-maple--plants", set: "FOO", value: "bar-NEVER-LEAKED")
        let _ = try await c.serviceEnvSet(
            appId: "bright-maple--plants",
            ServiceEnvSetRequest(change: change, value: "bar-NEVER-LEAKED", signature: "00")
        )
        let r = try await c.serviceEnvList(appId: "bright-maple--plants")
        XCTAssertTrue(r.names.contains("FOO"))
        // The other variable stays.
        XCTAssertTrue(r.names.contains("WEATHER_API_KEY"))
    }

    func test_serviceEnvUnset_dropsOnlyItsName() async throws {
        let c = makeClient()
        let set = ServiceEnvChange.make(serverId: "home.bright-maple.flagship.services",
                                        serviceId: "bright-maple--plants", set: "FOO", value: "x")
        _ = try await c.serviceEnvSet(appId: "bright-maple--plants", ServiceEnvSetRequest(change: set, value: "x", signature: "00"))
        let change = ServiceEnvChange.make(serverId: "home.bright-maple.flagship.services",
                                           serviceId: "bright-maple--plants", unset: "WEATHER_API_KEY")
        let _ = try await c.serviceEnvUnset(
            appId: "bright-maple--plants",
            ServiceEnvUnsetRequest(change: change, signature: "00")
        )
        let r = try await c.serviceEnvList(appId: "bright-maple--plants")
        XCTAssertFalse(r.names.contains("WEATHER_API_KEY"))
        XCTAssertTrue(r.names.contains("FOO"))
    }

    func test_serviceEnv_refusesAReplayAValueMismatchAndAnotherApp() async throws {
        let c = makeClient()
        let unset = ServiceEnvChange.make(serverId: "home.bright-maple.flagship.services",
                                          serviceId: "bright-maple--plants", unset: "WEATHER_API_KEY")
        _ = try await c.serviceEnvUnset(appId: "bright-maple--plants", ServiceEnvUnsetRequest(change: unset, signature: "00"))
        do {
            _ = try await c.serviceEnvUnset(appId: "bright-maple--plants", ServiceEnvUnsetRequest(change: unset, signature: "00"))
            XCTFail("a replayed change must be refused")
        } catch let ScreensClientError.http(status, message) {
            XCTAssertEqual(status, 400)
            XCTAssertTrue(message.contains("already applied"))
        }
        let set = ServiceEnvChange.make(serverId: "home.bright-maple.flagship.services",
                                        serviceId: "bright-maple--plants", set: "FOO", value: "real")
        do {
            _ = try await c.serviceEnvSet(appId: "bright-maple--plants", ServiceEnvSetRequest(change: set, value: "swapped", signature: "00"))
            XCTFail("a swapped value must be refused")
        } catch let ScreensClientError.http(_, message) {
            XCTAssertTrue(message.contains("doesn't match"))
        }
        do {
            _ = try await c.serviceEnvSet(appId: "bright-maple--wiki", ServiceEnvSetRequest(change: set, value: "real", signature: "00"))
            XCTFail("a change for another app must be refused")
        } catch let ScreensClientError.http(_, message) {
            XCTAssertTrue(message.contains("another app"))
        }
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
