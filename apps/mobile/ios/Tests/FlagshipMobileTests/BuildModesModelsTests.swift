import XCTest
@testable import FlagshipAPI

/// Build-a-service wire shapes. Decodes the documented JSON from
/// `docs/build-modes.md` + `buildModesHttp.ts` so the Swift models stay
/// byte-compatible with the live daemon, then round-trips the structs.
final class BuildModesModelsTests: XCTestCase {

    private let dec = JSONDecoder()

    // MARK: - git

    func test_buildGitResponse_fit_decodesFromWireJSON() throws {
        let json = """
        {"buildId":"bld-abc123","fit":true,"reason":"Found flagship.app.json","manifestName":"plants","fileCount":14}
        """
        let r = try dec.decode(BuildGitResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.buildId, "bld-abc123")
        XCTAssertTrue(r.fit)
        XCTAssertEqual(r.reason, "Found flagship.app.json")
        XCTAssertEqual(r.manifestName, "plants")
        XCTAssertEqual(r.fileCount, 14)
    }

    func test_buildGitResponse_notFit_omitsManifestName() throws {
        let json = """
        {"buildId":"bld-x","fit":false,"reason":"No flagship.app.json","fileCount":7}
        """
        let r = try dec.decode(BuildGitResponse.self, from: Data(json.utf8))
        XCTAssertFalse(r.fit)
        XCTAssertNil(r.manifestName)
        XCTAssertEqual(r.fileCount, 7)
    }

    func test_buildGitRequest_encodesWithOptionalRef() throws {
        let withRef = try JSONEncoder().encode(BuildGitRequest(gitUrl: "https://x/y", ref: "main"))
        let obj = try JSONSerialization.jsonObject(with: withRef) as? [String: Any]
        XCTAssertEqual(obj?["gitUrl"] as? String, "https://x/y")
        XCTAssertEqual(obj?["ref"] as? String, "main")
    }

    func test_buildAdaptResponse_decodes() throws {
        let r = try dec.decode(BuildAdaptResponse.self, from: Data(#"{"ok":true,"fileCount":16}"#.utf8))
        XCTAssertTrue(r.ok)
        XCTAssertEqual(r.fileCount, 16)
    }

    // MARK: - mcp

    func test_buildMcpResponse_decodesNestedConnection() throws {
        let json = """
        {"buildId":"bld-mcp1","connection":{"url":"https://home.harry.flagship.services/mcp/build/bld-mcp1","key":"fbk_deadbeef","ideConfig":{"mcpServers":{"flagship-build":{"url":"https://home.harry.flagship.services/mcp/build/bld-mcp1"}}}}}
        """
        let r = try dec.decode(BuildMcpResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.buildId, "bld-mcp1")
        XCTAssertEqual(r.connection.key, "fbk_deadbeef")
        XCTAssertTrue(r.connection.url.hasSuffix("/mcp/build/bld-mcp1"))
        XCTAssertNotNil(r.connection.ideConfig["mcpServers"])
    }

    func test_buildMcpConnection_decodesStandalone() throws {
        let json = """
        {"url":"https://x/mcp/build/b","key":"k","ideConfig":{}}
        """
        let c = try dec.decode(BuildMcpConnection.self, from: Data(json.utf8))
        XCTAssertEqual(c.key, "k")
        XCTAssertTrue(c.ideConfig.isEmpty)
    }

    // MARK: - env-requests (value-free)

    func test_buildEnvRequests_decode_isValueFree() throws {
        let json = """
        {"requests":[{"name":"STRIPE_SECRET_KEY","why":"payments","secret":true,"requestedAt":1700000000000,"requestedBy":"ide","currentlySet":false}]}
        """
        let r = try dec.decode(BuildEnvRequestsResponse.self, from: Data(json.utf8))
        let q = try XCTUnwrap(r.requests.first)
        XCTAssertEqual(q.name, "STRIPE_SECRET_KEY")
        XCTAssertEqual(q.why, "payments")
        XCTAssertEqual(q.secret, true)
        XCTAssertEqual(q.requestedBy, "ide")
        XCTAssertFalse(q.currentlySet)
        // Hard invariant: there is NO value field on the model at all.
        let encoded = try JSONEncoder().encode(q)
        let obj = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        XCTAssertNil(obj?["value"])
    }

    func test_buildEnvRequest_optionalWhyAndSecret() throws {
        let json = #"{"name":"API_BASE","requestedAt":1,"requestedBy":"ai","currentlySet":true}"#
        let q = try dec.decode(BuildEnvRequest.self, from: Data(json.utf8))
        XCTAssertNil(q.why)
        XCTAssertNil(q.secret)
        XCTAssertTrue(q.currentlySet)
        XCTAssertEqual(q.requestedBy, "ai")
    }

    // MARK: - deploy

    func test_buildDeployResponse_decodes() throws {
        let json = #"{"ok":true,"serviceId":"harry-plants","url":"https://plants.home.harry.flagship.services/"}"#
        let r = try dec.decode(BuildDeployResponse.self, from: Data(json.utf8))
        XCTAssertTrue(r.ok)
        XCTAssertEqual(r.serviceId, "harry-plants")
        XCTAssertEqual(r.url, "https://plants.home.harry.flagship.services/")
    }

    // MARK: - journal

    func test_buildSessionsResponse_decodes() throws {
        let json = """
        {"builds":[{"buildId":"b1","mode":"scratch","serviceId":"harry-plants","startedAt":1,"lastAt":2,"entryCount":9,"lastKind":"deployed"},{"buildId":"b2","mode":"git","startedAt":3,"lastAt":4,"entryCount":3,"lastKind":"fitness-check"}]}
        """
        let r = try dec.decode(BuildSessionsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.builds.count, 2)
        XCTAssertEqual(r.builds[0].mode, "scratch")
        XCTAssertEqual(r.builds[0].serviceId, "harry-plants")
        XCTAssertNil(r.builds[1].serviceId)
        XCTAssertEqual(r.builds[1].lastKind, "fitness-check")
    }

    func test_buildJournalResponse_decodes() throws {
        let json = """
        {"entries":[{"seq":1,"ts":100,"buildId":"b1","mode":"git","kind":"session-started","actor":"owner","summary":"import https://x/y"},{"seq":2,"ts":200,"buildId":"b1","mode":"git","kind":"deployed","actor":"system","summary":"deployed","serviceId":"harry-y"}]}
        """
        let r = try dec.decode(BuildJournalResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.entries.count, 2)
        XCTAssertEqual(r.entries[0].kind, "session-started")
        XCTAssertEqual(r.entries[0].actor, "owner")
        XCTAssertNil(r.entries[0].detail)
        XCTAssertEqual(r.entries[1].serviceId, "harry-y")
    }

    // MARK: - round-trips

    func test_allShapes_roundTripThroughJSON() throws {
        let summary = BuildSummary(buildId: "b", mode: "mcp", serviceId: nil,
                                   startedAt: 1, lastAt: 2, entryCount: 4, lastKind: "mcp-connected")
        let s = try JSONEncoder().encode(summary)
        XCTAssertEqual(try dec.decode(BuildSummary.self, from: s), summary)

        let entry = BuildJournalEntry(seq: 5, ts: 9, buildId: "b", mode: "scratch",
                                      kind: "file-written", actor: "ai", summary: "wrote x", detail: "y")
        let e = try JSONEncoder().encode(entry)
        XCTAssertEqual(try dec.decode(BuildJournalEntry.self, from: e), entry)
    }
}
