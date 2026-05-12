import Foundation
import Observation
import FlagshipAPI

/// Owns the live vibe-code session: subscribes to the frame stream,
/// accumulates tokens into a transcript, captures build logs, and
/// surfaces the final deployed URL.
@Observable
@MainActor
public final class VibeCodeStreamViewModel {
    public private(set) var transcript: String = ""
    public private(set) var buildLogs: [String] = []
    public private(set) var manifestJson: String?
    public private(set) var deployedAppId: String?
    public private(set) var deployedUrl: String?
    public private(set) var errorMessage: String?
    public private(set) var status: Status = .streaming

    public enum Status: Sendable { case streaming, building, deployed, failed, done }

    public let sessionId: String
    private let client: any ScreensClient
    private var streamTask: Task<Void, Never>?

    public init(sessionId: String, client: any ScreensClient) {
        self.sessionId = sessionId
        self.client = client
    }

    public func start() {
        streamTask?.cancel()
        streamTask = Task { [weak self] in
            guard let stream = self?.client.vibeCodeStream(sessionId: self?.sessionId ?? "") else { return }
            for await frame in stream {
                guard !Task.isCancelled else { break }
                self?.apply(frame)
            }
        }
    }

    public func cancel() {
        streamTask?.cancel()
        streamTask = nil
    }

    private func apply(_ frame: VibeCodeFrame) {
        switch frame {
        case .token(let text):
            transcript += text
        case .manifestEmit(let json):
            manifestJson = json
        case .repoCreate:
            buildLogs.append("Created git repo.")
        case .buildStart:
            status = .building
            buildLogs.append("── BUILD START ──")
        case .buildLog(let line):
            buildLogs.append(line)
        case .deploy(let appId, let url):
            deployedAppId = appId
            deployedUrl = url
            status = .deployed
        case .done:
            status = .done
        case .error(let m):
            errorMessage = m
            status = .failed
        }
    }
}
