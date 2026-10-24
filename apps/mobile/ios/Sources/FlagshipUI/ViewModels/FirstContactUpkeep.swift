import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// App-side upkeep of the app-name certificate grant (docs/first-contact.md "App-name certificate
/// grant"). The grant signed at a first blessing is handed to the box once it answers; an admin device
/// that finds a pinned server without one signs it silently while the session is unlocked. Where the
/// sensitive-order key is the admin root (every real account), it only opens inside a Face ID moment,
/// so the grant is marked owed and signed at the next Face ID the owner does anyway
/// (`Keystore.onAdminRootOpened`).
@MainActor
public enum FirstContactUpkeep {
    private static var clients: PodScreensClientFactory?

    /// Wire delivery and the admin-root hook once, at launch.
    public static func install(clients: PodScreensClientFactory) {
        self.clients = clients
        ServerWildcardGrantKeeper.shared.deliver = { domain, signed in
            let client = await clients.client(forFqdn: domain)
            do {
                try await client.deliverServerWildcardGrant(issuedAt: signed.issuedAt, signatureHex: signed.signatureHex)
                return true
            } catch {
                return false
            }
        }
        Keystore.onAdminRootOpened = { key in
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let pins = ServerKeyPins()
            let signed = ServerWildcardGrantKeeper.shared.signOwed(key: key, pins: pins, now: now)
            guard !signed.isEmpty else { return }
            Task {
                for domain in signed { await ServerWildcardGrantKeeper.shared.deliverKept(domain, pins: pins) }
            }
        }
    }

    /// One pass over the account's servers that are up. Only a device that may sign sensitive orders
    /// runs it: an admin device (admin root), or any device of a demo account (the IRK).
    public static func run(app: AppState) async {
        guard let clients, let username = app.currentUser, !username.isEmpty else { return }
        let isAdmin = Keystore.hasAdminRoot
        guard isAdmin || app.isDemoAccount else { return }
        let pins = ServerKeyPins()
        for pod in app.pods where pod.status == .online && !pod.isRevoked && !pod.fqdn.isEmpty {
            let domain = pod.fqdn
            guard pins.pinnedStk(domain) != nil else { continue }
            let client = await clients.client(forFqdn: domain)
            _ = await ServerWildcardGrantUpkeep.run(
                username: username,
                serverDomain: domain,
                keeper: .shared,
                pins: pins,
                status: { try? await client.serverWildcardGrantStatus() },
                // The admin root never opens silently; the IRK does while the session holds the UMK.
                silentKey: { isAdmin ? nil : Keystore.sessionIRKIfCached() },
                now: Int64(Date().timeIntervalSince1970 * 1000)
            )
        }
    }
}
