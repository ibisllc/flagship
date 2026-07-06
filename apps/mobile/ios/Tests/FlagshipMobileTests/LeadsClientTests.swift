import XCTest
@testable import FlagshipCore
@testable import FlagshipAPI

/// Direct (box-read) per-service leadership: the `/api/leads` decode + the
/// global→per-pod inversion that lets the existing badge render from the
/// fresher source while falling back to the `.com` relay on any failure.
final class LeadsClientTests: XCTestCase {

    private func data(_ s: String) -> Data { Data(s.utf8) }

    // MARK: decode

    func testDecodeMapWithGossipActive() {
        let body = """
        {
          "asOf": 1700000000000,
          "self": "alpha.harry.flagship.services",
          "gossipActive": true,
          "leads": {
            "photos": { "leaderFqdn": "alpha.harry.flagship.services", "leaderStkHex": "aa", "live": true },
            "blog":   { "leaderFqdn": "beta.harry.flagship.services",  "leaderStkHex": "bb", "live": false }
          }
        }
        """
        let map = LiveLeadsClient.decode(data(body))
        XCTAssertNotNil(map)
        XCTAssertEqual(map?.asOf, 1700000000000)
        XCTAssertEqual(map?.selfFqdn, "alpha.harry.flagship.services")
        XCTAssertTrue(map?.gossipActive ?? false)
        XCTAssertEqual(map?.leads.count, 2)
        XCTAssertEqual(map?.leads["photos"]?.leaderFqdn, "alpha.harry.flagship.services")
        XCTAssertEqual(map?.leads["photos"]?.live, true)
        XCTAssertEqual(map?.leads["blog"]?.leaderFqdn, "beta.harry.flagship.services")
        XCTAssertEqual(map?.leads["blog"]?.live, false)
    }

    func testDecodeReturnsNilWhenGossipInactive() {
        let body = """
        { "asOf": 1, "self": "alpha.harry.flagship.services", "gossipActive": false,
          "leads": { "photos": { "leaderFqdn": "alpha.harry.flagship.services", "leaderStkHex": "aa", "live": true } } }
        """
        XCTAssertNil(LiveLeadsClient.decode(data(body)))
    }

    func testDecodeIsLenientDropsBadEntryKeepsGood() {
        // One entry missing leaderFqdn (dropped) + one garbled (not an object,
        // dropped) — the good one survives; the whole map does not fail.
        let body = """
        { "asOf": 5, "self": "alpha", "gossipActive": true,
          "leads": {
            "good": { "leaderFqdn": "alpha", "live": true },
            "nofqdn": { "leaderStkHex": "cc", "live": true },
            "garbled": "nope"
          } }
        """
        let map = LiveLeadsClient.decode(data(body))
        XCTAssertNotNil(map)
        XCTAssertEqual(map?.leads.count, 1)
        XCTAssertNotNil(map?.leads["good"])
        // Missing leaderStkHex defaults to "" rather than failing.
        XCTAssertEqual(map?.leads["good"]?.leaderStkHex, "")
        XCTAssertNil(map?.leads["nofqdn"])
        XCTAssertNil(map?.leads["garbled"])
    }

    func testDecodeReturnsNilOnNonObject() {
        XCTAssertNil(LiveLeadsClient.decode(data("not json")))
        XCTAssertNil(LiveLeadsClient.decode(data("[1,2,3]")))
    }

    // MARK: live client — 404 / error → nil (pre-/api/leads box, network blip)

    func testFetchReturns404AsNil() async {
        let session = Self.stubbedSession(status: 404, body: "Not Found")
        let client = LiveLeadsClient(urlSession: session)
        let map = await client.fetchLeads(podFqdn: "old.harry.flagship.services")
        XCTAssertNil(map)
    }

    func testFetchDecodesA200Map() async {
        let body = """
        { "asOf": 9, "self": "alpha.harry.flagship.services", "gossipActive": true,
          "leads": { "photos": { "leaderFqdn": "alpha.harry.flagship.services", "leaderStkHex": "aa", "live": true } } }
        """
        let session = Self.stubbedSession(status: 200, body: body)
        let client = LiveLeadsClient(urlSession: session)
        let map = await client.fetchLeads(podFqdn: "alpha.harry.flagship.services")
        XCTAssertNotNil(map)
        XCTAssertEqual(map?.leads["photos"]?.leaderFqdn, "alpha.harry.flagship.services")
    }

    // MARK: inversion (global slug→leaderFqdn  →  per-pod fqdn→[slugs])

