#if DEBUG
import Foundation
import Flagship
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// AI02 (docs/architecture-v2/local-ai.md): `-smoke-local-ai` gives the mock box a downloaded
    /// Qwen2.5 0.5B and TinyStories 260K, a GPU held by Plants, a running fine-tuning job with one
    /// waiting behind it, and Wiki asking to use the model. `-smoke-local-ai-unavailable` has no model
    /// downloaded and a box that can't start one, so "On this server" says why.
    static func localAi(_ args: [String], _ app: AppState, _ mocks: GymMocks) {
        let m = mocks.screens.localAiMock
        if args.contains("-smoke-local-ai") {
            m.models = MockLocalAi.catalog().map { $0.id == "stories-260k" ? MockLocalAi.with($0, state: "installed", progress: nil) : $0 }
            m.jobs = [
                LocalAiJob(id: "1111111111111111", kind: "training", appId: "bright-maple--wiki", appName: "Wiki", modelId: "stories-260k",
                           state: "running", device: "cpu", createdAt: 1, startedAt: 2, epochs: 3, epochsDone: 1, checkpoints: 1),
                LocalAiJob(id: "2222222222222222", kind: "training", appId: "bright-maple--wiki", appName: "Wiki", modelId: "stories-260k",
                           state: "queued", queuePosition: 2, createdAt: 3, epochs: 2, epochsDone: 0, checkpoints: 0),
            ]
            m.autoAdvanceTraining = false
            m.checkpoints["1111111111111111"] = [LocalAiCheckpoint(epoch: 1, sha256: String(repeating: "a", count: 64), sizeBytes: 1_185_376, at: 4, loss: 3.21)]
        }
        if args.contains("-smoke-local-ai-unavailable") {
            m.models = MockLocalAi.catalog().map { MockLocalAi.with($0, state: "available", progress: nil) }
            m.startRefusal = (code: "no-model", sentence: "No model is downloaded on this server yet. Download one under Local AI.")
        }
    }
}
#endif
