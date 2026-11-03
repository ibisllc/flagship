import XCTest
import CryptoKit
@testable import FlagshipCore
import FlagshipAPI

/// Pins the Swift port of the phone route (docs/architecture-v2/phone-route.md) to
/// `packages/protocol/test-vectors/phone-route/vectors.json`: claim and order bytes and signatures, the CSR bytes,
/// certificate reuse and the endpoint policy; plus the endpoint's session flow and sibling-app refusals
/// (Appendix H scenario 11) and certificate reuse in the manager (no order per handover).
final class PhoneRouteVectorTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/phone-route/vectors.json")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("vectors.json not found above \(#filePath)")
    }

    private func i64(_ v: Any?) -> Int64? { (v as? NSNumber)?.int64Value }

    func testBeginCarriesTheOwnAdminGrants() throws {
        let b = try XCTUnwrap(try vectors()["begin"] as? [String: Any])
        let account = b["account"] as! String
        let device = b["devicePub"] as! String
        let now = i64(b["now"])!
        let grants = PhoneRoute.beginGrants(b["deviceGrants"], account: account, devicePub: device, now: now)
        let built = PhoneRoute.beginMessage(account: account, grants: grants)
        XCTAssertTrue(NSDictionary(dictionary: built).isEqual(to: try XCTUnwrap(b["message"] as? [String: Any])), "\(built)")
        // What goes on the wire parses back to the same value.
        let wire = try JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: built)) as! [String: Any]
        XCTAssertTrue(NSDictionary(dictionary: wire).isEqual(to: b["message"] as! [String: Any]))
        XCTAssertTrue(PhoneRoute.beginGrants(b["deviceGrants"], account: account, devicePub: device, now: now + 365 * 86_400_000).isEmpty)
        XCTAssertTrue(PhoneRoute.beginGrants([String: Any](), account: account, devicePub: device, now: now).isEmpty)
    }

    func testBareNames() throws {
        for b in try XCTUnwrap(try vectors()["bare"] as? [[String: Any]]) {
            XCTAssertEqual(PhoneRoute.bareAccount(b["sni"] as! String, apex: b["apex"] as! String), b["account"] as? String, b["sni"] as! String)
        }
    }

    func testClaimReproducesBytesAndSignature() throws {
        let v = try vectors()
        let c = try XCTUnwrap(v["claim"] as? [String: Any])
        let r = try XCTUnwrap(c["record"] as? [String: Any])
        let claim = RouteClaim(account: r["account"] as! String, phoneRoutePub: r["phoneRoutePub"] as! String, hostname: r["hostname"] as! String,
                               generation: i64(r["generation"])!, sessionNonce: r["sessionNonce"] as! String, issuedAt: i64(r["issuedAt"])!)
        let bytes = try claim.canonicalBytes()
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), c["canonical"] as? String)
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: HexUtil.decode(v["signerSeed"] as! String)!)
        XCTAssertEqual(HexUtil.encode(key.publicKey.rawRepresentation), v["signerPub"] as? String)
        XCTAssertTrue(ServingAuthority.verifyEd25519(bytes, signatureHex: c["signature"] as! String, publicKeyHex: v["signerPub"] as! String))
        // CryptoKit's Ed25519 is randomized: the phone's own signature differs but verifies the same.
        XCTAssertTrue(ServingAuthority.verifyEd25519(bytes, signatureHex: try PhoneRoute.signEd25519(bytes, key: key), publicKeyHex: v["signerPub"] as! String))
    }

    func testPhoneOrderReproducesBytesAndSignature() throws {
        let v = try vectors()
        let o = try XCTUnwrap(v["certificateOrder"] as? [String: Any])
        let r = try XCTUnwrap(o["record"] as? [String: Any])
        XCTAssertEqual(r["class"] as? String, "phone")
        let order = PhoneCertificateOrder(device: r["device"] as! String, csrSha256: r["csrSha256"] as! String, requestId: r["requestId"] as! String, issuedAt: i64(r["issuedAt"])!)
        let bytes = try order.canonicalBytes()
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), o["canonical"] as? String)
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: HexUtil.decode(v["signerSeed"] as! String)!)
        XCTAssertTrue(ServingAuthority.verifyEd25519(bytes, signatureHex: o["signature"] as! String, publicKeyHex: v["signerPub"] as! String))
        XCTAssertTrue(ServingAuthority.verifyEd25519(bytes, signatureHex: try PhoneRoute.signEd25519(bytes, key: key), publicKeyHex: v["signerPub"] as! String))
    }

    func testCsrBytesMatchAndCryptoKitSignatureVerifies() throws {
        let c = try XCTUnwrap(try vectors()["csr"] as? [String: Any])
        let pub = HexUtil.decode(c["publicKeyUncompressed"] as! String)!
        let info = try PhoneRoute.csrInfo(publicKey: pub, hostname: c["hostname"] as! String)
        XCTAssertEqual(HexUtil.encode(info), c["infoHex"] as? String)
        let csr = PhoneRoute.csr(info: info, signatureDer: HexUtil.decode(c["signatureDerHex"] as! String)!)
        XCTAssertEqual(HexUtil.encode(csr), c["csrHex"] as? String)
        XCTAssertEqual(PhoneRoute.sha256Hex(csr), c["csrSha256"] as? String)
        let key = try P256.Signing.PublicKey(x963Representation: pub)
        XCTAssertTrue(key.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: HexUtil.decode(c["signatureDerHex"] as! String)!), for: info))
        XCTAssertThrowsError(try PhoneRoute.csrInfo(publicKey: pub, hostname: "*.alice.flagship.services"))
    }

    func testCertificateReuseAndEndpointPolicy() throws {
        let v = try vectors()
        for c in try XCTUnwrap(v["certReuse"] as? [[String: Any]]) {
            XCTAssertEqual(PhoneRoute.needsOrder(notAfter: i64(c["notAfter"]), lastFailureAt: i64(c["lastFailureAt"]), now: i64(c["now"])!), c["order"] as? Bool)
        }
        for c in try XCTUnwrap(v["endpoint"] as? [[String: Any]]) {
            let r = c["request"] as! [String: Any], ctx = c["context"] as! [String: Any]
            let req = PhoneEndpointRequest(method: r["method"] as! String, host: r["host"] as! String, origin: r["origin"] as? String,
                                           sessionCookie: r["sessionCookie"] as? String, csrf: r["csrf"] as? String,
                                           upgrade: r["upgrade"] as? Bool ?? false, establish: r["establish"] as? Bool ?? false)
            XCTAssertEqual(PhoneEndpointPolicy.check(req, hostname: ctx["hostname"] as! String, sessionToken: ctx["sessionToken"] as? String,
                                                     csrfToken: ctx["csrfToken"] as? String), c["verdict"] as? String, c["name"] as! String)
        }
    }

    func testReleaseAndPresence() throws {
        let v = try vectors()
        let r = try XCTUnwrap(v["release"] as? [String: Any]), rec = try XCTUnwrap(r["record"] as? [String: Any])
        let held = RouteClaim(account: rec["account"] as! String, phoneRoutePub: rec["phoneRoutePub"] as! String, hostname: rec["hostname"] as! String,
                              generation: i64(rec["generation"])!, sessionNonce: rec["sessionNonce"] as! String, issuedAt: i64(rec["issuedAt"])!)
        let bytes = try PhoneRoute.canonicalRelease(held)
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), r["canonical"] as? String)
        XCTAssertTrue(ServingAuthority.verifyEd25519(bytes, signatureHex: r["signature"] as! String, publicKeyHex: v["signerPub"] as! String))
        let p = try XCTUnwrap(v["presence"] as? [String: Any]), pr = try XCTUnwrap(p["record"] as? [String: Any])
        let pb = try PhoneRoute.canonicalPresence(account: pr["account"] as! String, devicePub: pr["devicePub"] as! String,
                                                  hostname: pr["hostname"] as! String, issuedAt: i64(pr["issuedAt"])!)
        XCTAssertEqual(String(decoding: pb, as: UTF8.self), p["canonical"] as? String)
        XCTAssertTrue(ServingAuthority.verifyEd25519(pb, signatureHex: p["signature"] as! String, publicKeyHex: pr["devicePub"] as! String))
    }

    func testFrames() {
        let f = TunnelFrames.encode(7, TunnelFrames.data, Data([1, 2, 3]))
        XCTAssertEqual(TunnelFrames.decode(f), TunnelFrames.Frame(streamId: 7, type: TunnelFrames.data, payload: Data([1, 2, 3])))
        XCTAssertNil(TunnelFrames.decode(f + Data([0])))
        XCTAssertEqual(TunnelFrames.phoneTunnelURL("wss://relay.example:8443/tunnel"), "wss://relay.example:8443/phone-tunnel")
    }
}

