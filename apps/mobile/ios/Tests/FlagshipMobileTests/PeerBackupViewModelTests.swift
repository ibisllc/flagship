import XCTest
@testable import FlagshipAPI
@testable import FlagshipUI

/// P9 — PeerBackupViewModel state machine + the wire shape it renders.
///
/// Mirrors the canonical webapp `views/peer-backup.js`:
///   - `peerBackupStatus()` returns a `PeerBackupStatusResponse` with
///     participating + the two peer lists + shards + repair + stats.
///   - The VM exposes the response through a `LoadingState`; the screen
///     pivots on it.
@MainActor
final class PeerBackupViewModelTests: XCTestCase {

    private func makeClient() -> MockScreensClient {
        let c = MockScreensClient()
        c.simulatedLatency = 0
        return c
    }

    // MARK: - Default fixture (mirrors the Android default)

    func test_mockFixture_defaultIsHonestEmpty() async throws {
        let client = makeClient()
        let r = try await client.peerBackupStatus()
        XCTAssertFalse(r.participating)
        XCTAssertTrue(r.peersBackingYouUp.isEmpty)
        XCTAssertTrue(r.peersYouBackUp.isEmpty)
        XCTAssertTrue(r.shards.isEmpty)
        XCTAssertEqual(r.stats.total, 0)
        XCTAssertEqual(r.stats.durable, 0)
        XCTAssertEqual(r.stats.atRisk, 0)
        XCTAssertEqual(r.stats.yourBytesStored, 0)
        XCTAssertEqual(r.stats.peerBytesHosted, 0)
        XCTAssertEqual(r.repair.state, "idle")
        XCTAssertNil(r.repair.lastTickMs)
        XCTAssertEqual(r.repair.queued, 0)
        XCTAssertEqual(r.repair.completed24h, 0)
        XCTAssertNil(r.repair.lastError)
    }

    // MARK: - load()

    func test_load_idle_toLoaded_withDefaultFixture() async {
        let client = makeClient()
        let vm = PeerBackupViewModel(client: client)
        await vm.load()
        guard case .loaded(let s) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertFalse(s.participating)
        XCTAssertTrue(s.peersBackingYouUp.isEmpty)
    }

    func test_load_pinnedFixture_isReturnedVerbatim() async {
        let client = makeClient()
        client.peerBackupStatusFixture = PeerBackupStatusResponse(
            participating: true,
            peersBackingYouUp: [
                PeerBackupPeerHostingYou(
                    peerFqdn: "bob.bob.flagship.services",
                    shardsHosted: 4, lastSeenMs: 1_700_000_000_000, online: true
                ),
            ],
            peersYouBackUp: [
                PeerBackupPeerYouHost(
                    peerFqdn: "carol.carol.flagship.services",
                    shardsHosted: 7, bytesHosted: 1024 * 1024,
                    lastFetchedMs: 1_700_000_001_000
                ),
            ],
            shards: [
                PeerBackupShardSummary(
                    shardId: "deadbeef", replicas: 3, minReplicas: 3, bytes: 0
                ),
                PeerBackupShardSummary(
                    shardId: "feedface", replicas: 1, minReplicas: 3, bytes: 0
                ),
            ],
            repair: PeerBackupRepairStatus(
                state: "running", lastTickMs: 1_700_000_002_000,
                queued: 2, completed24h: 17, lastError: nil
            ),
            stats: PeerBackupStats(
                total: 2, durable: 1, atRisk: 1,
                yourBytesStored: 0, peerBytesHosted: 1024 * 1024
            )
        )
        let vm = PeerBackupViewModel(client: client)
        await vm.load()
        guard case .loaded(let s) = vm.state else {
            XCTFail("expected loaded, got \(vm.state)"); return
        }
        XCTAssertTrue(s.participating)
        XCTAssertEqual(s.peersBackingYouUp.count, 1)
        XCTAssertEqual(s.peersBackingYouUp.first?.peerFqdn, "bob.bob.flagship.services")
        XCTAssertEqual(s.peersBackingYouUp.first?.shardsHosted, 4)
        XCTAssertTrue(s.peersBackingYouUp.first!.online)
        XCTAssertEqual(s.peersYouBackUp.first?.bytesHosted, 1024 * 1024)
        XCTAssertEqual(s.shards.count, 2)
        XCTAssertEqual(s.stats.atRisk, 1)
        XCTAssertEqual(s.repair.state, "running")
        XCTAssertEqual(s.repair.completed24h, 17)
    }

    func test_load_failure_surfacesAsFailed() async {
        let client = makeClient()
        client.shouldFail = true
        let vm = PeerBackupViewModel(client: client)
        await vm.load()
        if case .failed = vm.state {
            // expected
        } else {
            XCTFail("expected .failed, got \(vm.state)")
        }
    }

