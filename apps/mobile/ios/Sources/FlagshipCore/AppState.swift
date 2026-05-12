import Foundation
import Observation

/// App-wide observable state. The single source of truth for "who is the
/// user, which servers do they own, which one is the leader."
///
/// `isPaired` gates the RootShell — when false, the OnboardingFlow is
/// presented as a full-screen cover. The first pod added is automatically
/// marked leader; users can change which pod is leader later from the
/// pod card context menu.
@Observable
public final class AppState {
    public var isPaired: Bool
    public var currentUser: String?
    public var pods: [PodInfo]
    public var leaderPodId: String?

    public init(
        isPaired: Bool = false,
        currentUser: String? = nil,
        pods: [PodInfo] = [],
        leaderPodId: String? = nil
    ) {
        self.isPaired = isPaired
        self.currentUser = currentUser
        self.pods = pods
        self.leaderPodId = leaderPodId
    }

    public var leaderPod: PodInfo? {
        guard let id = leaderPodId else { return nil }
        return pods.first(where: { $0.podId == id })
    }

    public func completeOnboarding(username: String, pods: [PodInfo]) {
        self.currentUser = username
        self.pods = pods
        self.leaderPodId = pods.first?.podId
        self.isPaired = true
    }

    public func addPod(_ pod: PodInfo) {
        pods.append(pod)
        if leaderPodId == nil { leaderPodId = pod.podId }
    }

    public func setLeader(_ podId: String) {
        guard pods.contains(where: { $0.podId == podId }) else { return }
        leaderPodId = podId
    }

    public func removePod(_ podId: String) {
        pods.removeAll { $0.podId == podId }
        if leaderPodId == podId { leaderPodId = pods.first?.podId }
    }

    public func signOut() {
        self.isPaired = false
        self.currentUser = nil
        self.pods = []
        self.leaderPodId = nil
    }
}

/// A single server pod. `name` is the user-facing short label
/// (e.g. "Home"); `description` is a longer one-liner ("Failover for
/// work", "Music projects") shown wherever the FQDN used to live.
/// The FQDN itself is technical and lives only in detail views.
public struct PodInfo: Identifiable, Hashable, Sendable {
    public enum Status: String, Sendable, Hashable { case online, offline, unknown }

    public let podId: String
    public let name: String
    public let description: String?
    public let fqdn: String
    public let status: Status
    public var id: String { podId }

    public init(
        podId: String,
        name: String,
        description: String? = nil,
        fqdn: String,
        status: Status = .unknown
    ) {
        self.podId = podId
        self.name = name
        self.description = description
        self.fqdn = fqdn
        self.status = status
    }
}
