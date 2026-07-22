import Foundation
import FlagshipAPI

/// Pairs a passwordless demo profile through the Worker's narrow demo signer.
/// Demo identities deliberately have no device-held IRK, so the normal
/// owner-signing path cannot work for them.
public enum DemoSessionPairer {
    @discardableResult
    public static func ensurePaired(
        username: String,
        server: DemoServerBlock,
        client: any FlagshipServerClient,
        store: any SessionStoring,
        replacingExistingToken: Bool = false,
        makeToken: () -> String = { AddPairedSessionOrder.freshToken() }
    ) async throws -> String {
        let podId = PodInfo.podId(forFqdn: server.fqdn)
        if !replacingExistingToken,
           let existing = await store.sessionToken(forPodId: podId), !existing.isEmpty {
            await store.activatePod(podId, baseUrl: "https://\(server.fqdn)")
            await store.setDemoSession(DemoSessionRecord(username: username, server: server))
            return existing
        }

        let token = makeToken().lowercased()
        let response = try await client.pairDemoSession(username: username, token: token)
        guard response.ok, response.fqdn.lowercased() == server.fqdn.lowercased() else {
            throw ScreensClientError.decoding("demo pairing returned a different server")
        }

        await store.setSessionToken(token, forPodId: podId)
        await store.activatePod(podId, baseUrl: "https://\(server.fqdn)")
        await store.setDemoSession(DemoSessionRecord(username: username, server: server))
        return token
    }
}
