import XCTest
@testable import FlagshipBurnerCore

final class VerifyResultTests: XCTestCase {

    func testParseCleanCLIOutput() {
        let raw = """
        {
          "ok": true,
          "source": { "kind": "file", "path": "/tmp/recipe.json" },
          "serverDomain": "demo-alice.flagship.services",
          "username": "demo-alice",
          "serverName": "studio",
          "expiresAt": "2026-06-21T12:00:00.000Z",
          "installerGitRef": "v1.0.0",
          "signatureValid": true
        }
        """
        let r = VerifyResult.parse(jsonText: raw)
        XCTAssertNotNil(r)
        XCTAssertEqual(r?.serverDomain, "demo-alice.flagship.services")
        XCTAssertEqual(r?.username, "demo-alice")
        XCTAssertEqual(r?.expiresAt, "2026-06-21T12:00:00.000Z")
        XCTAssertEqual(r?.signatureValid, true)
    }

    func testParseSkipsLeadingNoiseLines() {
        let raw = """
        loaded recipe from /tmp/foo
        {"ok":true,"serverDomain":"abc.flagship.services"}
        """
        let r = VerifyResult.parse(jsonText: raw)
        XCTAssertNotNil(r)
        XCTAssertEqual(r?.serverDomain, "abc.flagship.services")
    }

    func testParseFailsGracefullyOnGarbage() {
        XCTAssertNil(VerifyResult.parse(jsonText: "not json at all"))
        XCTAssertNil(VerifyResult.parse(jsonText: ""))
    }

    func testCodableRoundtrip() throws {
        let v = VerifyResult(
            ok: true,
            serverDomain: "x.y.flagship.services",
            username: "x",
            serverName: "y",
            expiresAt: "2026-12-31T00:00:00.000Z",
            installerGitRef: "abcdef",
            signatureValid: true
        )
        let data = try JSONEncoder().encode(v)
        let back = try JSONDecoder().decode(VerifyResult.self, from: data)
        XCTAssertEqual(v, back)
    }
}
