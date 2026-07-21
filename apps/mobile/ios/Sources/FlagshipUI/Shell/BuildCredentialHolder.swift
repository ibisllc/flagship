import SwiftUI
import FlagshipAPI

/// In-memory holder for the BYOK credential the box should use for the
/// CURRENT build, set at the AI-key step and consumed by the downstream
/// build container (scratch start/reply, git adapt). Mirrors the webapp's
/// module-level `buildCredential` — scoped to the Services tab and never
/// persisted by this holder (saving is the SavedKeyStore's job, gated by the
/// "Save on this device" toggle). The credential never rides a navigation
/// route (it's a secret); it's threaded to the containers that need it.
@MainActor
@Observable
public final class BuildCredentialHolder {
    public var credential: LlmProviderCredential?
    public init() {}

    /// Take + clear the held credential (single-use handoff).
    public func take() -> LlmProviderCredential? {
        defer { credential = nil }
        return credential
    }

    public func clear() { credential = nil }
}

struct VibeCodeCredentialSelection: Equatable {
    let credential: LlmProviderCredential?
    let model: String?

    static func compatible(with credential: LlmProviderCredential?) -> Self {
        guard let credential, credential.provider == "openrouter" else {
            return Self(credential: credential, model: nil)
        }
        return Self(
            credential: LlmProviderCredential(
                provider: "openai",
                apiKey: credential.apiKey,
                baseUrl: credential.baseUrl ?? "https://openrouter.ai/api"
            ),
            model: "openrouter/auto"
        )
    }
}
