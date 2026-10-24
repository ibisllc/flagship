import XCTest
import FlagshipAPI
@testable import FlagshipCore

/// The phone's PQ tunnel against a box played by the Swift responder half.
final class PqBoxChannelTests: XCTestCase {
    private let server = "home.alice.flagship.services"

    private func party(_ role: String, _ subject: String, _ a: UInt8) throws -> (binding: VerifiedPqKeyBinding, sign: @Sendable (String, [UInt8]) throws -> [UInt8]) {
        let sk = [UInt8](repeating: a, count: 32) + [UInt8](repeating: a &+ 1, count: 32)
        let (pk, _) = try PqHybrid.hybridSigKeygen(edSeed: Array(sk[0..<32]), mldsaSeed: Array(sk[32...]))
        let st = PqKeyBindingStatement(role: role, subjectId: subject, ed25519PubHex: PqBin.hex(Array(pk[0..<32])), mldsaPubHex: PqBin.hex(Array(pk[32...])), issuedAt: 1)
        let sign: @Sendable (String, [UInt8]) throws -> [UInt8] = { p, m in try PqHybrid.hybridSign(secretKey: sk, purpose: p, payload: m) }
        let wire = try PqTrust.signPqKeyBinding(st, signer: sign)
        return (try PqTrust.verifyPqKeyBinding(wire, PqBindingExpectation(role: role, subjectId: subject, ed25519PubHex: st.ed25519PubHex, now: 10)), sign)
    }

    final class FakeBox: @unchecked Sendable {
        var pending: [String: PqSession.Pending] = [:]
        var sessions: [String: PqSession.Channel] = [:]
        var seen: [(String, String, String?)] = []
        var plainCalls = 0
    }

    func testRequestsGoInsideTheSessionAndTheAnswerComesBack() async throws {
        let box = try party("box-stk", server, 0x10)
        let phone = try party("device", "7f3a9c0b1d2e4f5a6b7c8d9e0f1a2b3c", 0x20)
        let fake = FakeBox()
        let now: @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
        let transport: @Sendable (URLRequest) async throws -> (Data, URLResponse) = { req in
            let o = try JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as! [String: Any]
            let url = req.url!
            func ok(_ b: [String: Any]) throws -> (Data, URLResponse) {
                (try JSONSerialization.data(withJSONObject: b), HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }
            switch url.path {
            case "/api/pq-session/hello":
                let (a, p) = try PqSession.accept(hello: o["hello"], identity: box.binding, lookup: { r, s, k in r == "device" && k == phone.binding.keyIdHex ? phone.binding : nil },
                                                  now: now(), sign: box.sign)
                fake.pending["h1"] = p
                return try ok(["handshake": "h1", "accept": a])
            case "/api/pq-session/finish":
                let ch = try fake.pending["h1"]!.complete(finish: o["finish"], now: now())
                fake.sessions[ch.sessionIdHex] = ch
                return try ok(["session": ch.sessionIdHex])
            case "/api/pq-session/call":
                let ch = fake.sessions[o["session"] as! String]!
                let (seq, plain) = try ch.openRequest([UInt8](Data(base64Encoded: o["record"] as! String)!), now: now())
                let inner = try JSONSerialization.jsonObject(with: Data(plain)) as! [String: Any]
                fake.seen.append((inner["method"] as! String, inner["path"] as! String, (inner["headers"] as? [String: String])?["x-flagship-session"]))
                let answer: [String: Any] = ["status": 200, "headers": ["content-type": "application/json"], "body": Data(#"{"ok":true}"#.utf8).base64EncodedString()]
                let rec = try ch.sealResponse(seq: seq, [UInt8](try JSONSerialization.data(withJSONObject: answer)))
                return try ok(["record": Data(rec).base64EncodedString()])
            default:
                fake.plainCalls += 1
                return (Data(), HTTPURLResponse(url: url, statusCode: 403, httpVersion: nil, headerFields: nil)!)
            }
        }
        let tunnel = PqBoxChannelTunnel(isStrict: { $0 == self.server }, responder: { $0 == self.server ? box.binding : nil },
                                        identity: { PqBoxChannelTunnel.Identity(binding: phone.binding, sign: phone.sign) })
        XCTAssertTrue(tunnel.carries(host: server))
        XCTAssertFalse(tunnel.carries(host: "other.alice.flagship.services"))
        var req = URLRequest(url: URL(string: "https://\(server)/api/screens/home?x=1")!)
        req.setValue("tok", forHTTPHeaderField: "x-flagship-session")
        for _ in 0..<2 {
            let (data, resp) = try await tunnel.send(req, host: server, transport: transport)
            XCTAssertEqual((resp as? HTTPURLResponse)?.statusCode, 200)
            XCTAssertEqual(String(data: data, encoding: .utf8), #"{"ok":true}"#)
        }
        XCTAssertEqual(fake.seen.count, 2)
        XCTAssertEqual(fake.seen.first?.1, "/api/screens/home?x=1")
        XCTAssertEqual(fake.seen.first?.2, "tok")
        XCTAssertEqual(fake.sessions.count, 1)
        XCTAssertEqual(fake.plainCalls, 0)
    }

    func testAStrictServerIsNeverReachedWithoutItsPinnedKey() async throws {
        let phone = try party("device", "7f3a9c0b1d2e4f5a6b7c8d9e0f1a2b3c", 0x20)
        let tunnel = PqBoxChannelTunnel(isStrict: { _ in true }, responder: { _ in nil },
                                        identity: { PqBoxChannelTunnel.Identity(binding: phone.binding, sign: phone.sign) })
        let req = URLRequest(url: URL(string: "https://\(server)/api/screens/home")!)
        do {
            _ = try await tunnel.send(req, host: server) { _ in XCTFail("nothing may be sent"); throw URLError(.badURL) }
            XCTFail("expected a refusal")
        } catch let e as PqBoxChannelTunnel.TunnelError {
            if case .notReady = e {} else { XCTFail("\(e)") }
        }
    }
}
