import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins the org read token mint request to `packages/protocol/test-vectors/org-read-token/vectors.json`, and
/// checks OrgClient carries the token on org reads (docs/account-read-token.md "Org routes"). CryptoKit's
/// Ed25519 signatures are randomized, so a pinned signature is checked by verifying it, and ours by verifying it too.
final class OrgReadTokenVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/org-read-token/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func bytes(_ s: Any?) throws -> [UInt8] { try XCTUnwrap(OrgAuthority.bytes(hex: try XCTUnwrap(s as? String))) }

    func testReproducesTheSeatRequest() throws {
        let v = try vectors()
        let k = try XCTUnwrap(v["keys"] as? [String: Any])
        let seat = try XCTUnwrap(v["seat"] as? [String: Any])
        let r = try XCTUnwrap(seat["request"] as? [String: Any])
        let orgId = try XCTUnwrap(k["orgId"] as? String), seatId = try XCTUnwrap(k["seatId"] as? String)
        let cred = try OrgReadTokenCredential.member(umk: try bytes(k["umkSeedHex"]), orgId: orgId, seatId: seatId)
        XCTAssertEqual(cred.pubHex, k["memberPubHex"] as? String)
        XCTAssertEqual(OrgReadToken.path(orgId: orgId), seat["path"] as? String)
        XCTAssertEqual(OrgReadToken.seatSubject(seatId), r["subject"] as? String)
        let issuedAt = try XCTUnwrap((r["issuedAt"] as? NSNumber)?.int64Value)
        let nonceHex = try XCTUnwrap(r["nonceHex"] as? String)
        let canonical = OrgReadToken.canonicalRequest(orgId: orgId, subject: OrgReadToken.seatSubject(seatId), pubHex: cred.pubHex, issuedAt: issuedAt, nonceHex: nonceHex)
        XCTAssertEqual(String(decoding: canonical, as: UTF8.self), seat["canonical"] as? String)
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: try bytes(k["memberPubHex"]))
        XCTAssertTrue(pub.isValidSignature(try bytes(seat["signatureHex"]), for: canonical))
        XCTAssertFalse(pub.isValidSignature(try bytes((seat["reject"] as? [String: Any])?["signatureHex"]), for: canonical))
        let body = try OrgReadToken.requestBody(orgId: orgId, credential: cred, issuedAt: issuedAt, nonceHex: nonceHex)
        XCTAssertTrue(pub.isValidSignature(try bytes(body["signature"]), for: canonical))
        let sent = try XCTUnwrap(body["request"] as? [String: Any])
        XCTAssertEqual(sent["pubHex"] as? String, r["pubHex"] as? String)
        XCTAssertEqual(sent["nonceHex"] as? String, nonceHex)
    }

    func testTheGatedPaths() {
        let org = String(repeating: "ab", count: 16)
        XCTAssertNil(OrgReadToken.gatedOrg(path: "/api/orgs/\(org)/plan"))
        XCTAssertNil(OrgReadToken.gatedOrg(path: "/api/orgs/\(org)/invites/\(org)"))
        XCTAssertNil(OrgReadToken.gatedOrg(path: "/api/orgs/\(org)/read-token"))
        XCTAssertEqual(OrgReadToken.gatedOrg(path: "/api/orgs/\(org)/directory/slices"), org)
        XCTAssertEqual(OrgReadToken.gatedOrg(path: "/api/orgs/\(org)/keys"), org)
    }

    /// Org GETs carry the token; the invite offer does not; a 401 mints again once.
    func testOrgClientSendsTheTokenAndMintsAgainAfterA401() async throws {
        let org = String(repeating: "ab", count: 16), seat = String(repeating: "cd", count: 16)
        let cred = try OrgReadTokenCredential.member(umk: [UInt8](repeating: 7, count: 32), orgId: org, seatId: seat)
        let tokens = OrgReadTokens { _ in [cred] }
        final class Log: @unchecked Sendable { var calls: [String] = []; var minted = 0; var refuse: String? }
        let log = Log()
        let client = OrgClient(headerTransport: { method, path, body, headers in
            if path.hasSuffix("/read-token") {
                log.minted += 1
                let r = try XCTUnwrap(body?["request"] as? [String: Any])
                XCTAssertEqual(r["subject"] as? String, "seat:\(seat)")
                return (200, ["token": "ort1.t\(log.minted)", "expiresAt": NSNumber(value: 10_000_000_000_000)])
            }
            let auth = headers["authorization"]
            log.calls.append("\(path.split(separator: "/").last!):\(auth ?? "none")")
            if auth == log.refuse { return (401, ["code": "org-read-token-required"]) }
            return (200, ["connectors": [], "proposals": []])
        }, readTokens: tokens, now: { 1_760_000_000_000 })
        _ = try await client.connectors(orgId: org)
        _ = try await client.proposals(orgId: org)
        XCTAssertEqual(log.calls, ["connectors:Bearer ort1.t1", "proposals:Bearer ort1.t1"])
        XCTAssertEqual(log.minted, 1)
        log.refuse = "Bearer ort1.t1"
        log.calls = []
        _ = try await client.connectors(orgId: org)
        XCTAssertEqual(log.calls, ["connectors:Bearer ort1.t1", "connectors:Bearer ort1.t2"])
        XCTAssertEqual(log.minted, 2)
        log.calls = []
        _ = try? await client.inviteOffer(orgId: org, seatId: seat, inviteSecret: [UInt8](repeating: 1, count: 4032), now: 1_760_000_000_000)
        XCTAssertTrue(log.calls.allSatisfy { $0.hasSuffix(":none") })
    }
}
