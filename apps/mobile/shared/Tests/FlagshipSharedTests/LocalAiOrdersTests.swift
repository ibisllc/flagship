import XCTest
import CryptoKit
@testable import FlagshipCore

/// flagship/local-ai-app-grant/v1 and flagship/local-ai-train/v1 against the shared vectors
/// (packages/protocol/test-vectors/local-ai/vectors.json, seed 0x45 repeated).
final class LocalAiOrdersTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/local-ai/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found")
    }

    private func unhex(_ h: String) -> Data {
        var d = Data(); var i = h.startIndex
        while i < h.endIndex { let n = h.index(i, offsetBy: 2); d.append(UInt8(h[i..<n], radix: 16)!); i = n }
        return d
    }

    /// A whole number from JSON; a fraction is refused like the TS side refuses it.
    private func int(_ v: Any?) throws -> Int64 {
        guard let n = v as? NSNumber else { throw LocalAiOrders.Invalid(reason: "not a number") }
        guard n.doubleValue == n.doubleValue.rounded() else { throw LocalAiOrders.Invalid(reason: "fraction") }
        return n.int64Value
    }

    private func grant(_ o: [String: Any]) throws -> LocalAiAppGrant {
        LocalAiAppGrant(serverDomain: o["serverDomain"] as! String, serviceId: o["serviceId"] as! String,
                        requestsPerDay: try int(o["requestsPerDay"]), tokensPerDay: try int(o["tokensPerDay"]),
                        maxTokensPerRequest: try int(o["maxTokensPerRequest"]), issuedAt: try int(o["issuedAt"]))
    }

    private func train(_ o: [String: Any]) throws -> LocalAiTrainOrder {
        LocalAiTrainOrder(serverDomain: o["serverDomain"] as! String, serviceId: o["serviceId"] as! String,
                          jobId: o["jobId"] as! String, baseModel: o["baseModel"] as! String,
                          epochs: Int(try int(o["epochs"])), issuedAt: try int(o["issuedAt"]))
    }

    func testCanonicalBytesAndSignaturesMatchTheSharedVectors() throws {
        let v = try vectors()
        let seed = unhex(v["seedHex"] as! String)
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(key.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined(), v["pubHex"] as? String)
        let pub = key.publicKey
        for e in v["grants"] as! [[String: Any]] {
            let bytes = try grant(e["grant"] as! [String: Any]).canonicalBytes()
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), e["canonical"] as? String)
            XCTAssertTrue(pub.isValidSignature(unhex(e["signatureHex"] as! String), for: bytes))
        }
        for e in v["trains"] as! [[String: Any]] {
            let bytes = try train(e["order"] as! [String: Any]).canonicalBytes()
            XCTAssertEqual(String(decoding: bytes, as: UTF8.self), e["canonical"] as? String)
            XCTAssertTrue(pub.isValidSignature(unhex(e["signatureHex"] as! String), for: bytes))
        }
    }

    func testMalformedOrdersAreRefused() throws {
        let v = try vectors()
        for e in v["refusedGrants"] as! [[String: Any]] {
            XCTAssertThrowsError(try grant(e["grant"] as! [String: Any]).canonicalBytes(), e["name"] as? String ?? "")
        }
        for e in v["refusedTrains"] as! [[String: Any]] {
            XCTAssertThrowsError(try train(e["order"] as! [String: Any]).canonicalBytes(), e["name"] as? String ?? "")
        }
    }

    func testDefaultsAndBodies() throws {
        let g = LocalAiAppGrant.allow(serverDomain: "Home.Alice.flagship.services", serviceId: "alice--notes", issuedAt: 5)
        XCTAssertEqual(String(decoding: try g.canonicalBytes(), as: UTF8.self),
                       "flagship/local-ai-app-grant/v1|home.alice.flagship.services|alice--notes|500|200000|1024|5")
        let w = LocalAiAppGrant.withdraw(serverDomain: "h", serviceId: "alice--notes", issuedAt: 6)
        XCTAssertTrue(w.isWithdrawal)
        XCTAssertNoThrow(try w.canonicalBytes())
        let order = (g.body(signatureHex: "ab")["order"] as! [String: Any])
        XCTAssertEqual(Set(order.keys), ["serverDomain", "serviceId", "requestsPerDay", "tokensPerDay", "maxTokensPerRequest", "issuedAt"])
        let id = LocalAiOrders.newJobId()
        XCTAssertEqual(id.count, 16)
        XCTAssertNoThrow(try LocalAiTrainOrder(serverDomain: "h", serviceId: "a--b", jobId: id, baseModel: "stories-15m", epochs: 1, issuedAt: 1).canonicalBytes())
    }
}