    func testInversionGroupsSlugsUnderMatchedFqdn() {
        let leads: [String: LeadEntry] = [
            "photos": LeadEntry(leaderFqdn: "alpha.harry.flagship.services", leaderStkHex: "a", live: true),
            "notes":  LeadEntry(leaderFqdn: "alpha.harry.flagship.services", leaderStkHex: "a", live: true),
            "blog":   LeadEntry(leaderFqdn: "beta.harry.flagship.services",  leaderStkHex: "b", live: true),
        ]
        let known = ["alpha.harry.flagship.services", "beta.harry.flagship.services"]
        let out = DirectLeadsInversion.invert(leads: leads, knownFqdns: known)
        // Slugs sorted, grouped under their leader's lowercased fqdn.
        XCTAssertEqual(out["alpha.harry.flagship.services"], ["notes", "photos"])
        XCTAssertEqual(out["beta.harry.flagship.services"], ["blog"])
    }

    func testInversionDropsUnknownLeaderFqdn() {
        // A slug led by a box this account doesn't show is dropped (no pod to
        // badge), so the inversion is empty and applying it is a no-op.
        let leads: [String: LeadEntry] = [
            "ghost": LeadEntry(leaderFqdn: "elsewhere.other.flagship.services", leaderStkHex: "z", live: true),
        ]
        let out = DirectLeadsInversion.invert(leads: leads, knownFqdns: ["alpha.harry.flagship.services"])
        XCTAssertTrue(out.isEmpty)
    }

    func testInversionMatchesCaseInsensitively() {
        let leads: [String: LeadEntry] = [
            "photos": LeadEntry(leaderFqdn: "Alpha.Harry.Flagship.Services", leaderStkHex: "a", live: true),
        ]
        let out = DirectLeadsInversion.invert(leads: leads, knownFqdns: ["alpha.harry.flagship.services"])
        XCTAssertEqual(out["alpha.harry.flagship.services"], ["photos"])
    }

    // MARK: AppState prefer-over-relay

    @MainActor
    func testApplyDirectLeadsOverridesRelayValuePerPod() {
        let app = AppState()
        app.upsertRegisteredPod(fqdn: "alpha.harry.flagship.services", name: "Alpha",
                                liveness: .live, leadsServices: ["photos"])
        app.upsertRegisteredPod(fqdn: "beta.harry.flagship.services", name: "Beta",
                                liveness: .live, leadsServices: ["blog"])

        // Direct view: alpha now leads photos+notes; beta yielded blog (empty).
        app.applyDirectLeads([
            "alpha.harry.flagship.services": ["notes", "photos"],
            "beta.harry.flagship.services": [],
        ])

        let alpha = app.pods.first { $0.fqdn == "alpha.harry.flagship.services" }
        let beta = app.pods.first { $0.fqdn == "beta.harry.flagship.services" }
        XCTAssertEqual(alpha?.leadsServices, ["notes", "photos"])
        // An empty direct list OVERRIDES the stale relay badge (yielded service).
        XCTAssertEqual(beta?.leadsServices, [])
    }

    @MainActor
    func testApplyDirectLeadsLeavesUnmatchedPodsOnRelayValue() {
        let app = AppState()
        app.upsertRegisteredPod(fqdn: "alpha.harry.flagship.services", name: "Alpha",
                                liveness: .live, leadsServices: ["photos"])
        // A map that says nothing about alpha — its relay value must stand.
        app.applyDirectLeads(["beta.harry.flagship.services": ["blog"]])
        let alpha = app.pods.first { $0.fqdn == "alpha.harry.flagship.services" }
        XCTAssertEqual(alpha?.leadsServices, ["photos"])
    }

    @MainActor
    func testApplyDirectLeadsEmptyMapIsNoOp() {
        let app = AppState()
        app.upsertRegisteredPod(fqdn: "alpha.harry.flagship.services", name: "Alpha",
                                liveness: .live, leadsServices: ["photos"])
        app.applyDirectLeads([:])
        let alpha = app.pods.first { $0.fqdn == "alpha.harry.flagship.services" }
        XCTAssertEqual(alpha?.leadsServices, ["photos"])
    }

    // MARK: stub URLSession (reuses the shared StubURLProtocol from
    // FlagshipServerClientTests — one handler closure per session)

    private static func stubbedSession(status: Int, body: String) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        StubURLProtocol.handler = { req in
            let resp = HTTPURLResponse(
                url: req.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (resp, Data(body.utf8))
        }
        return URLSession(configuration: config)
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }
}
