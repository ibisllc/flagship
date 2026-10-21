import Foundation
import FlagshipAPI

/// The chat ("vibe") Deploy: the box tests the app on a private staging copy
/// (the session's AI may fix a copy that won't start), then installs the
/// tested image. A current box answers `{started:true}` at once and the phone
/// follows the session's `status` / `deployPhase`; an older box ignores
/// `background` and answers with the finished result.
@MainActor
enum VibeCodeDeployRun {
    enum Outcome: Equatable {
        case deployed(url: String, inviteOnly: Bool?)
        case failed(String)
        /// Stopped following (too long, or the box stopped answering); the
        /// screen's own poll carries on.
        case unknown
    }

    /// The deploy line for a `deployPhase`; nil phase keeps today's text.
    static func phaseText(_ phase: String?) -> String {
        switch phase {
        case "staging": return String(localized: "Testing the app on a private copy…")
        case "fixing": return String(localized: "The AI is fixing a problem it found…")
        case "going-live": return String(localized: "Installing…")
        default: return String(localized: "Building and starting your app…")
        }
    }

    static func run(
        client: any ScreensClient,
        sessionId: String,
        credential: LlmProviderCredential? = nil,
        pollInterval: Duration = .seconds(2),
        pollLimit: Duration = .seconds(30 * 60),
        onPhase: @MainActor (String?) -> Void = { _ in }
    ) async throws -> Outcome {
        do {
            // The chat's key as it is now (incl. its relay setting), so a
            // retry after "Turn the relay off for this key" uses the new one.
            let r = try await client.vibeCodeDeployStart(sessionId: sessionId, credential: credential)
            if r.started != true {
                if r.ok != false, let url = r.url { return .deployed(url: url, inviteOnly: r.inviteOnly) }
                return .failed(String(localized: "Deploy was rejected by the server."))
            }
        } catch let ScreensClientError.http(status, _) where status == 409 {
            // Already deploying (a second tap, or another device): follow it.
        }
        return try await follow(client: client, sessionId: sessionId, pollInterval: pollInterval,
                                pollLimit: pollLimit, onPhase: onPhase)
    }

    private static func follow(
        client: any ScreensClient,
        sessionId: String,
        pollInterval: Duration,
        pollLimit: Duration,
        onPhase: @MainActor (String?) -> Void
    ) async throws -> Outcome {
        let clock = ContinuousClock()
        let deadline = clock.now + pollLimit
        var misses = 0
        while clock.now < deadline {
            try await Task.sleep(for: pollInterval)
            let s: VibeCodeStatusResponse
            do {
                s = try await client.vibeCodeStatus(sessionId: sessionId)
                misses = 0
            } catch {
                misses += 1
                if misses >= 5 { return .unknown }
                continue
            }
            switch s.status {
            case "deploying":
                onPhase(s.deployPhase)
            case "deployed":
                return .deployed(url: s.deployedUrl ?? "", inviteOnly: nil)
            case "failed", "cancelled":
                return .failed(s.errorReason ?? String(localized: "The deploy didn't finish."))
            default:
                // Not marked deploying yet (or a stale read): keep watching.
                continue
            }
        }
        return .unknown
    }
}
