#if DEBUG
import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

extension GymSweepSeams {
    /// The passphrase the `-smoke-recovery-*` records were made with.
    public static let gymRecoveryPassphrase = "maple syrup forest"

    /// Browser requests `-smoke-browser-grant` seeds: plants asks once for two sites; wiki asks for this
    /// session on one device of the local network; scratchpad asks to keep a site until removed.
    public static let browserOnce = BrowserGrantRequest(
        requestId: "11111111-1111-4111-8111-111111111111", serviceId: "bright-maple--plants",
        capabilities: ["navigate", "read-dom"], origins: ["*.example.org", "news.example.com"],
        duration: "once", explanation: "Read today's prices", at: 1)
    public static let browserSession = BrowserGrantRequest(
        requestId: "22222222-2222-4222-8222-222222222222", serviceId: "bright-maple--wiki",
        capabilities: ["navigate", "screenshot"], origins: [], localNetwork: .exact(["192.168.1.20"]),
        duration: "session", at: 2)
    public static let browserService = BrowserGrantRequest(
        requestId: "33333333-3333-4333-8333-333333333333", serviceId: "bright-maple--plants",
        capabilities: ["download", "navigate"], origins: ["files.example.net"], duration: "service", at: 3)

    /// What `-smoke-browser-grant-granted` says the owner allowed plants beyond its manifest.
    public static let browserGranted = OwnerBrowserGrant(
        grantId: "bg-44444444-4444-4444-8444-444444444444", serviceId: "bright-maple--plants",
        capabilities: ["navigate", "read-dom"], origins: ["prices.example.net"], duration: "service",
        explanation: "Compare prices", issuedAt: 4)

    /// The proposal `-smoke-upstream-sync` makes the box answer for plants.
    public static let syncProposal = AppSyncResponse(
        buildId: "gym-sync-build",
        proposal: SyncProposal(
            upstreamChanged: ["src/app.js", "src/db.js", "README.md", "flagship.app.json"],
            localChanged: ["src/app.js", "public/style.css"],
            takeUpstream: ["src/db.js", "README.md", "flagship.app.json"],
            conflicts: ["src/app.js"],
            alreadyApplied: ["package.json"],
            capabilityChanges: [SyncCapabilityChange(section: "network.egress", added: ["api.weather.example"], removed: [])],
            clean: false),
        candidateCommit: "abcdef0123456789abcdef0123456789abcdef01",
        upToDate: false)

    /// SEC-REPAIR-001 (recovery passkey), SEC-BROWSER-002 (browser grants) and N12 (upstream sync).
    static func release03(_ args: [String], _ app: AppState, _ mocks: GymMocks) {
        let user = app.currentUser ?? "bright-maple"
        // Every launch starts as if the update was never offered, unless the test says it was.
        RecoveryUpdatePrompt.store.removeObject(forKey: "flagship.recoveryUpdateAsked.\(user.lowercased())")
        if args.contains("-smoke-recovery-asked") { RecoveryUpdatePrompt.markAsked(username: user) }
        if args.contains("-smoke-recovery-legacy"), let server = mocks.server {
            server.seedRecoveryRecord(username: user, credentialId: "aabbccdd00112233",
                                      wrappedUmk: Data(repeating: 7, count: 60).base64EncodedString(),
                                      fetchTokenHash: String(repeating: "0", count: 64),
                                      prfSaltHash: String(repeating: "0", count: 64), passkey: false)
        }
        if args.contains("-smoke-browser-grant") {
            mocks.screens.mockBrowserGrantRequests = [browserOnce, browserSession]
        }
        // Narrowing: a session ask, answered "Allow once".
        if args.contains("-smoke-browser-grant-narrow") {
            mocks.screens.mockBrowserGrantRequests = [browserSession]
        }
        // A grant the owner gave plants beyond its manifest, listed under "Allowed by you" with Withdraw.
        if args.contains("-smoke-browser-grant-granted") {
            mocks.screens.mockBrowserGrants = [browserGranted]
            mocks.screens.mockBrowserDomains["bright-maple--plants"] = ["shop.example.com"]
        }
        // An app that names no browser sites of its own and asks once: answering it and then withdrawing
        // the grant each take the section's last card away.
        if args.contains("-smoke-browser-grant-alone") {
            mocks.screens.mockBrowserGrantRequests = [browserOnce]
        }
        if args.contains("-smoke-browser-grant-app") {
            mocks.screens.mockBrowserGrantRequests = [browserService]
            mocks.screens.mockBrowserDomains["bright-maple--plants"] = ["shop.example.com"]
        }
        if args.contains("-smoke-upstream-sync") {
            mocks.screens.mockImportedFrom["bright-maple--plants"] = "github.com/ana/plants"
            mocks.screens.mockSyncResponses["bright-maple--plants"] = syncProposal
        }
        // docs/support/update-rollback.md §5: a failed update the floor kept in recovery, and the
        // "Share update results" switch (off until the owner turns it on).
        if args.contains("-smoke-update-kept-in-recovery") {
            mocks.screens.lastUpdateFixture = LastUpdate(
                outcome: "rolled-back", at: Int64(Date().timeIntervalSince1970 * 1000) - 60_000,
                targetCommit: "9f2c1ab3de4567890abcdef1234567890abcdef1",
                previousCommit: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
                bootAttempts: 3, rollbackRefused: true)
            mocks.screens.mockUpdateReportsShare = false
        }
        if args.contains("-smoke-update-refused-stale") {
            mocks.screens.lastUpdateFixture = LastUpdate(
                outcome: "refused", at: Int64(Date().timeIntervalSince1970 * 1000) - 60_000, reason: "stale")
            mocks.screens.mockUpdateReportsShare = nil
        }
        if args.contains("-smoke-upstream-sync-current") {
            mocks.screens.mockImportedFrom["bright-maple--plants"] = "github.com/ana/plants"
            // Up to date: the box opens no build (no buildId, no proposal), so nothing is discarded.
            mocks.screens.mockSyncResponses["bright-maple--plants"] = AppSyncResponse(
                buildId: nil, proposal: nil, candidateCommit: "1111111111111111111111111111111111111111",
                upToDate: true)
        }
    }

    /// `-smoke-onboarding` + `-smoke-recovery-passkey`: sole-maple's record holds its passkey key, made
    /// with `gymRecoveryPassphrase`, so restoring signs `.com`'s challenge. `-smoke-recovery-passkey-refused`:
    /// `.com` refuses that signature.
    static func onboardingRecoveryPasskey(_ args: [String], _ mocks: GymMocks) {
        guard args.contains("-smoke-recovery-passkey"), let server = mocks.server else { return }
        let user = gymRecoverableAccount
        let passphrase = gymRecoveryPassphrase
        if args.contains("-smoke-recovery-passkey-refused") { server.recoveryPasskeyRefusalCode = "passkey-invalid" }
        Task.detached {
            guard let secrets = try? RecoveryDerivation.derivePassphraseSecrets(passphrase, user),
                  let prf = try? await MockWebAuthnProvider().prfAssert(credentialId: "aabbccdd00112233", prfSalt: secrets.prfSalt),
                  let wrapped = try? Recovery.wrap(umkSeed: SymmetricKey(size: .bits256), prfSecret: prf) else { return }
            await MainActor.run {
                server.seedRecoveryRecord(username: user, credentialId: "aabbccdd00112233", wrappedUmk: wrapped,
                                          fetchTokenHash: RecoveryDerivation.sha256Hex(secrets.fetchToken),
                                          prfSaltHash: RecoveryDerivation.sha256Hex(secrets.prfSalt), passkey: true)
            }
        }
    }
}
#endif
