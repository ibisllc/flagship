import Foundation
import Observation
import FlagshipAPI
import FlagshipCore

/// Combined view-model for AppDetailScreen. Owns the app detail
/// response, the list of FQDNs the user owns (filtered to those that
/// belong to this app), and the local edit buffer for pod placement +
/// per-app lead pod. Save() ships the diff through `orders/send`.
@Observable
@MainActor
public final class AppDetailViewModel {
    public private(set) var detail: LoadingState<AppDetailResponse> = .idle
    public private(set) var ownedUrls: LoadingState<[OwnedUrl]> = .idle

    /// Pods the app should run on (server-set). Edited locally; reset
    /// by `cancelEdits()` and persisted by `save()`.
    public var runOnPodIds: Set<String> = []
    /// Pod that gets the canonical short domain for this app. nil = use
    /// the global leader.
    public var leadPodId: String?
    /// Custom FQDNs the user has added beyond the canonical/per-pod ones.
    public var customUrls: [String] = []
    public var newCustomUrlDraft: String = ""

    public let appId: String
    private let client: any ScreensClient
    private let allPods: [PodInfo]
    private let globalLeaderPodId: String?

    public init(
        appId: String,
        client: any ScreensClient,
        allPods: [PodInfo],
        globalLeaderPodId: String?
    ) {
        self.appId = appId
        self.client = client
        self.allPods = allPods
        self.globalLeaderPodId = globalLeaderPodId
    }

    public var availablePods: [PodInfo] { allPods }
    public var effectiveLeadPodId: String? { leadPodId ?? globalLeaderPodId }

    public func load() async {
        detail = .loading
        ownedUrls = .loading
        do {
            async let d = client.appDetail(appId: appId)
            async let u = client.urlControllerOwned()
            let (di, uo) = try await (d, u)
            detail = .loaded(di)
            ownedUrls = .loaded(uo.urls.filter { $0.fqdn.contains(appId) })
            // Seed local edits from server state — currently we default
            // to running on the leader-only since the API doesn't yet
            // return a multi-pod policy. When the daemon contract
            // grows a `policy` block we'll seed from that instead.
            if runOnPodIds.isEmpty, let lead = globalLeaderPodId {
                runOnPodIds = [lead]
            }
        } catch {
            detail = .failed(error.localizedDescription)
            ownedUrls = .failed(error.localizedDescription)
        }
    }

    public func togglePod(_ podId: String) {
        if runOnPodIds.contains(podId) { runOnPodIds.remove(podId) }
        else { runOnPodIds.insert(podId) }
        // If we deselected the lead, clear lead so the global leader
        // takes back over.
        if leadPodId == podId && !runOnPodIds.contains(podId) {
            leadPodId = nil
        }
    }

    public func setLead(_ podId: String) {
        runOnPodIds.insert(podId)
        leadPodId = podId
    }

    public func addCustomUrl() {
        let url = newCustomUrlDraft.trimmingCharacters(in: .whitespaces).lowercased()
        guard !url.isEmpty, !customUrls.contains(url) else { return }
        customUrls.append(url)
        newCustomUrlDraft = ""
    }

    public func removeCustomUrl(_ fqdn: String) {
        customUrls.removeAll { $0 == fqdn }
    }

    public func canonicalUrlPreview(for username: String?) -> String? {
        guard let user = username,
              case .loaded(let d) = detail else { return nil }
        return "\(d.app.slug).\(user).flagship.services"
    }

    public func perPodUrlPreview(for username: String?, podName: String) -> String {
        if case .loaded(let d) = detail, let user = username {
            return "\(d.app.slug).\(SlugUtil.slugify(podName)).\(user).flagship.services"
        }
        return ""
    }

    public func save() async throws {
        // Ship the edits as an order envelope. The shape mirrors what
        // packages/server-daemon expects for app-policy updates — a
        // signed canonical-bytes wrapper. For now, mock client accepts
        // any envelope and returns ok=true.
        let payload: [String: Any] = [
            "kind": "app-policy/v1",
            "appId": appId,
            "runOnPodIds": Array(runOnPodIds),
            "leadPodId": leadPodId as Any,
            "customUrls": customUrls
        ]
        let json = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        let envelope = json.base64EncodedString()
        _ = try await client.ordersSend(.init(envelope: envelope, kind: "app-policy/v1"))
    }
}

