import Foundation
import Flagship
import FlagshipAPI
import FlagshipCore

/// Strict by default (docs/architecture-v2/pq-suites.md §21): after each unlock's binding pass, an
/// admin device moves every server no owner has changed to strict, with the browser and AI
/// exceptions, from keys the unlocked session holds. It never prompts; what it cannot do yet
/// (a device without its record, recovery not set up) Settings, Quantum-safe protection explains.
@MainActor
public enum DefaultStrictSweep {
    private static var app: AppState?
    private static var mailbox: (any SecretMailboxClient)?
    private static var clients: PodScreensClientFactory?
    private static var running = false

    public static func install(app: AppState, mailbox: any SecretMailboxClient, clients: PodScreensClientFactory?) {
        self.app = app
        self.mailbox = mailbox
        self.clients = clients
        PqIdentityBindingService.setAfterUpgrade { username in await DefaultStrictSweep.run(username: username) }
    }

    public static func run(username: String) async {
        guard !running, let app, app.currentUser?.lowercased() == username.lowercased(), !app.isDemoAccount, Keystore.hasAdminRoot else { return }
        running = true
        defer { running = false }
        await QuantumSafetyViewModel(app: app, clients: clients).applyDefaults(mailbox: mailbox)
    }
}