    // MARK: - v2 screen

    private func v2(state: String = "protected") -> PeerBackupStatusResponse {
        let json = """
        {"v":2,"state":"\(state)","reason":"","lastPlacedAt":1700000000000,"healthyBricks":6,"totalBricks":8,
         "holders":2,"archiveId":null,"hostingBytes":0,"provenBytes":0,"poolBytes":0,"policy":"peer",
         "archiveCreatedAt":1700000000000,"keepUntil":4102444800000,
         "holderList":[{"label":"Server 1","state":"ok","lastProofAt":1700000001000,"bricks":4},
                       {"label":"Server 2","state":"offline","lastProofAt":null,"bricks":4}],
         "hosting":{"poolBytes":5368709120,"realBytes":2147483648,"fillerBytes":3221225472,"provenBytes":1073741824,"leases":3,"bricks":9,"reliability":88,"leaving":false},
         "participating":true,"peersBackingYouUp":[],"peersYouBackUp":[],"shards":[],
         "repair":{"state":"idle","lastTickMs":null,"queued":2,"completed24h":0},
         "stats":{"total":8,"durable":6,"atRisk":2,"yourBytesStored":0,"peerBytesHosted":2147483648}}
        """
        return try! JSONDecoder().decode(PeerBackupStatusResponse.self, from: Data(json.utf8))
    }

    func test_v2_decodesTheBoxScreenAndKeepsTheV1Fields() {
        let s = v2()
        XCTAssertEqual(s.v, 2)
        XCTAssertEqual(s.state, "protected")
        XCTAssertEqual(s.healthyBricks, 6)
        XCTAssertEqual(s.holderList?.count, 2)
        XCTAssertNil(s.holderList?[1].lastProofAt)
        XCTAssertEqual(s.hosting?.reliability, 88)
        XCTAssertTrue(s.participating)
        XCTAssertEqual(s.stats.atRisk, 2)
    }

    func test_v2_holdersAreNeverNamedAndShowTheirProof() async {
        let client = makeClient()
        client.peerBackupStatusFixture = v2()
        let vm = PeerBackupViewModel(client: client)
        await vm.load()
        XCTAssertFalse(vm.isOlderBox)
        XCTAssertEqual(vm.holderRows.map(\.label), ["Server 1", "Server 2"])
        XCTAssertTrue(vm.holderRows[0].line.hasPrefix("Answering · last proof "))
        XCTAssertTrue(vm.holderRows[0].line.hasSuffix(" · 4 pieces"))
        XCTAssertEqual(vm.holderRows[1].line, "Offline · no proof yet · 4 pieces")
        XCTAssertTrue(vm.restoreByLine.hasPrefix("Restore by "))
        XCTAssertEqual(vm.hostingLines.first, "Pool: 5.0 GB, of which 2.0 GB holds other servers' pieces and 3.0 GB is proof filler.")
    }

    func test_olderBoxIsNamedAsOlder() async {
        let client = makeClient()
        client.peerBackupStatusFixture = PeerBackupStatusResponse(
            participating: false, peersBackingYouUp: [], peersYouBackUp: [], shards: [],
            repair: PeerBackupRepairStatus(state: "idle", lastTickMs: nil, queued: 0, completed24h: 0, lastError: nil),
            stats: PeerBackupStats(total: 0, durable: 0, atRisk: 0, yourBytesStored: 0, peerBytesHosted: 0))
        let vm = PeerBackupViewModel(client: client)
        await vm.load()
        XCTAssertTrue(vm.isOlderBox)
    }

    // MARK: - Wire-shape codable round-trip

    func test_statusResponse_codable_roundTrips() throws {
        let original = PeerBackupStatusResponse(
            participating: true,
            peersBackingYouUp: [
                PeerBackupPeerHostingYou(peerFqdn: "x.flagship.services",
                                        shardsHosted: 2,
                                        lastSeenMs: 1_700_000_000_000,
                                        online: false),
            ],
            peersYouBackUp: [
                PeerBackupPeerYouHost(peerFqdn: "y.flagship.services",
                                      shardsHosted: 3,
                                      bytesHosted: 99,
                                      lastFetchedMs: 1_700_000_001_000),
            ],
            shards: [PeerBackupShardSummary(shardId: "ab", replicas: 3,
                                            minReplicas: 3, bytes: 0)],
            repair: PeerBackupRepairStatus(state: "error",
                                            lastTickMs: 1_700_000_002_000,
                                            queued: 1, completed24h: 2,
                                            lastError: "peer offline"),
            stats: PeerBackupStats(total: 1, durable: 1, atRisk: 0,
                                    yourBytesStored: 0, peerBytesHosted: 99)
        )
        let json = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(PeerBackupStatusResponse.self, from: json)
        XCTAssertEqual(decoded, original)
    }
}
