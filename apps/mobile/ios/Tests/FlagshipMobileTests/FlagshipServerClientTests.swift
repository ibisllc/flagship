import XCTest
@testable import FlagshipAPI

final class FlagshipServerClientTests: XCTestCase {

    private func makeClient() -> MockFlagshipServerClient {
        let c = MockFlagshipServerClient()
        c.simulatedLatency = 0
        return c
    }

    // MARK: - v2 control-plane endpoints

    func test_claimUsername_idempotentUnderSameIrk() async throws {
        let c = makeClient()
        let req = UsernameClaimRequest(
            request: .init(username: "harry", irkPub: "abcd", issuedAt: 1),
            signature: "deadbeef"
        )
        try await c.claimUsername(req)
        // Same IRK retake — should succeed.
        try await c.claimUsername(req)
        XCTAssertEqual(c.claimedUsernames["harry"], "abcd")
    }

    func test_claimUsername_throws409OnDifferentIrk() async throws {
        let c = makeClient()
        try await c.claimUsername(.init(
            request: .init(username: "harry", irkPub: "aaaa", issuedAt: 1),
            signature: "x"
        ))
        do {
            try await c.claimUsername(.init(
                request: .init(username: "harry", irkPub: "bbbb", issuedAt: 2),
                signature: "y"
            ))
            XCTFail("expected throw")
        } catch let ScreensClientError.http(status, _) {
            XCTAssertEqual(status, 409)
        }
    }

    func test_issueAuthCode_persistsBySerial() async throws {
        let c = makeClient()
        let code = AuthCodeWire(
            version: 1, serial: "01CAFE", username: "harry",
            serverName: "home", serverDomain: "home.harry.flagship.services",
            delegatedPubKey: "11", userPubKey: "22",
            issuedAt: 1, expiresAt: 2
        )
        try await c.issueAuthCode(.init(code: code, signature: "sig"))
        XCTAssertEqual(c.issuedAuthCodes["01CAFE"]?.serverName, "home")
    }

    func test_registerRck_persistsBySubdomain() async throws {
        let c = makeClient()
        try await c.registerRck(.init(
            request: .init(
                username: "harry",
                subdomain: "home.harry.flagship.services",
                rckPubKey: "rck",
                issuedAt: 1
            ),
            signature: "sig"
        ))
        XCTAssertEqual(c.registeredRcks["home.harry.flagship.services"], "rck")
    }

    // MARK: - Username availability

    func test_usernameAvailable_acceptsValidLowercase() async throws {
        let c = makeClient()
        let r = try await c.usernameAvailable("harry42")
        XCTAssertTrue(r.available)
        XCTAssertNil(r.reason)
    }

    func test_usernameAvailable_rejectsReserved() async throws {
        let c = makeClient()
        let r = try await c.usernameAvailable("root")
        XCTAssertFalse(r.available)
        XCTAssertEqual(r.reason, "Reserved.")
    }

    func test_usernameAvailable_reflectsClaimedNames() async throws {
        let c = makeClient()
        try await c.claimUsername(.init(
            request: .init(username: "alice", irkPub: "aaaa", issuedAt: 1),
            signature: "x"
        ))
        let r = try await c.usernameAvailable("alice")
        XCTAssertFalse(r.available)
        XCTAssertEqual(r.reason, "Already claimed.")
    }

    // MARK: - Recovery envelope

    func test_recoveryEnvelope_roundTrip() async throws {
        let c = makeClient()
        let req = RecoveryEnvelopeRequest(
            credentialId: "cred-1",
            wrappedUmkBase64: "Zm9v",
            nonceBase64: "YmFy"
        )
        _ = try await c.registerRecoveryEnvelope(req)
        let fetched = try await c.fetchRecoveryEnvelope(credentialId: "cred-1")
        XCTAssertEqual(fetched.credentialId, "cred-1")
        XCTAssertEqual(fetched.wrappedUmkBase64, "Zm9v")
    }

    func test_fetchRecoveryEnvelope_unknownCredentialThrows404() async {
        let c = makeClient()
        do {
            _ = try await c.fetchRecoveryEnvelope(credentialId: "unknown")
            XCTFail("expected throw")
        } catch let ScreensClientError.http(status, _) {
            XCTAssertEqual(status, 404)
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }

    // MARK: - Push-token registration

    func test_registerPushToken_mintsTokenIdAndPersists() async throws {
        let c = makeClient()
        let resp = try await c.registerPushToken(.init(
            request: .init(
                username: "harry",
                platform: "apns",
                providerToken: "deadbeef",
                pushX25519Pub: String(repeating: "ab", count: 32),
                issuedAt: 7
            ),
            signature: "sig"
        ))
        XCTAssertTrue(resp.ok)
        XCTAssertFalse(resp.tokenId.isEmpty)
        XCTAssertEqual(c.registeredPushTokens[resp.tokenId]?.username, "harry")
        XCTAssertEqual(c.registeredPushTokens[resp.tokenId]?.platform, "apns")
    }

    func test_liveClient_registerPushToken_postsToApiPushRegister() async throws {
        StubURLProtocol.handler = { req in
            XCTAssertEqual(req.httpMethod, "POST")
            XCTAssertEqual(req.url?.path, "/api/push/register")
            let bodyData = req.httpBodyStreamData() ?? req.httpBody ?? Data()
            let body = try JSONDecoder().decode(PushTokenRegisterRequest.self, from: bodyData)
            XCTAssertEqual(body.request.platform, "apns")
            XCTAssertEqual(body.request.providerToken, "deadbeef")
            let resp = HTTPURLResponse(
                url: req.url!, statusCode: 201, httpVersion: "HTTP/2", headerFields: nil
            )!
            let payload = try JSONEncoder().encode(
                PushTokenRegisterResponse(ok: true, tokenId: "tok_real_123")
            )
            return (resp, payload)
        }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: cfg)
        let client = LiveFlagshipServerClient(
            urlSession: session,
            baseUrl: URL(string: "https://flagshipserver.com")!
        )
        let resp = try await client.registerPushToken(.init(
            request: .init(
                username: "harry", platform: "apns", providerToken: "deadbeef",
                pushX25519Pub: String(repeating: "ab", count: 32), issuedAt: 7
            ),
            signature: "sig"
        ))
        XCTAssertEqual(resp.tokenId, "tok_real_123")
        StubURLProtocol.handler = nil
    }
}

// MARK: - URLProtocol stub

final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { handler != nil }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let h = StubURLProtocol.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        do {
            let (resp, data) = try h(request)
            client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}

private extension URLRequest {
    /// URLSession sometimes hands a stream-backed body to URLProtocol
    /// instead of an inline Data; read it back synchronously for tests.
    func httpBodyStreamData() -> Data? {
        guard let stream = self.httpBodyStream else { return nil }
        stream.open(); defer { stream.close() }
        var data = Data()
        let bufSize = 1024
        let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
        defer { buf.deallocate() }
        while stream.hasBytesAvailable {
            let n = stream.read(buf, maxLength: bufSize)
            if n <= 0 { break }
            data.append(buf, count: n)
        }
        return data
    }
}
