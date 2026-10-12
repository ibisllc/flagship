import SwiftUI
import FlagshipAPI

/// Builds a screens client bound to ONE of the account's servers: that box's
/// base URL and this device's own session token for it. Used wherever a
/// screen must talk to a box other than the shell's current one: the creation
/// flow's chosen server, a server page's apps, and an app page asking every
/// server whether it has the app (docs/app-placement.md).
public struct PodScreensClientFactory: Sendable {
    private let build: @Sendable (_ fqdn: String) async -> any ScreensClient

    public init(_ build: @escaping @Sendable (_ fqdn: String) async -> any ScreensClient) {
        self.build = build
    }

    public func client(forFqdn fqdn: String) async -> any ScreensClient {
        await build(fqdn.lowercased())
    }

    /// Every server answered by the same client (demo/mock mode, previews).
    public static func shared(_ client: any ScreensClient) -> PodScreensClientFactory {
        PodScreensClientFactory { _ in client }
    }

    /// A `LiveScreensClient` over `urlSession` (the box-pinned one) with the
    /// box's own token from `store`. No token: calls fail `noSessionToken`.
    public static func live(urlSession: URLSession, store: any SessionStoring) -> PodScreensClientFactory {
        PodScreensClientFactory { fqdn in
            let token = await store.sessionToken(forPodId: PodInfo.podId(forFqdn: fqdn))
            return LiveScreensClient(
                urlSession: urlSession,
                store: PodScopedSessionStore(baseUrl: CompanionTicketURL.podBaseUrl(forFqdn: fqdn),
                                             token: (token?.isEmpty ?? true) ? nil : token))
        }
    }
}

private struct PodScreensClientsKey: EnvironmentKey {
    static let defaultValue = PodScreensClientFactory.shared(MockScreensClient())
}

/// The box (FQDN) the surrounding screens' `screensClient` is bound to, when a
/// navigation stack has bound it to a particular server. Nil: the shell's
/// current server.
private struct ScreensServerFqdnKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

public extension EnvironmentValues {
    var podScreensClients: PodScreensClientFactory {
        get { self[PodScreensClientsKey.self] }
        set { self[PodScreensClientsKey.self] = newValue }
    }

    var screensServerFqdn: String? {
        get { self[ScreensServerFqdnKey.self] }
        set { self[ScreensServerFqdnKey.self] = newValue }
    }
}

public extension AppState {
    /// The box a screen's signed orders and address previews name: the
    /// stack's bound server when there is one, else the shell's live server.
    func screensFqdn(bound: String?) -> String {
        if let bound, !bound.isEmpty { return bound }
        return sessionPod?.fqdn ?? currentPod?.fqdn ?? leaderPod?.fqdn ?? pods.first?.fqdn ?? "unknown"
    }

    /// The account's servers an app can run on: registered, not revoked.
    var placementPods: [PodInfo] {
        pods.filter { $0.status != .pending && !$0.isRevoked && !$0.fqdn.isEmpty }
    }
}
