import Foundation
import Observation
import FlagshipAPI

/// Subscribes to the SSE install-events stream for a freshly-minted
/// build code and accumulates the sequence into a step-list the UI
/// renders. Terminal events (.ready / .failed) flip `isDone`.
@Observable
@MainActor
public final class InstallProgressViewModel {
    public enum Step: String, Sendable, CaseIterable {
        case registered, boot, tunnelOnline = "tunnel-online", certIssued = "cert-issued", ready
        public var title: String {
            switch self {
            case .registered:   return "Phone-home received"
            case .boot:          return "OS booted"
            case .tunnelOnline:  return "Tunnel up"
            case .certIssued:    return "TLS cert issued"
            case .ready:         return "Server is live"
            }
        }
    }

    public private(set) var completed: Set<Step> = []
    public private(set) var serverFqdn: String?
    public private(set) var failedReason: String?
    public private(set) var isDone: Bool = false

    public let serial: String
    public let podName: String?
    private let client: any ScreensClient
    private var streamTask: Task<Void, Never>?
    private var bridgeStarted = false

    public init(serial: String, client: any ScreensClient, podName: String? = nil) {
        self.serial = serial
        self.client = client
        self.podName = podName
    }

    public func start() {
        streamTask?.cancel()
        if !bridgeStarted {
            InstallProgressBridge.shared.onStart?(serial, podName)
            bridgeStarted = true
        }
        streamTask = Task { [weak self] in
            guard let stream = self?.client.installEvents(serial: self?.serial ?? "") else { return }
            for await event in stream {
                guard !Task.isCancelled else { break }
                switch event {
                case .registered:   self?.mark(.registered)
                case .boot:          self?.mark(.boot)
                case .tunnelOnline:  self?.mark(.tunnelOnline)
                case .certIssued:    self?.mark(.certIssued)
                case .ready(let fqdn, _):
                    self?.serverFqdn = fqdn
                    self?.mark(.ready)
                    self?.isDone = true
                    InstallProgressBridge.shared.onComplete?(fqdn)
                case .failed(let reason, _):
                    self?.failedReason = reason
                    self?.isDone = true
                    InstallProgressBridge.shared.onFailed?(reason)
                }
            }
        }
    }

    public func cancel() {
        streamTask?.cancel()
        streamTask = nil
    }

    private func mark(_ step: Step) {
        let wasNew = completed.insert(step).inserted
        if wasNew { InstallProgressBridge.shared.onStep?(step) }
    }
}
