import XCTest
import FlagshipAPI
@testable import FlagshipUI

final class OpenRouterCompatibilityTests: XCTestCase {
    func test_openRouterUsesLegacyDaemonOpenAiStreamingAdapter() {
        let selection = VibeCodeCredentialSelection.compatible(
            with: LlmProviderCredential(provider: "openrouter", apiKey: "sk-or-test")
        )

        XCTAssertEqual(selection.credential?.provider, "openai")
        XCTAssertEqual(selection.credential?.apiKey, "sk-or-test")
        XCTAssertEqual(selection.credential?.baseUrl, "https://openrouter.ai/api")
        XCTAssertEqual(selection.model, "openrouter/auto")
    }

    func test_openRouterPreservesCustomBaseUrl() {
        let selection = VibeCodeCredentialSelection.compatible(
            with: LlmProviderCredential(
                provider: "openrouter",
                apiKey: "sk-or-test",
                baseUrl: "https://router.example/api"
            )
        )

        XCTAssertEqual(selection.credential?.baseUrl, "https://router.example/api")
    }

    func test_otherProvidersRemainUnchanged() {
        let credential = LlmProviderCredential(provider: "anthropic", apiKey: "sk-test")
        let selection = VibeCodeCredentialSelection.compatible(with: credential)

        XCTAssertEqual(selection.credential, credential)
        XCTAssertNil(selection.model)
    }
}
