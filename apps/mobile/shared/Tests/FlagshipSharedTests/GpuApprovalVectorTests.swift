import XCTest
import CryptoKit
@testable import FlagshipCore
import FlagshipAPI

/// The Swift half of packages/protocol/test-vectors/gpu-approval/vectors.json: the canonical bytes
/// flagship-gpud verifies, the admin root (0x22…) signing what verifies, and every
/// tampered case failing; plus the withdrawal's bytes and the sets' validation.
final class GpuApprovalVectorTests: XCTestCase {
    private func load() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/gpu-approval/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("gpu-approval vectors not found above \(#filePath)")
    }

    private func request(_ server: String, _ a: [String: Any]) -> GpuApprovalRequest {
        let app = a["app"] as! [String: Any]
        return GpuApprovalRequest(server: server, appId: app["appId"] as! String, installationId: app["installationId"] as! String,
                                  generation: (app["generation"] as! NSNumber).int64Value, backend: a["backend"] as! String,
                                  maxCount: (a["maxCount"] as! NSNumber).intValue, caps: a["capabilities"] as! [String],
                                  policies: a["policies"] as! [String], isolation: a["isolation"] as! String,
                                  secrecy: a["secrecy"] as! Bool, trustDomain: a["trustDomain"] as? String, ownerConsent: a["ownerConsent"] as? String)
    }

    func testEveryCase() throws {
        let v = try load()
        let anchor = v["anchor"] as! [String: Any]
        let server = anchor["server"] as! String
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: HexUtil.decode(anchor["signerHex"] as! String)!)
        let admin = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x22, count: 32))
        XCTAssertEqual(HexUtil.encode(admin.publicKey.rawRepresentation), anchor["signerHex"] as? String)
        let cases = v["cases"] as! [[String: Any]]
        XCTAssertGreaterThan(cases.count, 10)
        for c in cases {
            let name = c["name"] as! String
            let r = request(server, c["approval"] as! [String: Any])
            let proof = c["proof"] as! [String: Any]
            let at = (proof["issuedAt"] as! NSNumber).int64Value
            let bytes = try GpuApprovalOrder.canonical(server: server, r, issuedAt: at)
            if let canon = c["canonical"] as? String { XCTAssertEqual(String(decoding: bytes, as: UTF8.self), canon, name) }
            let sigHex = proof["signature"] as? String ?? ""
            let sig = sigHex.range(of: "^[0-9a-f]{128}$", options: .regularExpression) != nil ? HexUtil.decode(sigHex) ?? Data() : Data(count: 64)
            XCTAssertEqual(pub.isValidSignature(sig, for: bytes), c["expect"] as? Bool, name)
            if c["expect"] as? Bool == true {
                // CryptoKit's Ed25519 signatures are randomized, so the port's own one must verify.
                XCTAssertTrue(pub.isValidSignature(try admin.signature(for: bytes), for: bytes), name)
            }
        }
    }

    func testRefusesWhatGpudCouldNotReadBack() throws {
        let r = GpuApprovalRequest(server: "home.alice.flagship.services", appId: "alice--render", installationId: "inst-7f3a", generation: 3,
                                   backend: "nvidia-cuda", maxCount: 1, caps: ["compute"], policies: ["exclusive"],
                                   isolation: "gvisor-nvproxy", secrecy: true)
        let s = "home.alice.flagship.services"
        XCTAssertNoThrow(try GpuApprovalOrder.canonical(server: s, r, issuedAt: 1))
        func bad(_ x: GpuApprovalRequest, server: String = s) {
            XCTAssertThrowsError(try GpuApprovalOrder.canonical(server: server, x, issuedAt: 1))
        }
        bad(r, server: "Home.alice")
        bad(r, server: "a|b")
        bad(GpuApprovalRequest(server: s, appId: "alice|render", installationId: "i", generation: 1, backend: "nvidia-cuda", maxCount: 1,
                               caps: ["compute"], policies: ["exclusive"], isolation: "gvisor-nvproxy", secrecy: true))
        bad(GpuApprovalRequest(server: s, appId: "a", installationId: "i", generation: 1, backend: "nvidia-cuda", maxCount: 17,
                               caps: ["compute"], policies: ["exclusive"], isolation: "gvisor-nvproxy", secrecy: true))
        bad(GpuApprovalRequest(server: s, appId: "a", installationId: "i", generation: 1, backend: "nvidia-cuda", maxCount: 1,
                               caps: [], policies: ["exclusive"], isolation: "gvisor-nvproxy", secrecy: true))
        bad(GpuApprovalRequest(server: s, appId: "a", installationId: "i", generation: 1, backend: "cuda", maxCount: 1,
                               caps: ["compute"], policies: ["exclusive"], isolation: "gvisor-nvproxy", secrecy: true))
        bad(GpuApprovalRequest(server: s, appId: "a", installationId: "i", generation: 1, backend: "nvidia-cuda", maxCount: 1,
                               caps: ["compute"], policies: ["exclusive"], isolation: "gvisor-nvproxy", secrecy: true, trustDomain: "a b"))
    }

    func testWithdrawVectors() throws {
        let v = try load()
        let anchor = v["anchor"] as! [String: Any]
        let server = anchor["server"] as! String
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: HexUtil.decode(anchor["signerHex"] as! String)!)
        let cases = try XCTUnwrap(v["withdraw"] as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 3)
        for c in cases {
            let name = c["name"] as! String
            let w = c["withdraw"] as! [String: Any]
            let bytes = try GpuApprovalOrder.withdrawCanonical(server: server, appId: w["appId"] as! String, installationId: w["installationId"] as! String,
                                                               generation: (w["generation"] as! NSNumber).int64Value,
                                                               issuedAt: (w["issuedAt"] as! NSNumber).int64Value)
            if let canon = c["canonical"] as? String { XCTAssertEqual(String(decoding: bytes, as: UTF8.self), canon, name) }
            let sigHex = c["signature"] as? String ?? ""
            let sig = sigHex.range(of: "^[0-9a-f]{128}$", options: .regularExpression) != nil ? HexUtil.decode(sigHex) ?? Data() : Data(count: 64)
            XCTAssertEqual(pub.isValidSignature(sig, for: bytes), c["expect"] as? Bool, name)
        }
    }

    func testOwnerTermsForSharing() throws {
        let r = GpuApprovalRequest(server: "s", appId: "a", installationId: "i", generation: 1, backend: "nvidia-cuda", maxCount: 1,
                                   caps: ["video-encode"], policies: ["cooperative"], isolation: "gvisor-nvproxy", secrecy: false)
        let t = GpuApprovalOrder.ownerTerms(r, issuedAt: 42)
        XCTAssertEqual(t.trustDomain, "owner-apps")
        XCTAssertEqual(t.ownerConsent, "owner-consent-42")
        XCTAssertNoThrow(try GpuApprovalOrder.canonical(server: "home.alice.flagship.services", t, issuedAt: 42))
        let ex = GpuApprovalRequest(server: "s", appId: "a", installationId: "i", generation: 1, backend: "nvidia-cuda", maxCount: 1,
                                    caps: ["compute"], policies: ["exclusive"], isolation: "gvisor-nvproxy", secrecy: true)
        XCTAssertEqual(GpuApprovalOrder.ownerTerms(ex, issuedAt: 42), ex)
    }

    func testWithdrawalBytes() throws {
        let b = try GpuApprovalOrder.withdrawCanonical(server: "home.alice.flagship.services", appId: "alice--render",
                                                       installationId: "inst-7f3a", generation: 3, issuedAt: 1_800_000_000_000)
        XCTAssertEqual(String(decoding: b, as: UTF8.self),
                       "flagship/gpu-approval-withdraw/v1|home.alice.flagship.services|alice--render|inst-7f3a|3|1800000000000")
        XCTAssertThrowsError(try GpuApprovalOrder.withdrawCanonical(server: "home", appId: "a|b", installationId: "i", generation: 1, issuedAt: 1))
    }
}
