#if DEBUG
import Foundation
import Flagship
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// The open git build `-smoke-build-interrupted` seeds: a restart cut
    /// its AI run off, so the box kept its files and says so.
    public static let interruptedBuildId = "bld-recipes03"
    public static let interruptedReason =
        String(localized: "The server restarted while the AI was working on this build. Its files are kept: run the AI again, or deploy.")

    /// The chats `-smoke-chat` seeds: one ready to deploy on Flagship
    /// Inference (Medium, text only; a long conversation), one failed on an
    /// own OpenAI key whose Flagship relay wasn't reachable.
    public static let readyChatId = "gym-ready"
    public static let failedChatId = "gym-failed"
    public static let relayFailure = String(localized: "The Flagship relay isn't reachable right now, so the AI couldn't be asked.")
    /// The OpenAI key `-smoke-chat` saves on this device (label "Work").
    public static let gymOpenAiKey = "sk-gym-openai-000000000000000000000000"

    /// Files staged in a new chat's composer (`-smoke-chat-image`); the
    /// pickers themselves are system UI a UI test can't drive.
    nonisolated(unsafe) public static var chatAttachments: [VibeCodeAttachment] = []

    /// AI keys live in the simulator's keychain across launches: every smoke
    /// launch starts with none (and no remembered model choice), so one
    /// scenario's keys never change another's AI-key step. Runs before any
    /// area's seams, which may then save their own.
    static func resetAiKeys() {
        SavedKeyStore().clear()
        DefaultModelStore.clear()
        ModelMenuCache.clear()
    }

    /// Build seams for GymSweepBuildTests.
    static func build(_ args: [String], _ app: AppState, _ operations: ActiveOperationsCenter, _ mocks: GymMocks) {
        if args.contains("-smoke-build-interrupted") {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            mocks.screens.buildSessionsFixture = BuildSessionsResponse(builds: [
                BuildSummary(buildId: interruptedBuildId, mode: "git", name: "recipes",
                             startedAt: now - 60_000 * 20, lastAt: now - 60_000 * 15, entryCount: 4,
                             lastKind: "adapt-started", open: true),
                BuildSummary(buildId: "bld-plants01", mode: "scratch", serviceId: "bright-maple--plants",
                             startedAt: now - 60_000 * 60, lastAt: now - 60_000 * 58, entryCount: 9, lastKind: "deployed"),
            ])
            mocks.screens.buildStateFixtures[interruptedBuildId] = BuildStateResponse(
                state: .init(buildId: interruptedBuildId, mode: "git", name: "recipes",
                             adapt: BuildAdaptStatus(status: "failed", reason: interruptedReason)),
                files: ["package.json", "server.js", "flagship.app.json"])
        }
        chatAttachments = args.contains("-smoke-chat-image")
            ? [.image(name: "mockup.png", mediaType: "image/png", data: Data(repeating: 0x89, count: 64))]
            : []
        if args.contains("-smoke-chat") { seedChats(mocks.screens) }
        if args.contains("-smoke-git-name-taken") {
            mocks.screens.buildGitError = ScreensClientError.http(
                status: 409, message: String(localized: #"{"ok":false,"name":"recipes","kind":"session","sessionId":"gym-ready"}"#))
        }
        if args.contains("-smoke-git-relay-fails") {
            mocks.screens.buildAdaptStatusFixture = BuildAdaptStatus(status: "failed", reason: relayFailure)
        }
        if args.contains("-smoke-git-sealed") {
            mocks.screens.buildAdaptStartError = ScreensClientError.http(
                status: 409,
                message: String(localized: #"{"error":"This build is closed to the AI. Check the repo again to start a new build."}"#))
        }
    }

    /// One saved OpenAI key, no remembered model choices, and the two chats.
    private static func seedChats(_ screens: MockScreensClient) {
        _ = try? SavedKeyStore().add(provider: "openai", label: String(localized: "Work"), apiKey: gymOpenAiKey)
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        screens.vibeCodeSessionsFixture = [
            VibeCodeSessionMeta(sessionId: readyChatId, startedAt: now - 3_600_000, status: "ready-to-deploy",
                                name: "recipe-box", updatedAt: now - 60_000),
            VibeCodeSessionMeta(sessionId: failedChatId, startedAt: now - 7_200_000, status: "failed",
                                serviceId: "bright-maple--plants", name: "plants-v2", updatedAt: now - 120_000),
        ]
        screens.vibeCodeQuietStreams = [readyChatId, failedChatId]
        screens.vibeCodeSessionStateFixtures[readyChatId] = VibeCodeSessionPublicState(
            id: readyChatId, appId: nil, status: "ready-to-deploy",
            messages: [
                VibeCodeSessionMessage(role: "user", text: String(localized: "A recipe box with photos."), timestamp: now - 3_600_000),
                VibeCodeSessionMessage(role: "assistant", text: "Done: recipes, photos and a search. Ready to deploy.",
                                       timestamp: now - 60_000, credits: 2.5),
            ],
            pendingRequest: nil, model: "medium", summarised: true, canContinue: true, provider: "flagship",
            conversationTokens: 300_000)
        screens.vibeCodeSessionStateFixtures[failedChatId] = VibeCodeSessionPublicState(
            id: failedChatId, appId: "bright-maple--plants", status: "failed",
            messages: [
                VibeCodeSessionMessage(role: "user", text: String(localized: "Add watering reminders."), timestamp: now - 7_200_000),
            ],
            pendingRequest: nil, failureReason: relayFailure, model: "qwen3-coder", canContinue: true,
            provider: "openai", conversationTokens: 4_000)
        screens.vibeCodeNameCheckFixtures = [
            "plants": VibeCodeNameCheck(ok: false, name: "plants", kind: "app", serviceId: "bright-maple--plants"),
            "recipe-box": VibeCodeNameCheck(ok: false, name: "recipe-box", kind: "session", sessionId: readyChatId),
        ]
    }
}
#endif
