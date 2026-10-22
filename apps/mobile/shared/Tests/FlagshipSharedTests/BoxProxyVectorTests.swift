import XCTest
import CryptoKit
@testable import FlagshipCore
import FlagshipAPI

/// Pins `BoxProxy` to `packages/protocol/test-vectors/box-proxy/vectors.json`.
/// CryptoKit's Ed25519 signatures are randomized, so the pinned signature is
/// checked by verifying it, and our own by verifying it too.
final class BoxProxyVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/box-proxy/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func hex(_ s: Any?) throws -> Data { try XCTUnwrap(HexUtil.decode(try XCTUnwrap(s as? String))) }

    private func proxy(_ f: [String: Any]) -> BoxProxy {
        BoxProxy(
            serverDomain: f["serverDomain"] as! String,
            kind: f["kind"] as! String,
            host: f["host"] as! String,
            port: (f["port"] as! NSNumber).intValue,
            auth: (f["auth"] as! NSNumber).boolValue,
            fallbackDirect: (f["fallbackDirect"] as! NSNumber).boolValue,
            issuedAt: (f["issuedAt"] as! NSNumber).int64Value,
            nonce: f["nonce"] as! String
        )
    }

    private func irk(_ v: [String: Any]) throws -> Curve25519.Signing.PrivateKey {
        let keys = try XCTUnwrap(v["keys"] as? [String: Any])
        let seed = try XCTUnwrap(ServiceInvite.deriveProtocolIrkSeed(umkSeed: try hex(keys["umkSeedHex"])))
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(HexUtil.encode(key.publicKey.rawRepresentation), keys["irkPubHex"] as? String)
        return key
    }

    func testReproducesEveryCaseAndVerifiesThePinnedSignatures() throws {
        let v = try vectors()
        let key = try irk(v)
        let cases = try XCTUnwrap(v["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let name = c["name"] as? String ?? ""
            let p = proxy(try XCTUnwrap(c["fields"] as? [String: Any]))
            XCTAssertEqual(String(decoding: try p.canonicalBytes(), as: UTF8.self), c["canonical"] as? String, name)
            XCTAssertTrue(p.verify(signatureHex: c["signatureHex"] as! String, publicKey: key.publicKey), name)
            XCTAssertFalse(p.verify(signatureHex: c["rejectSignatureHex"] as! String, publicKey: key.publicKey), name)
            XCTAssertTrue(p.verify(signatureHex: try p.sign(with: key), publicKey: key.publicKey), name)
        }
    }

    func testRefusesEveryRefuseCase() throws {
        for r in try XCTUnwrap(try vectors()["refuse"] as? [[String: Any]]) {
            XCTAssertThrowsError(try proxy(r["fields"] as! [String: Any]).canonicalBytes(), r["why"] as? String ?? "")
        }
    }

    func testNormalizesTypedHosts() throws {
        for n in try XCTUnwrap(try vectors()["normalize"] as? [[String: Any]]) {
            XCTAssertEqual(BoxProxy.normalizeHost(n["input"] as! String), n["host"] as? String)
        }
    }

    func testHostErrorsMatchTheReference() throws {
        let entries = try XCTUnwrap(try vectors()["hostErrors"] as? [[String: Any]])
        XCTAssertFalse(entries.isEmpty)
        for e in entries {
            let host = e["host"] as! String
            XCTAssertEqual(BoxProxy.hostError(host), e["error"] as? String, host)
        }
    }

    func testChecksCredentialsTheSameWay() throws {
        let creds = try XCTUnwrap(try vectors()["credentials"] as? [String: Any])
        for c in try XCTUnwrap(creds["accept"] as? [[String: Any]]) {
            XCTAssertNil(BoxProxy.credentialsError(username: c["username"] as! String, password: c["password"] as! String))
        }
        for c in try XCTUnwrap(creds["refuse"] as? [[String: Any]]) {
            XCTAssertNotNil(BoxProxy.credentialsError(username: c["username"] as! String, password: c["password"] as! String),
                            c["why"] as? String ?? "")
        }
    }

    func testDecodesTheWireForm() throws {
        let c = try XCTUnwrap((try vectors()["cases"] as? [[String: Any]])?.first)
        let data = try JSONSerialization.data(withJSONObject: try XCTUnwrap(c["wire"]))
        let wire = try JSONDecoder().decode(SignedBoxProxyWire.self, from: data)
        XCTAssertEqual(BoxProxy(wire.proxy), proxy(c["fields"] as! [String: Any]))
        XCTAssertEqual(wire.signature, c["signatureHex"] as? String)
    }

    func testMakeTurnsOffCleanlyAndNormalizes() throws {
        let off = BoxProxy.make(serverDomain: "Home.X.flagship.services", kind: .none, host: "junk", port: 9,
                                auth: true, fallbackDirect: true, now: 5, nonce: Data(repeating: 1, count: 32))
        XCTAssertEqual(off.host, "")
        XCTAssertEqual(off.port, 0)
        XCTAssertFalse(off.auth)
        XCTAssertEqual(off.serverDomain, "home.x.flagship.services")
        XCTAssertNoThrow(try off.canonicalBytes())
        let on = BoxProxy.make(serverDomain: "home.x.flagship.services", kind: .socks5, host: " [2001:DB8::7] ", port: 9050,
                               auth: false, fallbackDirect: false, now: 5, nonce: Data(repeating: 1, count: 32))
        XCTAssertEqual(on.host, "2001:db8::7")
        XCTAssertNoThrow(try on.canonicalBytes())
    }
}
