import XCTest
import CryptoKit
@testable import FlagshipAPI
@testable import FlagshipCore

/// Wire shapes for SEC-REPAIR-001 (recovery passkey), SEC-BROWSER-002 (browser grants) and N12
/// (upstream sync), against what `.com` and the box read and send.
final class Release03ClientWireTests: XCTestCase {
    private func json(_ v: some Encodable) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(v)) as! [String: Any]
    }

    // MARK: - Recovery passkey

    private func claim() -> RecoveryRecordV2 {
        RecoveryRecordV2(op: "put", username: "alice", irkPubHex: String(repeating: "a", count: 64), adminRootPubHex: "none",
                         credentialIdHex: "aabbccdd00112233", wrappedUmkDigestHex: String(repeating: "b", count: 64),
                         adminRoot: .none, acmeKey: .none, fetchTokenHashHex: String(repeating: "c", count: 64),
                         prfSaltHashHex: String(repeating: "d", count: 64), kdfVersion: 1, algVersion: 1,
                         policy: RecoveryRecordV2.policy, generation: 1,
                         nonceHex: String(repeating: "e", count: 32), priorDigestHex: "genesis", issuedAt: 1)
    }

    func testUploadCarriesTheAttestationBesideTheSignedRecord() throws {
        let with = try json(RecoveryUploadRequest(claim: claim(), signature: "00", wrappedUmk: "AA==", passkeyAttestationObject: "o2NmbXQ"))
        XCTAssertEqual(with["passkeyAttestationObject"] as? String, "o2NmbXQ")
        XCTAssertNil((with["claim"] as? [String: Any])?["passkeyAttestationObject"], "Never inside the signed claim.")
        let without = try json(RecoveryUploadRequest(claim: claim(), signature: "00", wrappedUmk: "AA=="))
        XCTAssertNil(without["passkeyAttestationObject"], "Absent, not null, when the credential is unchanged.")
    }

    func testFetchBodyCarriesTheAssertion() throws {
        let p = RecoveryPasskeyAssertion(challenge: "Y2g", assertion: .init(credentialId: "aWQ", authenticatorData: "YWQ",
                                                                            clientDataJSON: "Y2Q", signature: "c2ln"))
        let b = try json(RecoveryGatedFetchBody(fetchToken: "ab", issuedAt: 5, passkey: p))
        let passkey = try XCTUnwrap(b["passkey"] as? [String: Any])
        XCTAssertEqual(passkey["challenge"] as? String, "Y2g")
        XCTAssertEqual(passkey["assertion"] as? [String: String],
                       ["credentialId": "aWQ", "authenticatorData": "YWQ", "clientDataJSON": "Y2Q", "signature": "c2ln"])
        XCTAssertNil(try json(RecoveryGatedFetchBody(fetchToken: "ab", issuedAt: 5, passkey: nil))["passkey"])
    }

    func testFetchFieldMatchesTheCorePort() throws {
        let core = RecoveryPasskey.fetchPasskeyField(challenge: "Y2g", credentialId: Data([1, 2]), authenticatorData: Data([3]),
                                                     clientDataJSON: Data([4]), signature: Data([5, 6]))
        let a = core["assertion"] as! [String: String]
        let wire = RecoveryPasskeyAssertion(challenge: "Y2g", assertion: .init(
            credentialId: RecoveryPasskey.base64url(Data([1, 2])), authenticatorData: RecoveryPasskey.base64url(Data([3])),
            clientDataJSON: RecoveryPasskey.base64url(Data([4])), signature: RecoveryPasskey.base64url(Data([5, 6]))))
        XCTAssertEqual(a, ["credentialId": wire.assertion.credentialId, "authenticatorData": wire.assertion.authenticatorData,
                           "clientDataJSON": wire.assertion.clientDataJSON, "signature": wire.assertion.signature])
    }

    func testWipeRestartCarriesTheNewAttestationAtTopLevel() throws {
        let body = WipeRestartRequest(request: .init(username: "alice", oldIrkPub: "aa", newIrkPub: "bb", newCredentialId: "cc",
                                                     newWrappedUmk: "AA==", issuedAt: 1),
                                      signature: "00", idempotencyKey: "11", newPasskeyAttestationObject: "o2NmbXQ")
        let j = try json(body)
        XCTAssertEqual(j["newPasskeyAttestationObject"] as? String, "o2NmbXQ")
        XCTAssertNil((j["request"] as? [String: Any])?["newPasskeyAttestationObject"], "Not inside the signed request.")
    }

    func testPasskeyRefusalsHaveOneSentenceEach() {
        XCTAssertEqual(RecoveryPasskeyCopy.message(forCode: "passkey-required"),
                       "This recovery needs your passkey. Try again and choose your Flagship passkey.")
        XCTAssertEqual(RecoveryPasskeyCopy.message(forCode: "passkey-challenge"), "The passkey check expired. Try again.")
        XCTAssertEqual(RecoveryPasskeyCopy.message(forCode: "passkey-invalid"), "That passkey isn't the one your account recovery uses.")
        XCTAssertEqual(RecoveryPasskeyCopy.message(forCode: "passkey-unavailable"),
                       "Passkey recovery isn't available right now. Try again later.")
        XCTAssertNil(RecoveryPasskeyCopy.message(forCode: "invalid fetch token"))
        XCTAssertEqual(RecoveryPasskeyCopy.code(inBody: Data(#"{"error":"x","code":"passkey-invalid"}"#.utf8)), "passkey-invalid")
        XCTAssertNil(RecoveryPasskeyCopy.code(inBody: Data(#"{"error":"invalid fetch token"}"#.utf8)))
        XCTAssertTrue(RecoveryPasskeyCopy.isUnavailable(ScreensClientError.http(status: 503, message: #"{"code":"passkey-unavailable"}"#)))
        XCTAssertFalse(RecoveryPasskeyCopy.isUnavailable(ScreensClientError.http(status: 403, message: #"{"code":"passkey-required"}"#)))
        XCTAssertEqual(RecoveryPasskeyCopy.passphraseHint,
                       "Longer is stronger and there is no upper limit: a whole sentence you will remember works well")
    }

    func testFetchResponseAndStateReadThePasskeyFields() throws {
        let r = try JSONDecoder().decode(RecoveryFetchResponse.self, from: Data(#"""
        {"username":"alice","credentialId":"aa","wrappedUmk":"AA==","legacy":true,"passkeyLegacy":true}
        """#.utf8))
        XCTAssertEqual(r.passkeyLegacy, true)
        XCTAssertNil(r.passkeyChecked)
        XCTAssertTrue(RecoveryRecordState(credentialId: "aa", wrappedUmkHash: "", legacy: false, passkeyRequired: false).needsPasskeyUpdate)
        XCTAssertFalse(RecoveryRecordState(credentialId: "aa", wrappedUmkHash: "", legacy: false, passkeyRequired: nil).needsPasskeyUpdate,
                       "A .com that doesn't say is never asked about.")
    }

    func testMockComChecksThePasskeyOnceTheRecordHoldsIt() async throws {
        let server = MockFlagshipServerClient()
        server.simulatedLatency = 0
        server.seedRecoveryRecord(username: "alice", credentialId: "aabb", wrappedUmk: "AA==", fetchTokenHash: String(repeating: "0", count: 64),
                                  prfSaltHash: String(repeating: "0", count: 64), passkey: true)
        let state = try await server.recoveryRecordState(username: "alice")
        XCTAssertEqual(state?.passkeyRequired, true)
        do {
            _ = try await server.fetchWrappedUmk(username: "alice", fetchTokenHex: "00", passkey: nil)
            XCTFail("a keyed record needs the passkey")
        } catch ScreensClientError.http(let status, let message) {
            XCTAssertEqual(status, 403)
            XCTAssertEqual(message, RecoveryPasskeyCopy.message(forCode: "passkey-required"))
        }
    }

    // MARK: - Browser grants

    func testGrantRequestsDecodeEveryLocalNetworkShape() throws {
        let r = try JSONDecoder().decode(BrowserGrantRequestsResponse.self, from: Data(#"""
        {"requests":[
          {"requestId":"r1","serviceId":"a--b","capabilities":["navigate"],"origins":["x.com"],"localNetwork":null,"duration":"once","explanation":"","at":1,"meaning":["Can navigate"]},
          {"requestId":"r2","serviceId":"a--b","capabilities":["input"],"origins":[],"localNetwork":{"kind":"exact","hosts":["10.0.0.2"]},"duration":"session","explanation":"why","at":2,"meaning":[]},
          {"requestId":"r3","serviceId":"a--b","capabilities":["download"],"origins":["*.y.org"],"localNetwork":{"kind":"whole-lan"},"duration":"service","explanation":"","at":3,"meaning":[]}
        ]}
        """#.utf8))
        XCTAssertEqual(r.requests.map(\.localNetwork), [nil, .exact(["10.0.0.2"]), .wholeLan])
    }

    func testOrderSignsExactlyTheAsk() throws {
        let ask = BrowserGrantRequest(requestId: "r2", serviceId: "alice--shop", capabilities: ["read-dom", "navigate"],
                                      origins: ["b.example", "a.example"], localNetwork: .exact(["10.0.0.9", "10.0.0.2"]),
                                      duration: "session")
        let order = BrowserGrantOrder.answer(for: ask, serverDomain: "Home.Alice.flagship.services", decision: "allow", issuedAt: 7)
        let direct = BrowserGrantAnswer(serverDomain: "Home.Alice.flagship.services", requestId: "r2", serviceId: "alice--shop",
                                        decision: "allow", duration: "session", capabilities: ["navigate", "read-dom"],
                                        origins: ["a.example", "b.example"], localNetwork: .exact(["10.0.0.2", "10.0.0.9"]), issuedAt: 7)
        XCTAssertEqual(try order.canonicalBytes(), try direct.canonicalBytes())
        XCTAssertTrue(String(decoding: try order.canonicalBytes(), as: UTF8.self).hasPrefix("flagship/browser-grant/v1|home.alice.flagship.services|r2|alice--shop|allow|session|navigate,read-dom|"))
    }

    func testDenialCarriesNoSignature() throws {
        let j = try json(BrowserGrantAnswerRequest(requestId: "r", decision: "deny", issuedAt: 1))
        XCTAssertNil(j["signature"])
        XCTAssertEqual(j["decision"] as? String, "deny")
    }

    /// "Allow once" on a session ask signs answers[0] with only the duration changed: answers[5] of the shared vector.
    func testAllowOnceOnASessionAskMatchesTheSharedNarrowedAnswer() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var found: URL?
        for _ in 0..<14 {
            let u = dir.appendingPathComponent("packages/protocol/test-vectors/browser-grant/vectors.json")
            if FileManager.default.fileExists(atPath: u.path) { found = u; break }
            dir = dir.deletingLastPathComponent()
        }
        let v = try JSONSerialization.jsonObject(with: Data(contentsOf: try XCTUnwrap(found))) as! [String: Any]
        let answers = v["answers"] as! [[String: Any]]
        guard answers.count > 5 else { throw XCTSkip("the narrowed answer is not in this vectors.json yet") }
        let a0 = answers[0]["answer"] as! [String: Any]
        let l = a0["localNetwork"] as? [String: Any]
        let ask = BrowserGrantRequest(requestId: a0["requestId"] as! String, serviceId: a0["serviceId"] as! String,
                                      capabilities: a0["capabilities"] as! [String], origins: a0["origins"] as! [String],
                                      localNetwork: l.map { ($0["kind"] as? String) == "whole-lan" ? .wholeLan : .exact($0["hosts"] as? [String] ?? []) },
                                      duration: a0["duration"] as! String)
        XCTAssertEqual(BrowserGrantOrder.choices(for: ask), ["once", "session"])
        let order = BrowserGrantOrder.answer(for: ask, serverDomain: a0["serverDomain"] as! String, decision: "allow",
                                             duration: "once", issuedAt: (a0["issuedAt"] as! NSNumber).int64Value)
        let bytes = try order.canonicalBytes()
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), answers[5]["canonical"] as? String)
        let unhex: (String) -> Data = { h in
            var d = Data(); var i = h.startIndex
            while i < h.endIndex { let n = h.index(i, offsetBy: 2); d.append(UInt8(h[i..<n], radix: 16)!); i = n }
            return d
        }
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: unhex(v["pubHex"] as! String))
        XCTAssertTrue(pub.isValidSignature(unhex(answers[5]["signatureHex"] as! String), for: bytes))
        XCTAssertTrue(BrowserGrantAnswer.within(ask: BrowserGrantOrder.scope(of: ask), answer: BrowserGrantOrder.scope(of: ask, duration: "once")))
        XCTAssertFalse(BrowserGrantAnswer.within(ask: BrowserGrantOrder.scope(of: ask), answer: BrowserGrantOrder.scope(of: ask, duration: "service")))
    }

    func testAllowCarriesTheChosenDurationAndTheGrantsListAndRevokeDecode() throws {
        let j = try json(BrowserGrantAnswerRequest(requestId: "r", decision: "allow", issuedAt: 1, signature: "00", duration: "once"))
        XCTAssertEqual(j["duration"] as? String, "once")
        XCTAssertNil(try json(BrowserGrantAnswerRequest(requestId: "r", decision: "deny", issuedAt: 1))["duration"])
        let g = try JSONDecoder().decode(OwnerBrowserGrantsResponse.self, from: Data(#"""
        {"grants":[{"grantId":"bg-1","serviceId":"a--b","capabilities":["navigate"],"origins":["x.com"],"localNetwork":null,
                    "duration":"service","explanation":"prices","issuedAt":5},
                   {"grantId":"bg-2","serviceId":"a--b","capabilities":["input"],"origins":[],"localNetwork":{"kind":"whole-lan"},
                    "duration":"session","explanation":"","issuedAt":6}]}
        """#.utf8))
        XCTAssertEqual(g.grants.map(\.grantId), ["bg-1", "bg-2"])
        XCTAssertEqual(g.grants[1].localNetwork, .wholeLan)
        let r = try json(BrowserGrantRevokeRequest(serviceId: "a--b", grantId: "bg-1", issuedAt: 9, signature: "ab"))
        XCTAssertEqual(r["serviceId"] as? String, "a--b")
        XCTAssertEqual(r["grantId"] as? String, "bg-1")
        XCTAssertEqual((r["issuedAt"] as? NSNumber)?.int64Value, 9)
        XCTAssertEqual(r["signature"] as? String, "ab")
        XCTAssertEqual(String(decoding: try BrowserGrantRevoke(serverDomain: "Home.A.flagship.services", serviceId: "a--b",
                                                               grantId: "bg-1", issuedAt: 9).canonicalBytes(), as: UTF8.self),
                       "flagship/browser-grant-revoke/v1|home.a.flagship.services|a--b|bg-1|9")
    }

    func testBrowserGrantSocketFrame() {
        XCTAssertTrue(BrowserGrantEvents.isRequestFrame(Data(#"{"type":"browser-grant-request","serviceId":"a--b"}"#.utf8)))
        XCTAssertFalse(BrowserGrantEvents.isRequestFrame(Data(#"{"type":"access-request","serviceId":"a--b"}"#.utf8)))
    }

    // MARK: - Upstream sync

    func testUpToDateOpensNoBuild() throws {
        let r = try JSONDecoder().decode(AppSyncResponse.self, from: Data(#"{"ok":true,"upToDate":true,"candidateCommit":"abc"}"#.utf8))
        XCTAssertTrue(r.upToDate)
        XCTAssertNil(r.buildId)
        XCTAssertNil(r.proposal)
        XCTAssertThrowsError(try JSONDecoder().decode(AppSyncResponse.self, from: Data(#"{"ok":true,"upToDate":false}"#.utf8)),
                             "A proposal without its build is not one.")
    }

    func testSyncResponseDecodesTheBoxShape() throws {
        let r = try JSONDecoder().decode(AppSyncResponse.self, from: Data(#"""
        {"ok":true,"buildId":"b1","proposal":{"upstreamChanged":["a"],"localChanged":["b"],"takeUpstream":["a"],"conflicts":[],
         "alreadyApplied":[],"capabilityChanges":[{"section":"network.egress","added":["x.com"],"removed":[]}],"clean":false},
         "candidateCommit":"abc","upToDate":false}
        """#.utf8))
        XCTAssertEqual(r.buildId, "b1")
        XCTAssertEqual(r.proposal?.capabilityChanges.first?.added, ["x.com"])
        XCTAssertEqual(try json(AppSyncRequest(ref: nil)).count, 0, "No ref: the box uses the imported one.")
    }

    func testAppDetailNamesTheRepoToSyncFrom() throws {
        func detail(_ extra: String) throws -> AppDetailResponse {
            try JSONDecoder().decode(AppDetailResponse.self, from: Data("""
            {"app":{"serviceId":"a--b","creator":"a","slug":"b","urlLabel":"b","url":"https://b","status":"running","installedAt":1},
             "manifest":{"browser":{"domains":["shop.example.com"]}},"dataLayerInstances":[],"members":[],"browserTabs":[],
             "recentLogs":[]\(extra)}
            """.utf8))
        }
        XCTAssertNil(try detail("").syncRepo)
        XCTAssertEqual(try detail(#","adaptedFrom":{"repo":"github.com/x/y"}"#).syncRepo, "github.com/x/y")
        XCTAssertEqual(try detail(#","adaptedFrom":{"repo":"r1"},"importedFrom":{"repo":"r2","commit":"c"}"#).syncRepo, "r2")
        XCTAssertEqual(try detail("").browserDomains, ["shop.example.com"])
    }
}
