import XCTest
import CryptoKit
@testable import FlagshipCore

/// Pins `Ohttp`, `Bhttp`, `OhttpPrivacy` and `OhttpClient` to packages/protocol/test-vectors/ohttp/{vectors,spend-route}.json.
final class OhttpVectorTests: XCTestCase {
    private func load(_ name: String) throws -> JSONValue {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<14 {
            let url = dir.appendingPathComponent("packages/protocol/test-vectors/ohttp/\(name)")
            if FileManager.default.fileExists(atPath: url.path) {
                return try XCTUnwrap(JSONValue.parse(utf8: Array(try Data(contentsOf: url))))
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("\(name) not found above \(#filePath)")
    }

    private func hex(_ v: JSONValue?) throws -> [UInt8] { Array(try XCTUnwrap(HexUtil.decode(try XCTUnwrap(v?.string)))) }
    private func hx(_ b: [UInt8]) -> String { HexUtil.encode(Data(b)) }
    private func headers(_ v: JSONValue?) -> [(String, String)] {
        (v?.array ?? []).compactMap { p in p.array.flatMap { a in a.count == 2 ? (a[0].string ?? "", a[1].string ?? "") : nil } }
    }

    func testRfc9458AppendixA() throws {
        let r = try XCTUnwrap(try load("vectors.json")["rfc9458"])
        let config = try XCTUnwrap(Ohttp.parseKeyConfig(try hex(r["keyConfigHex"])))
        let gw = try Ohttp.GatewayKey(keyId: config.keyId, privateKey: try hex(r["gatewaySecretHex"]))
        XCTAssertEqual(gw.config, config)
        let (enc, ctx) = try Ohttp.encapsulateRequest(config, try hex(r["bhttpRequestHex"]), ephemeralPrivateKey: try hex(r["ephemeralSecretHex"]))
        XCTAssertEqual(hx(enc), r["encapsulatedRequestHex"]?.string)
        let opened = try Ohttp.decapsulateRequest([gw], enc)
        XCTAssertEqual(hx(opened.request), r["bhttpRequestHex"]?.string)
        let res = try Ohttp.encapsulateResponse(opened.context, try hex(r["bhttpResponseHex"]), responseNonce: try hex(r["responseNonceHex"]))
        XCTAssertEqual(hx(res), r["encapsulatedResponseHex"]?.string)
        XCTAssertEqual(hx(try Ohttp.decapsulateResponse(ctx, res)), r["bhttpResponseHex"]?.string)
        let decoded = try Bhttp.decodeRequest(try hex(r["bhttpRequestHex"]))
        XCTAssertEqual(decoded.method, "GET")
        XCTAssertEqual(decoded.authority, "example.com")
        XCTAssertEqual(try Bhttp.decodeResponse(try hex(r["bhttpResponseHex"])).status, 200)
    }

    func testEveryFlagshipCase() throws {
        let v = try load("vectors.json")
        let g = try XCTUnwrap(v["gateway"])
        let gw = try Ohttp.GatewayKey(keyId: UInt8(try XCTUnwrap(g["keyId"]?.safeInt)), privateKey: try hex(g["secretHex"]))
        XCTAssertEqual(hx(gw.config.publicKey), g["publicKeyHex"]?.string)
        XCTAssertEqual(hx(Ohttp.encodeKeyConfig(gw.config)), g["keyConfigHex"]?.string)
        XCTAssertEqual(Ohttp.keyConfig(hex: try XCTUnwrap(g["keyConfigHex"]?.string)), gw.config)
        let cases = try XCTUnwrap(v["cases"]?.array)
        XCTAssertEqual(cases.count, 4)
        for c in cases {
            let name = c["name"]?.string ?? ""
            let q = try XCTUnwrap(c["request"])
            let req = BhttpRequest(method: q["method"]?.string ?? "", scheme: q["scheme"]?.string ?? "", authority: q["authority"]?.string ?? "",
                                   path: q["path"]?.string ?? "", headers: headers(q["headers"]), body: Array((q["bodyText"]?.string ?? "").utf8))
            let bReq = try Bhttp.encode(req)
            XCTAssertEqual(hx(bReq), c["bhttpRequestHex"]?.string, name)
            XCTAssertEqual(try Bhttp.decodeRequest(bReq), req, name)
            let (enc, ctx) = try Ohttp.encapsulateRequest(gw.config, bReq, ephemeralPrivateKey: try hex(c["ephemeralSecretHex"]))
            XCTAssertEqual(hx(enc), c["encapsulatedRequestHex"]?.string, name)
            let opened = try Ohttp.decapsulateRequest([gw], enc)
            XCTAssertEqual(opened.request, bReq, name)
            let p = try XCTUnwrap(c["response"])
            let res = BhttpResponse(status: Int(p["status"]?.safeInt ?? 0), headers: headers(p["headers"]), body: Array((p["bodyText"]?.string ?? "").utf8))
            let bRes = try Bhttp.encode(res)
            XCTAssertEqual(hx(bRes), c["bhttpResponseHex"]?.string, name)
            XCTAssertEqual(try Bhttp.decodeResponse(bRes), res, name)
            let eRes = try Ohttp.encapsulateResponse(opened.context, bRes, responseNonce: try hex(c["responseNonceHex"]))
            XCTAssertEqual(hx(eRes), c["encapsulatedResponseHex"]?.string, name)
            XCTAssertEqual(try Bhttp.decodeResponse(try Ohttp.decapsulateResponse(ctx, eRes)), res, name)
        }
    }

    func testNegatives() throws {
        let v = try load("vectors.json")
        let g = try XCTUnwrap(v["gateway"])
        let gw = try Ohttp.GatewayKey(keyId: UInt8(try XCTUnwrap(g["keyId"]?.safeInt)), privateKey: try hex(g["secretHex"]))
        let first = try XCTUnwrap(v["cases"]?.array?.first)
        let (_, ctx) = try Ohttp.encapsulateRequest(gw.config, try hex(first["bhttpRequestHex"]), ephemeralPrivateKey: try hex(first["ephemeralSecretHex"]))
        XCTAssertNoThrow(try Ohttp.decapsulateResponse(ctx, try hex(first["encapsulatedResponseHex"])))
        let responses = try XCTUnwrap(v["negatives"]?["responses"]?.array)
        XCTAssertEqual(responses.count, 3)
        for n in responses {
            XCTAssertThrowsError(try Ohttp.decapsulateResponse(ctx, try hex(n["encapsulatedResponseHex"])), n["name"]?.string ?? "")
        }
        let configs = try XCTUnwrap(v["negatives"]?["keyConfigs"]?.array)
        XCTAssertEqual(configs.count, 3)
        for n in configs {
            XCTAssertNil(Ohttp.keyConfig(hex: try XCTUnwrap(n["hex"]?.string)), n["name"]?.string ?? "")
        }
        // A request under an unknown key id or tampered ciphertext is refused at the gateway.
        let (enc, _) = try Ohttp.encapsulateRequest(gw.config, [1, 2, 3])
        var wrongKey = enc; wrongKey[0] = 9
        XCTAssertThrowsError(try Ohttp.decapsulateRequest([gw], wrongKey)) { XCTAssertEqual($0 as? Ohttp.Failure, .key) }
        var tampered = enc; tampered[tampered.count - 1] ^= 1
        XCTAssertThrowsError(try Ohttp.decapsulateRequest([gw], tampered)) { XCTAssertEqual($0 as? Ohttp.Failure, .decrypt) }
        XCTAssertThrowsError(try Bhttp.decodeResponse([0]))
        XCTAssertThrowsError(try Bhttp.decodeRequest([0, 0x44]))
    }

    /// CryptoKit's own HPKE opens what we seal, and exports the same response secret.
    func testCryptoKitHpkeOpensOurRequest() throws {
        let sk = Curve25519.KeyAgreement.PrivateKey()
        let config = Ohttp.KeyConfig(keyId: 3, publicKey: Array(sk.publicKey.rawRepresentation))
        let message = Array("POST /api/vouchers/redeem".utf8)
        let (enc, ctx) = try Ohttp.encapsulateRequest(config, message)
        let suite = HPKE.Ciphersuite(kem: .Curve25519_HKDF_SHA256, kdf: .HKDF_SHA256, aead: .AES_GCM_128)
        let hdr = Array(enc[0..<7])
        var recipient = try HPKE.Recipient(privateKey: sk, ciphersuite: suite, info: Data(Ohttp.requestLabel + [0] + hdr),
                                           encapsulatedKey: Data(enc[7..<39]))
        XCTAssertEqual(Array(try recipient.open(Data(enc[39...]))), message)
        let secret = try recipient.exportSecret(context: Data(Ohttp.responseLabel), outputByteCount: Ohttp.secretLen)
        XCTAssertEqual(secret.withUnsafeBytes { Array($0) }, ctx.secret)
    }

    // MARK: spend-route.json

    func testSpendRoute() throws {
        let v = try load("spend-route.json")
        XCTAssertEqual(v["directBeforeLapseMs"]?.safeInt, OhttpPrivacy.directBeforeLapseMs)
        let route = try XCTUnwrap(v["route"]?.array)
        XCTAssertFalse(route.isEmpty)
        for r in route {
            let kind = try XCTUnwrap(PrivateSpendKind(rawValue: r["kind"]?.string ?? ""))
            let lapse = r["lapseInMs"]?.safeInt
            XCTAssertEqual(OhttpPrivacy.spendMayGoDirect(kind, lapseInMs: lapse), r["mayGoDirect"] == .bool(true), "\(kind) \(String(describing: lapse))")
        }
        for l in try XCTUnwrap(v["lapse"]?.array) {
            XCTAssertEqual(OhttpPrivacy.planLapseInMs(paidUntil: l["paidUntil"]?.safeInt ?? -1, graceMs: l["graceMs"]?.safeInt ?? -1,
                                                      now: l["now"]?.safeInt ?? -1), l["lapseInMs"]?.safeInt)
        }
        for b in try XCTUnwrap(v["backoff"]?.array) {
            XCTAssertEqual(OhttpPrivacy.relayRetryAfterMs(Int(b["failures"]?.safeInt ?? -1)), b["retryAfterMs"]?.safeInt)
        }
        for h in try XCTUnwrap(v["relayHosts"]?.array) {
            let host = try XCTUnwrap(h["host"]?.string)
            XCTAssertEqual(OhttpPrivacy.isForbiddenRelayHost(host, controlApex: "flagshipserver.com"), h["forbidden"] == .bool(true), host)
        }
        for c in try XCTUnwrap(v["config"]?.array) {
            let got = OhttpPrivacy.parseConfig(c["input"], controlApex: c["controlApex"]?.string)
            let e = try XCTUnwrap(c["expected"])
            XCTAssertEqual(got.keyConfigHex, e["keyConfigHex"]?.string, c["name"]?.string ?? "")
            let want = (e["relays"]?.array ?? []).map { OhttpRelayEntry(url: $0["url"]?.string ?? "", operator: $0["operator"]?.string ?? "", interim: $0["interim"] == .bool(true)) }
            XCTAssertEqual(got.relays, want, c["name"]?.string ?? "")
        }
    }

    // MARK: OhttpClient against a fake relay that is the vectors' gateway

    private final class Seen: @unchecked Sendable {
        let lock = NSLock()
        var requests: [URLRequest] = []
        func add(_ r: URLRequest) { lock.lock(); requests.append(r); lock.unlock() }
    }

    private func gateway() throws -> Ohttp.GatewayKey {
        let g = try XCTUnwrap(try load("vectors.json")["gateway"])
        return try Ohttp.GatewayKey(keyId: 7, privateKey: try hex(g["secretHex"]))
    }

    private func config(_ gw: Ohttp.GatewayKey, relays: [String]) -> OhttpPublicConfig {
        OhttpPublicConfig(keyConfigHex: hx(Ohttp.encodeKeyConfig(gw.config)), relays: relays.map { OhttpRelayEntry(url: $0, operator: "R", interim: false) })
    }

    func testClientUsesTheFirstRelayThatAnswers() async throws {
        let gw = try gateway()
        let seen = Seen()
        let url = URL(string: "https://flagshipserver.com/api/vouchers/redeem")!
        let r = try await OhttpClient.send(url: url, headers: [("content-type", "application/json")], body: Array("{}".utf8),
                                           config: config(gw, relays: ["https://a.example/r", "https://b.example/r"]),
                                           mayGoDirect: { _ in XCTFail("no direct"); return false }) { req in
            seen.add(req)
            if req.url?.host == "a.example" { throw URLError(.cannotConnectToHost) }
            XCTAssertEqual(req.value(forHTTPHeaderField: "content-type"), "message/ohttp-req")
            let opened = try Ohttp.decapsulateRequest([gw], Array(req.httpBody ?? Data()))
            let inner = try Bhttp.decodeRequest(opened.request)
            XCTAssertEqual(inner.path, "/api/vouchers/redeem")
            XCTAssertEqual(inner.authority, "flagshipserver.com")
            XCTAssertEqual(inner.headers.first?.1, "application/json")
            let out = try Ohttp.encapsulateResponse(opened.context, try Bhttp.encode(BhttpResponse(status: 409, headers: [("content-type", "application/json")],
                                                                                                    body: Array("{\"code\":\"voucher-spent\"}".utf8))))
            return (200, "message/ohttp-res", out)
        }
        XCTAssertEqual(r.status, 409)
        XCTAssertEqual(r.path, .relay(url: "https://b.example/r"))
        XCTAssertEqual(seen.requests.count, 2)
    }

    func testClientFallsBackOnlyWhenAllowedAndMarksTheReason() async throws {
        let gw = try gateway()
        let url = URL(string: "https://flagshipserver.com/api/vouchers/redeem")!
        let cases: [(String, PrivateTransport)] = [
            ("relay-timeout", { req in if req.url?.host == "flagshipserver.com" { return (200, "application/json", []) }; throw URLError(.timedOut) }),
            ("relay-unreachable", { req in if req.url?.host == "flagshipserver.com" { return (200, "application/json", []) }; throw URLError(.notConnectedToInternet) }),
            ("relay-502", { _ in (502, "text/plain", []) }),
            ("relay-bad-response", { req in req.url?.host == "flagshipserver.com" ? (200, nil, []) : (200, "application/json", [1, 2]) }),
            ("relay-bad-response", { req in req.url?.host == "flagshipserver.com" ? (200, nil, []) : (200, "message/ohttp-res", [UInt8](repeating: 7, count: 40)) }),
        ]
        for (want, transport) in cases {
            var asked: String?
            do {
                _ = try await OhttpClient.send(url: url, config: config(gw, relays: ["https://a.example/r"]), mayGoDirect: { asked = $0; return false }, transport: transport)
                XCTFail("expected refusal")
            } catch let e as RelayUnavailableError {
                XCTAssertEqual(e.reason, want)
            }
            XCTAssertEqual(asked, want)
            let seen = Seen()
            let r = try await OhttpClient.send(url: url, config: config(gw, relays: ["https://a.example/r"]), mayGoDirect: { _ in true }) { req in
                seen.add(req)
                if req.url?.host == "flagshipserver.com" { return (200, "application/json", Array("{}".utf8)) }
                return try await transport(req)
            }
            XCTAssertEqual(r.path, .direct(reason: want))
            XCTAssertEqual(seen.requests.last?.value(forHTTPHeaderField: "x-flagship-relay-fallback"), want)
        }
        // No relay configured: always direct, never asks, never marked.
        let seen = Seen()
        let r = try await OhttpClient.send(url: url, config: .empty, mayGoDirect: { _ in XCTFail("not asked"); return false }) { req in
            seen.add(req); return (200, nil, [])
        }
        XCTAssertEqual(r.path, .direct(reason: "unconfigured"))
        XCTAssertNil(seen.requests.first?.value(forHTTPHeaderField: "x-flagship-relay-fallback"))
    }
}
