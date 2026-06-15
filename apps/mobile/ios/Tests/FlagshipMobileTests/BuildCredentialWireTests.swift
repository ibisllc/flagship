import XCTest
@testable import FlagshipAPI

/// BYOK credential wire-fidelity. The `credential` field rides three build
/// request bodies (vibe-code start, vibe-code reply, git adapt) and MUST
/// match the daemon contract in `packages/server-daemon/src/screens/types.ts`
/// (`LlmProviderCredential`) + the `parseCredential` validator in
/// buildModesHttp.ts + the webapp `providers.js` — `{provider, apiKey,
/// baseUrl?}`. nil ⇒ the field is OMITTED (absent ⇒ none), which the daemon
/// treats as "no credential delivered". The key is never echoed/logged here.
final class BuildCredentialWireTests: XCTestCase {

    private func encodedObject<T: Encodable>(_ v: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(v)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - field shape on the credential itself

    func test_credential_encodesProviderApiKeyBaseUrl() throws {
        let obj = try encodedObject(LlmProviderCredential(provider: "anthropic", apiKey: "sk-x", baseUrl: "https://p"))
        XCTAssertEqual(obj["provider"] as? String, "anthropic")
        XCTAssertEqual(obj["apiKey"] as? String, "sk-x")
        XCTAssertEqual(obj["baseUrl"] as? String, "https://p")
    }

    func test_credential_omitsBaseUrlWhenNil() throws {
        let obj = try encodedObject(LlmProviderCredential(provider: "openai", apiKey: "sk-y"))
        XCTAssertNil(obj["baseUrl"])
    }

    func test_credential_decodesFromDaemonWireJSON() throws {
        // The exact shape from docs/build-modes.md.
        let json = #"{"provider":"anthropic","apiKey":"sk-owner","baseUrl":"https://x"}"#
        let c = try JSONDecoder().decode(LlmProviderCredential.self, from: Data(json.utf8))
        XCTAssertEqual(c.provider, "anthropic")
        XCTAssertEqual(c.apiKey, "sk-owner")
        XCTAssertEqual(c.baseUrl, "https://x")
    }

    // MARK: - credential attaches under the "credential" key on each request

    func test_vibeStart_carriesCredentialUnderCredentialKey() throws {
        let req = VibeCodeStartRequest(
            prompt: "build it", model: nil,
            credential: LlmProviderCredential(provider: "anthropic", apiKey: "sk-1")
        )
        let obj = try encodedObject(req)
        let cred = try XCTUnwrap(obj["credential"] as? [String: Any])
        XCTAssertEqual(cred["provider"] as? String, "anthropic")
        XCTAssertEqual(cred["apiKey"] as? String, "sk-1")
    }

    func test_vibeStart_omitsCredentialWhenNil() throws {
        let obj = try encodedObject(VibeCodeStartRequest(prompt: "p", model: nil))
        XCTAssertNil(obj["credential"])
    }

    func test_vibeReply_carriesCredentialUnderCredentialKey() throws {
        let req = VibeCodeReplyRequest(
            text: "ok",
            credential: LlmProviderCredential(provider: "openai", apiKey: "sk-2", baseUrl: "https://z")
        )
        let obj = try encodedObject(req)
        let cred = try XCTUnwrap(obj["credential"] as? [String: Any])
        XCTAssertEqual(cred["provider"] as? String, "openai")
        XCTAssertEqual(cred["baseUrl"] as? String, "https://z")
    }

    func test_buildAdapt_carriesCredentialUnderCredentialKey() throws {
        let req = BuildAdaptRequest(
            credential: LlmProviderCredential(provider: "google", apiKey: "sk-3")
        )
        let obj = try encodedObject(req)
        let cred = try XCTUnwrap(obj["credential"] as? [String: Any])
        XCTAssertEqual(cred["provider"] as? String, "google")
        XCTAssertEqual(cred["apiKey"] as? String, "sk-3")
    }

    func test_buildAdapt_omitsCredentialWhenNil() throws {
        let obj = try encodedObject(BuildAdaptRequest())
        XCTAssertNil(obj["credential"])
    }

    // MARK: - needsCredential response signal

    func test_startResponse_decodes_needsCredential() throws {
        let json = #"{"sessionId":"vc-1","needsCredential":true}"#
        let r = try JSONDecoder().decode(VibeCodeStartResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.sessionId, "vc-1")
        XCTAssertEqual(r.needsCredential, true)
    }

    func test_startResponse_decodes_withoutNeedsCredential() throws {
        let r = try JSONDecoder().decode(VibeCodeStartResponse.self, from: Data(#"{"sessionId":"vc-2"}"#.utf8))
        XCTAssertNil(r.needsCredential)
    }

    // MARK: - Mock matches the live wire format

    func test_mock_signalsNeedsCredential_whenNoneSent() async throws {
        let mock = MockScreensClient()
        mock.simulatedLatency = 0
        let r = try await mock.vibeCodeStart(VibeCodeStartRequest(prompt: "p", model: nil))
        XCTAssertEqual(r.needsCredential, true, "Mock must mirror the daemon's graceful-absence signal")
    }

    func test_mock_drivesSession_whenCredentialSent() async throws {
        let mock = MockScreensClient()
        mock.simulatedLatency = 0
        let r = try await mock.vibeCodeStart(VibeCodeStartRequest(
            prompt: "p", model: nil,
            credential: LlmProviderCredential(provider: "anthropic", apiKey: "sk-mock")
        ))
        XCTAssertNil(r.needsCredential, "A delivered credential drives the model — no needsCredential")
    }
}