final class PhoneEndpointResponderTests: XCTestCase {
    let host = "alice.flagship.services"

    private func head(_ method: String, _ path: String, _ headers: [String: String]) -> HttpHead {
        var h = headers
        if h["host"] == nil { h["host"] = host }
        return HttpHead(method: method, path: path, headers: h)
    }
    private func status(_ d: Data) -> Int { Int(String(decoding: d, as: UTF8.self).split(separator: " ")[1])! }
    private func body(_ d: Data) -> String { String(String(decoding: d, as: UTF8.self).components(separatedBy: "\r\n\r\n").last!) }

    final class Inbox: PhoneWebInbox, @unchecked Sendable {
        var pub: String? = String(repeating: "cd", count: 32)
        var got: [Data] = []
        func liveOwnerSignPub() -> String? { pub }
        func deliver(_ body: Data, origin: String?) async -> (status: Int, json: String) {
            got.append(body)
            return (200, #"{"ack":{}}"#)
        }
    }

    private func headers(_ d: Data) -> String { String(String(decoding: d, as: UTF8.self).components(separatedBy: "\r\n\r\n").first!).lowercased() }

    /// docs/voici-and-messages.md §8.2: the one-time-code session is gone; only live and deliver cross origins, only from voi.ci.
    func testRetiredSessionAndTheVoiciOperations() async throws {
        let ep = PhoneEndpointResponder(account: "alice", hostname: host, phoneRoutePub: String(repeating: "ab", count: 32), webOrigins: ["https://voi.ci"])
        let voici = ["origin": "https://voi.ci"]
        XCTAssertEqual(status(ep.respond(head("GET", "/.well-known/flagship-phone", [:]), body: Data())), 200)
        // Retired: no session, no cookie, from any origin.
        XCTAssertEqual(status(ep.respond(head("POST", "/api/phone/session", ["origin": "https://\(host)"]), body: Data(#"{"code":"123456"}"#.utf8))), 403)
        XCTAssertEqual(status(ep.respond(head("POST", "/api/phone/session", [:]), body: Data())), 403)
        XCTAssertEqual(status(ep.respond(head("POST", "/api/phone/ping", voici), body: Data())), 403)
        // No inbox yet: live says not live, deliver is unavailable.
        XCTAssertEqual(status(ep.respond(head("GET", "/api/phone/live", voici), body: Data())), 404)
        let inbox = Inbox()
        ep.setWebInbox(inbox)
        let live = ep.respond(head("GET", "/api/phone/live", voici), body: Data())
        XCTAssertEqual(status(live), 200)
        XCTAssertTrue(headers(live).contains("access-control-allow-origin: https://voi.ci"))
        XCTAssertFalse(headers(live).contains("access-control-allow-credentials"))
        XCTAssertFalse(headers(live).contains("set-cookie"))
        let answer = try XCTUnwrap(JSONValue.parse(body(live)))
        XCTAssertEqual(VoiciPhoneWeb.parsePhoneLiveAnswer(answer)?.ownerSignPub, inbox.pub)
        // Preflight: only POST deliver with exactly content-type.
        let pre = ep.respond(head("OPTIONS", "/api/phone/deliver", voici.merging(["access-control-request-method": "POST", "access-control-request-headers": "content-type"]) { $1 }), body: Data())
        XCTAssertEqual(status(pre), 204)
        XCTAssertTrue(headers(pre).contains("access-control-max-age: 600"))
        XCTAssertEqual(status(ep.respond(head("OPTIONS", "/api/phone/deliver", voici.merging(["access-control-request-method": "POST", "access-control-request-headers": "content-type, x-evil"]) { $1 }), body: Data())), 403)
        // Another origin: 403 with no CORS headers, even for live.
        let evil = ep.respond(head("GET", "/api/phone/live", ["origin": "https://evil.example"]), body: Data())
        XCTAssertEqual(status(evil), 403)
        XCTAssertFalse(headers(evil).contains("access-control-"))
        XCTAssertEqual(status(ep.respond(head("GET", "/", ["origin": "https://voi.ci"]), body: Data())), 403)
        // Deliver: exact content type, through the inbox.
        let env = Data("{}".utf8)
        let wrongType = await ep.handle(head("POST", "/api/phone/deliver", voici.merging(["content-type": "application/json"]) { $1 }), body: env)
        XCTAssertEqual(status(wrongType), 415)
        let ok = await ep.handle(head("POST", "/api/phone/deliver", voici.merging(["content-type": "application/flagship-envelope+json"]) { $1 }), body: env)
        XCTAssertEqual(status(ok), 200)
        XCTAssertEqual(inbox.got, [env])
        let wrongMethod = await ep.handle(head("GET", "/api/phone/deliver", voici), body: Data())
        XCTAssertEqual(status(wrongMethod), 405)
        // Native (no Origin) reaches deliver too; a wrong Host is 421.
        let native = await ep.handle(head("POST", "/api/phone/deliver", ["content-type": "application/flagship-envelope+json"]), body: env)
        XCTAssertEqual(status(native), 200)
        XCTAssertEqual(status(ep.respond(head("GET", "/.well-known/flagship-phone", ["host": "notes.\(host)"]), body: Data())), 421)
    }

    func testASignedHelloIsRecorded() throws {
        var t: Int64 = 1_800_000_000_000
        let ep = PhoneEndpointResponder(account: "alice", hostname: host, phoneRoutePub: String(repeating: "ab", count: 32), now: { t })
        let key = Curve25519.Signing.PrivateKey()
        let device = HexUtil.encode(key.publicKey.rawRepresentation)
        func hello(_ at: Int64, signer: Curve25519.Signing.PrivateKey) throws -> String {
            let sig = try PhoneRoute.signEd25519(try PhoneRoute.canonicalPresence(account: "alice", devicePub: device, hostname: host, issuedAt: at), key: signer)
            return body(ep.respond(head("GET", "/", ["x-flagship-presence-device": device, "x-flagship-presence-at": String(at), "x-flagship-presence-sig": sig]), body: Data()))
        }
        // Before the device book is known nothing is recorded; a key outside it is never recorded.
        XCTAssertTrue(try hello(t, signer: key).contains(#""recorded":false"#))
        ep.setAccountDevices([device])
        XCTAssertTrue(try hello(t, signer: key).contains(#""recorded":true"#))
        XCTAssertEqual(ep.lastSeen(accountDevices: [device])[device], t)
        // A validly signed hello from a key outside the account's device book is never listed.
        XCTAssertTrue(ep.lastSeen(accountDevices: []).isEmpty)
        t += 1_000
        XCTAssertTrue(try hello(t - 61_000, signer: key).contains(#""recorded":false"#))
        XCTAssertTrue(try hello(t, signer: Curve25519.Signing.PrivateKey()).contains(#""recorded":false"#))
        XCTAssertEqual(status(ep.respond(head("GET", "/", [:]), body: Data())), 200)
    }

    func testHellosFromKeysOutsideTheDeviceBookCannotFloodTheList() throws {
        let t: Int64 = 1_800_000_000_000
        let ep = PhoneEndpointResponder(account: "alice", hostname: host, phoneRoutePub: String(repeating: "ab", count: 32), now: { t })
        let mine = Curve25519.Signing.PrivateKey()
        let device = HexUtil.encode(mine.publicKey.rawRepresentation)
        ep.setAccountDevices([device])
        func hello(_ key: Curve25519.Signing.PrivateKey) throws -> String {
            let pub = HexUtil.encode(key.publicKey.rawRepresentation)
            let sig = try PhoneRoute.signEd25519(try PhoneRoute.canonicalPresence(account: "alice", devicePub: pub, hostname: host, issuedAt: t), key: key)
            return body(ep.respond(head("GET", "/", ["x-flagship-presence-device": pub, "x-flagship-presence-at": String(t), "x-flagship-presence-sig": sig]), body: Data()))
        }
        XCTAssertTrue(try hello(mine).contains(#""recorded":true"#))
        for _ in 0..<40 { XCTAssertTrue(try hello(Curve25519.Signing.PrivateKey()).contains(#""recorded":false"#)) }
        XCTAssertEqual(ep.lastSeen(accountDevices: [device])[device], t)
    }

    func testRequestReader() throws {
        var r = HttpRequestReader()
        XCTAssertNil(try r.push(Data("POST /x HTTP/1.1\r\nhost: a\r\ncontent-length: 4\r\n\r\nab".utf8)))
        let (h, b) = try XCTUnwrap(try r.push(Data("cd".utf8)))
        XCTAssertEqual(h.method, "POST")
        XCTAssertEqual(b, Data("abcd".utf8))
    }
}

final class PhoneCertManagerTests: XCTestCase {
    final class MemStore: PhoneCertStoring, @unchecked Sendable {
        var chain: String?, end: Int64?, failed: Int64?, pending: String?
        func chainPem(_ a: String) -> String? { chain }
        func notAfter(_ a: String) -> Int64? { end }
        func lastFailureAt(_ a: String) -> Int64? { failed }
        func pendingOrder(_ a: String) -> String? { pending }
        func saveIssued(_ a: String, chainPem: String, notAfter: Int64) { chain = chainPem; end = notAfter; failed = nil; pending = nil }
        func savePending(_ a: String, orderId: String) { pending = orderId }
        func saveFailure(_ a: String, at: Int64) { failed = at; pending = nil }
    }

    final class FakeIssuer: PhoneCertIssuer, @unchecked Sendable {
        var answer: PhoneCertAnswer
        var orders: [(PhoneCertificateOrder, String, Data)] = []
        init(_ a: PhoneCertAnswer) { answer = a }
        func order(account: String, order: PhoneCertificateOrder, signature: String, csr: Data) async -> PhoneCertAnswer {
            orders.append((order, signature, csr))
            return answer
        }
        func poll(orderId: String) async -> PhoneCertAnswer { answer }
    }

    final class Clock: @unchecked Sendable { var t: Int64 = 1_800_000_000_000 }

    func testOrdersOnceReusesUntilDueAndBacksOff() async throws {
        let clock = Clock()
        let store = MemStore()
        let issuer = FakeIssuer(.issued(chainPem: "PEM", notAfter: clock.t + 90 * 86_400_000))
        let m = PhoneCertManager(store: store, issuer: issuer, now: { clock.t })
        let tls = P256.Signing.PrivateKey()
        let device = Curve25519.Signing.PrivateKey()
        func ensure() async -> Bool {
            await m.ensure(account: "alice", apex: "flagship.services", publicKey: tls.publicKey.x963Representation,
                           signCsr: { try tls.signature(for: $0).derRepresentation }, deviceKey: device, leafKey: { _ in tls.publicKey.x963Representation })
        }
        let ok = await ensure()
        XCTAssertTrue(ok)
        XCTAssertEqual(issuer.orders.count, 1)
        let (order, sig, csr) = issuer.orders[0]
        XCTAssertEqual(order.csrSha256, PhoneRoute.sha256Hex(csr))
        XCTAssertTrue(ServingAuthority.verifyEd25519(try order.canonicalBytes(), signatureHex: sig, publicKeyHex: HexUtil.encode(device.publicKey.rawRepresentation)))
        clock.t += 59 * 86_400_000
        _ = await ensure()
        XCTAssertEqual(issuer.orders.count, 1, "a handover or reconnect never orders")
        clock.t += 2 * 86_400_000
        issuer.answer = .failed(code: "issuance-rate-limited")
        _ = await ensure()
        XCTAssertEqual(issuer.orders.count, 2)
        XCTAssertNotNil(m.current("alice"))
        clock.t += 3_600_000
        _ = await ensure()
        XCTAssertEqual(issuer.orders.count, 2, "six hours between tries")
    }

    func testAChainForAnotherKeyIsNotKept() async {
        let store = MemStore()
        let m = PhoneCertManager(store: store, issuer: FakeIssuer(.issued(chainPem: "PEM", notAfter: 1_900_000_000_000)), now: { 1_800_000_000_000 })
        let tls = P256.Signing.PrivateKey()
        let ok = await m.ensure(account: "alice", apex: "flagship.services", publicKey: tls.publicKey.x963Representation,
                                signCsr: { try tls.signature(for: $0).derRepresentation }, deviceKey: Curve25519.Signing.PrivateKey(),
                                leafKey: { _ in P256.Signing.PrivateKey().publicKey.x963Representation })
        XCTAssertFalse(ok)
        XCTAssertNil(m.current("alice"))
    }
}
