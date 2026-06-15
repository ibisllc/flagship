import Foundation
import Observation
import FlagshipAPI
import FlagshipCore

/// Owns the live vibe-code session: subscribes to the frame stream,
/// accumulates tokens into a transcript, captures build logs, and
/// surfaces the final deployed URL.
@Observable
@MainActor
public final class VibeCodeStreamViewModel {
    public private(set) var transcript: String = ""
    public private(set) var buildLogs: [String] = []
    public private(set) var manifestJson: String?
    public private(set) var deployedServiceId: String?
    public private(set) var deployedUrl: String?
    public private(set) var errorMessage: String?
    public private(set) var status: Status = .streaming

    public enum Status: Sendable { case streaming, building, deployed, failed, done }

    public let sessionId: String
    private let client: any ScreensClient
    private var streamTask: Task<Void, Never>?

    /// Optional bridge to the global operations sliver. While the build is
    /// running this session shows up as "building <service> on <server>" in
    /// the sliver — and, because a TabView keeps every tab's nav stack alive,
    /// it stays there while the user works in another tab. Pure presentation;
    /// nil in tests and previews leaves the VM behaviour unchanged.
    private let operations: ActiveOperationsCenter?
    private let serviceLabel: String?
    private let serverLabel: String?

    public init(
        sessionId: String,
        client: any ScreensClient,
        operations: ActiveOperationsCenter? = nil,
        serviceLabel: String? = nil,
        serverLabel: String? = nil
    ) {
        self.sessionId = sessionId
        self.client = client
        self.operations = operations
        self.serviceLabel = serviceLabel
        self.serverLabel = serverLabel
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
        // Tearing down mid-build (e.g. the user pops the generating screen)
        // must not leave a phantom op in the sliver.
        operations?.removeBuild(id: sessionId)
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
            operations?.upsertBuild(
                id: sessionId,
                subject: serviceLabel ?? "a service",
                onServer: serverLabel,
                target: .vibeCodeChat(sessionId: sessionId)
            )
        case .buildLog(let line):
            buildLogs.append(line)
        case .deploy(let serviceId, let url):
            deployedServiceId = serviceId
            deployedUrl = url
            status = .deployed
            operations?.removeBuild(id: sessionId)
        case .done:
            status = .done
            operations?.removeBuild(id: sessionId)
        case .error(let m):
            errorMessage = m
            status = .failed
            operations?.removeBuild(id: sessionId)
        }
    }
}
