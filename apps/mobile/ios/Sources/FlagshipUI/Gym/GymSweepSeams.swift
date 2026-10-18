#if DEBUG
import Foundation
import FlagshipAPI
import FlagshipCore

/// Gym-only: the mock clients a `-smoke-mode` launch serves every screen
/// from, handed to the sweep seams so a scenario can seed the state it needs
/// (`-smoke-<seam>` launch arguments). Production never builds one.
public struct GymMocks {
    public let screens: MockScreensClient
    public let server: MockFlagshipServerClient?
    public let mailbox: MockSecretMailboxClient
    public let lockPower: MockLockPowerClient
    public let frontPage: MockFrontPageClient
    public let uninstall: MockServiceUninstallClient
    public let access: MockServiceAccessClient
    public let transfer: MockServerTransferClient
    public let migration: MockServerMigrationClient
    public let relay: MockQrRelayClient
    /// The device-pairing relay (Join an account by pairing).
    public var pairingRelay: MockPairingRelayClient?

    public init(screens: MockScreensClient, server: MockFlagshipServerClient?, mailbox: MockSecretMailboxClient,
                lockPower: MockLockPowerClient, frontPage: MockFrontPageClient, uninstall: MockServiceUninstallClient,
                access: MockServiceAccessClient, transfer: MockServerTransferClient,
                migration: MockServerMigrationClient, relay: MockQrRelayClient) {
        self.screens = screens
        self.server = server
        self.mailbox = mailbox
        self.lockPower = lockPower
        self.frontPage = frontPage
        self.uninstall = uninstall
        self.access = access
        self.transfer = transfer
        self.migration = migration
        self.relay = relay
    }
}

/// Gym-only launch seams for the button sweep (GymSweep*Tests). Each area
/// keeps its seams in its own file; the smoke-mode launch calls `apply` once
/// after DemoFixtures has seeded the account.
@MainActor
public enum GymSweepSeams {
    public static func apply(args: [String], app: AppState, operations: ActiveOperationsCenter, mocks: GymMocks) {
        resetAiKeys()
        // `-smoke-lock-after-s N [-smoke-unlock-after-s M]`: lock the app N seconds
        // after launch (the lock is otherwise only reachable from Settings, which
        // can't be tapped while a menu is open) and optionally unlock M seconds later.
        if let lockAfter = value(args, "-smoke-lock-after-s").flatMap(Double.init) {
            let unlockAfter = value(args, "-smoke-unlock-after-s").flatMap(Double.init)
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(lockAfter))
                app.lock()
                if let unlockAfter {
                    try? await Task.sleep(for: .seconds(unlockAfter))
                    app.markUnlocked()
                }
            }
        }
        // The phone's saved backup copies: every launch starts with none.
        UserDefaults.standard.removeObject(forKey: "flagship.phoneBackup.servers")
        try? FileManager.default.removeItem(at: PhoneBackupStore.shared.root)
        // The create form's draft (including the backup pick) lives in
        // UserDefaults: every launch starts with nothing chosen.
        CreateServerDraftStore().reset()
        if let server = mocks.server {
            let mailbox = mocks.mailbox
            server.onServerNameReleased = { [weak mailbox] domain in mailbox?.deletedDomains.insert(domain.lowercased()) }
        }
        home(args, app, operations, mocks)
        server(args, app, mocks)
        apps(args, app, mocks)
        settings(args, app, mocks)
        build(args, app, operations, mocks)
        share(args, app, mocks)
        onboarding(args, app, mocks)
    }

    /// The value after `flag` in the launch arguments, if any.
    static func value(_ args: [String], _ flag: String) -> String? {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count, !args[i + 1].hasPrefix("-smoke-") else { return nil }
        return args[i + 1]
    }
}
#endif
