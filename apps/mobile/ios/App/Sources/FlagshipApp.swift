import SwiftUI
import CryptoKit
import UIKit
import Flagship
import FlagshipCore
import FlagshipAPI
import FlagshipUI

@main
struct FlagshipApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var appState: AppState
    @State private var linker = DeepLinker()
    @State private var toasts = ToastCenter()
    @State private var operations = ActiveOperationsCenter()
    @State private var trust: TrustCenter
    @State private var privacy = PrivacySettings()
    @State private var pushRegistrar: PushRegistrar?
    @State private var persistedIdentityRestoreStarted = false
    @State private var orphanedPersistedUsername: String?
    #if DEBUG
    private let mockClient = MockScreensClient()
    #endif
    private let liveClient: any ScreensClient
    private let livePodClients: PodScreensClientFactory
    // The session store backing the live screens client. Owned here so
    // the shell can repoint `podBaseUrl` at the currently selected online
    // server (see PodSessionSync). The same instance is injected into the
    // environment so views drive it without reaching into the client.
    private let sessionStore: any SessionStoring

    init() {
        // The gym's launch seams (Debug builds only), FIRST: the live clients
        // below capture their base URL at init, so `-apex-host` must retarget
        // `Endpoints` before any of them is built.
        #if DEBUG
        GymLaunch.applyApexHostArg()
        Self.applySmokeOnboardingIfRequested()
        #endif
        let state = AppState()
        _appState = State(initialValue: state)
        // `.com` serves the account's servers, devices and app names only
        // with a read token (docs/account-read-token.md), minted from keys
        // already at hand and never with a prompt.
        let readTokens = AccountReadTokenProvider(
            minter: LiveAccountReadTokenMinter(),
            store: KeychainAccountReadTokenStore(),
            credentials: { username in
                let (user, deviceId) = await MainActor.run {
                    (state.currentUser?.lowercased(), state.activeProfile?.deviceId ?? "")
                }
                guard user == username else { return [] }
                return AccountReadCredentials.keystore.credentials(username: username, deviceId: deviceId)
            },
            isKeyless: { _ in await MainActor.run { state.isDemoAccount } },
            onPausedChanged: { paused in
                Task { @MainActor in state.accountStatusPaused = paused }
            }
        )
        self.readTokens = readTokens
        // Every LIVE /pods response feeds the cert-pin registry (verify the
        // STK-signed daemon-status per pod → install/clear that box's
        // fingerprint pin). Live-only by construction: the Mock never invokes
        // onPods, so demo/mock sessions can never install pins.
        self.liveMailbox = LiveSecretMailboxClient(
            readTokens: readTokens,
            onPods: { response in
                CertPinRegistry.shared.update(pods: response.pods)
                LanDirectRegistry.shared.refreshActive()
            }
        )
        // Keychain-backed token persistence: pod base URL stays in
        // UserDefaults (non-secret), the 32-byte session token lives
        // in Keychain with WhenUnlockedThisDeviceOnly access.
        let store = KeychainSessionStore()
        self.sessionStore = store
        // The screens client dials the BOX (`<server>.<user>.flagship.
        // services` + service names under it), so it rides the pinned
        // session: server-trust challenges run default validation first,
        // then HARD-FAIL unless the served leaf matches the box's
        // STK-signed fingerprint when a verified pin exists (A′ phase 4).
        // SSE + the browser-stream WebSocket share the same session, so
        // they're covered too. No pin ⇒ default validation stands.
        let pinnedSession = BoxPinnedURLSession.make(
            pinFor: { CertPinRegistry.shared.pinFor(host: $0) }
        )
        let lanClient = LiveScreensClient(
            urlSession: pinnedSession,
            store: store
        )
        self.liveClient = lanClient
        // LAN-direct (docs/lan-direct.md): verify the active box's signed LAN
        // hint against its pin + cached STK and route to it when proven.
        LanDirectRegistry.shared.configure(
            pinFor: { CertPinRegistry.shared.pinFor(host: $0) },
            stkPubFor: { CertPinRegistry.shared.stkPub(forDomain: $0) },
            activeBox: { await store.podBaseUrl.flatMap { URL(string: $0)?.host } },
            fetchHint: { try? await lanClient.lanHint() }
        )
        self.livePodClients = .live(urlSession: pinnedSession, store: store)
        // The lock/power-off + dead-man routes are signature-authed daemon
        // endpoints on the SAME box; share the box-pinned session so a rogue
        // `.com` cert can't intercept a power-off / affirmation either.
        self.liveLockPower = LiveLockPowerClient(urlSession: pinnedSession)
        self.liveFrontPage = LiveFrontPageClient(urlSession: pinnedSession)
        // Box-direct leadership read (`GET /api/leads`) rides the SAME box-pinned
        // session so a rogue `.com` cert can't feed a forged direct view.
        self.liveLeads = LiveLeadsClient(urlSession: pinnedSession)
        // Owner-signed service uninstall (`DELETE /api/services/:id`) rides the
        // SAME box-pinned session so a rogue `.com` cert can't intercept it.
        self.liveServiceUninstall = LiveServiceUninstallClient(urlSession: pinnedSession)
        // Box calls (set-mode/redeem) over the box-pinned session; `.com` calls
        // (create/list/revoke) over the default public-CA session.
        self.liveServiceAccess = LiveServiceAccessClient(boxSession: pinnedSession)
        // Maintainer-trust short-circuit: the live `.com` client refuses to
        // send when the control server is positively untrusted (and the owner
        // hasn't overridden). `.unknown`/`.trusted` + any network-error
        // "no verdict" all let traffic through — we never brick on the absence
        // of a verdict, only on a valid blessing that fails verification.
        // Seeded locally rather than read back through `_trust.wrappedValue`:
        // Swift 6.3 treats that read as a use of `self` before every stored
        // property is initialized.
        let trustCenter = TrustCenter()
        _trust = State(initialValue: trustCenter)
        self.liveServerClient = LiveFlagshipServerClient(
            trustGate: { @Sendable in await MainActor.run { trustCenter.isServerTrusted } },
            readTokens: readTokens
        )
        Self.wireInstallProgressBridge(app: state)
        Self.wireProvisionPhaseBridge()
        // AppState's profile-switch hook bridges into the iOS-only
        // Keystore so UMK/IRK derivation tracks the active cloud. The
        // hook is unset on watchOS (which doesn't link the iOS-only
        // Flagship target / has no keystore).
        appState.onActiveProfileChanged = { cloudName in
            Keystore.setActiveProfile(cloudName)
        }
        appState.onSignedOut = {
            Task {
                await store.setDemoSession(nil)
                await readTokens.clearAll()
            }
        }
        // The first unwrap of the UMK in a session keeps this device's
        // account key at hand, so read tokens mint without it from then on
        // (the app lock is optional, docs/account-read-token.md).
        Keystore.setSessionUmkObserver { umk in
            Task { @MainActor in
                guard !state.isDemoAccount, let user = state.currentUser,
                      let deviceId = state.activeProfile?.deviceId else { return }
                AccountReadCredentials.keystore.keepDeviceKey(umk: umk, username: user, deviceId: deviceId)
            }
        }
        appState.retryAccountRead = {
            guard let user = await MainActor.run(body: { state.currentUser }) else { return }
            await readTokens.retryNow(for: user)
        }
    }

    #if DEBUG
    /// The mock gym's entry point (Debug builds only): launched with
    /// `-smoke-mode YES` the app skips onboarding and lands directly on the
    /// paired shell with DemoFixtures sample pods. ContentView pairs this
    /// with `-smoke-tab` to pre-route the shell to a tab.
    @MainActor
    private static func applySmokeModeIfRequested(
        _ app: AppState,
        linker: DeepLinker,
        operations: ActiveOperationsCenter,
        trust: TrustCenter,
        privacy: PrivacySettings,
        screens: MockScreensClient,
        mocks: GymMocks
    ) {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("-smoke-mode") else { return }
        // Determinism: a simulator can carry a persisted `requireBiometricAtLaunch`
        // from prior manual use, which would drop the gym into the biometric lock
        // screen on launch (and the Simulator has no enrolled biometric to clear
        // it). Force the launch-lock OFF + the unlock latch ON for the gym so the
        // shell is reachable on ANY simulator — UNLESS `-smoke-locked` is passed,
        // which deliberately lands on the lock screen to test the trap (D4-E1).
        // Gym-only; production never passes `-smoke-mode`.
        let wantLocked = args.contains("-smoke-locked")
        privacy.requireBiometricAtLaunch = wantLocked
        app.requireBiometricAtLaunch = wantLocked
        app.isUnlocked = !wantLocked
        // `-smoke-no-recovery` seeds an account with NO cloud recovery so the
        // session-tiers grey-out + recovery-required toast (D3-C1) is exercisable.
        // A demo session is normally recovery-exempt, so we also force the
        // SignOutPolicy block (the override is gym-only — see SignOutPolicy).
        if args.contains("-smoke-no-recovery") {
            app.hasCloudRecovery = false
            SignOutPolicy.gymForceBlockNoRecovery = true
        } else {
            // Default the override off so a same-process re-evaluation can't leak
            // a prior launch's block into a non-flagged run.
            SignOutPolicy.gymForceBlockNoRecovery = false
            // `-smoke-recovery-enrolled` seeds an account that already has cloud
            // recovery (no setup nudge) — the App Store showcase capture.
            if args.contains("-smoke-recovery-enrolled") {
                app.hasCloudRecovery = true
            }
        }
        // `-smoke-username <name>` overrides the seeded handle (App Store
        // screenshot captures); gym runs keep the default.
        var user = "smoketest"
        if let i = args.firstIndex(of: "-smoke-username"), i + 1 < args.count, !args[i + 1].hasPrefix("-") {
            user = args[i + 1]
        }
        if !app.isPaired {
            // The total-gym D5 seed variants pick a different fixture pod set so
            // a server-event state (awaiting-unlock / dead) renders
            // deterministically with no backend. Mutually exclusive; default =
            // the three legacy sample pods. Gym-only.
            if args.contains("-smoke-awaiting-unlock") {
                DemoFixtures.activate(
                    app,
                    username: user,
                    pods: DemoFixtures.samplePodsWithAwaitingUnlock(username: user)
                )
            } else if args.contains("-smoke-revoked") {
                DemoFixtures.activate(
                    app,
                    username: user,
                    pods: DemoFixtures.samplePodsWithRevokedServer(username: user)
                )
            } else if args.contains("-smoke-dead") {
                DemoFixtures.activate(
                    app,
                    username: user,
                    pods: DemoFixtures.samplePodsWithDeadServer(username: user)
                )
            } else {
                DemoFixtures.activate(app, username: user)
            }
        }
        // A box that isn't online doesn't answer: the mock fails its server
        // detail, as a real one would.
        screens.unreachablePodIds = Set(app.pods.filter { $0.status != .online }.map(\.podId))
        // `-smoke-ops` seeds ONE in-flight build so the global operations
        // sliver (`global-operations-bar`) renders deterministically for the
        // gym's sliver scenario. The default DemoFixtures pods are all
        // online/offline (no pending), so without this the sliver — correctly
        // — stays hidden. Gym-only; production never passes the arg.
        // `-smoke-ops-on-server` names the last server instead, as an
        // AI-needs-you alert does, so the chat opens bound to that server.
        if args.contains("-smoke-ops") {
            let server = args.contains("-smoke-ops-on-server") ? app.pods.last?.fqdn : nil
            operations.upsertBuild(
                id: "build:gym-smoke",
                subject: "blog",
                onServer: "Home",
                target: server.map { .vibeCodeChatOnServer(sessionId: "gym-smoke", serverFqdn: $0) }
                    ?? .vibeCodeChat(sessionId: "gym-smoke")
            )
        }
        // `-smoke-awaiting-backup` marks the first online server as created to
        // restore a backup and still waiting for it (Home's "Waiting for its
        // backup" + Send the backup). Gym-only.
        if args.contains("-smoke-awaiting-backup"), let pod = app.pods.first(where: { $0.status == .online }) {
            app.podsAwaitingBackup[pod.fqdn.lowercased()] = AwaitingBackupWire(archiveId: String(repeating: "ab", count: 16), state: "waiting")
        }
        // `-smoke-admin-root` treats this device as holding the admin master
        // root (GymSeams.forceAdminRoot) so the Slice-D admin-gated surfaces
        // (Account-security Rotate-admin card; the add-device promote toggle)
        // render offline. Assigned BOTH ways so a prior same-process launch's
        // seed can never leak into an unflagged run. Gym-only.
        GymSeams.forceAdminRoot = args.contains("-smoke-admin-root")
        // Smoke launches bypass the UI-level Face-ID consent prompts (no
        // enrolled biometric on a Simulator) — consent-only, no crypto
        // emitted; see GymSeams. EXCEPT under -smoke-locked: the launch lock
        // screen AUTO-prompts, and a bypassed prompt would auto-unlock the
        // very trap that scenario asserts (D4-E1).
        GymSeams.bypassBiometricGates = !wantLocked
        GymSeams.accountRootSeed = Data(repeating: 0x47, count: 32)
        // The smoke account is admin-pinned like every account opened today:
        // the mock `.com` and boxes verify sensitive orders under its admin
        // root (refusing the IRK), and `-smoke-admin-root` makes this device
        // hold that root. Without it the device is a non-admin one.
        GymSeams.adminRootSeed = GymSeams.forceAdminRoot ? GymSeams.gymAdminRootSeed : nil
        GymOrderCanonical.install()
        MockOrderSigners.shared.pin(
            adminRoot: (try? Curve25519.Signing.PrivateKey(rawRepresentation: GymSeams.gymAdminRootSeed))?.publicKey,
            irk: Keystore.gymIRK()?.publicKey
        )
        GymSeams.suppressAccessAlerts = !args.contains("-smoke-access-alert")
        if !GymSeams.suppressAccessAlerts {
            // "Not now" persists for a day; a prior run's answer must not hide the sheet.
            UserDefaults.standard.removeObject(forKey: "flagship.appAccess.notNowUntil")
        }
        // `-smoke-trust-untrusted` seeds a positively-untrusted maintainer-trust
        // verdict so the red GlobalTrustBar (`global-trust-bar`) renders (D4-E7).
        // The live path derives this from a real `.com` blessing check
        // (ContentView.runTrustCheck, live-client only); the gym injects a fixed
        // failure so the degraded-trust experience is exercisable offline.
        GymSweepSeams.apply(args: args, app: app, operations: operations, mocks: mocks)
        if args.contains("-smoke-trust-untrusted") {
            trust.markUntrusted([
                TrustFailure(
                    certClass: .control,
                    // A fixed, obviously-fake 64-hex cert-hash slug; never a real cert.
                    certHash: String(repeating: "ab", count: 32),
                    caPubkey: String(repeating: "cd", count: 32)
                )
            ])
        }
    }

    /// Gym-only (`-smoke-onboarding`): start unpaired with nothing left from a
    /// previous run (the onboarding walk creates real keys on the simulator,
    /// and a leftover account would be restored instead of showing Welcome),
    /// against the mock clients (GymLaunch), with the UI-level Face ID
    /// prompts passed as in `-smoke-mode`.
    private static func applySmokeOnboardingIfRequested() {
        guard ProcessInfo.processInfo.arguments.contains("-smoke-onboarding") else { return }
        Keystore.wipeAllProfiles()
        GymSeams.bypassBiometricGates = true
        GymSeams.suppressAccessAlerts = true
    }
    #endif


    /// Wire the FlagshipUI InstallProgressBridge to the App-target
    /// Live Activity. The bridge is set up once at @main init so every
    /// checkpoint (the pending-pod watcher's and install screens' polls, or
    /// a push) drives the Dynamic Island / Lock Screen + the Watch without
    /// each call site importing ActivityKit. The bridge starts one activity
    /// per install on its first checkpoint and ends it on live / error.
    @MainActor
    private static func wireInstallProgressBridge(app: AppState) {
        let b = InstallProgressBridge.shared
        b.onStart = { serial, podName in
            InstallProgressLiveActivityCenter.shared.start(
                serial: serial,
                podName: podName ?? "New server"
            )
        }
        b.onStep = { serial, phase in
            Task { await InstallProgressLiveActivityCenter.shared.advance(serial: serial, to: bridge(phase)) }
        }
        b.onComplete = { serial, fqdn in
            Task { await InstallProgressLiveActivityCenter.shared.complete(serial: serial, serverFqdn: fqdn) }
        }
        b.onFailed = { serial, reason in
            Task { await InstallProgressLiveActivityCenter.shared.fail(serial: serial, reason: reason) }
        }
        // A push never names the server: the pending pod holding the
        // serial (or address) does.
        b.nameForKey = { key in
            app.pods.first(where: { $0.pendingAuthCodeSerial == key || (!$0.fqdn.isEmpty && $0.fqdn == key) })?.name
        }
        // Rich poll-driven path: forward the full canonical status onto
        // the Watch timeline (history + serverDomain). Sparse push-driven
        // updates go through wireProvisionPhaseBridge below.
        b.onStatus = { status, podName in
            WatchTimelinePublisher.shared.update(from: status, podName: podName)
        }
    }

    /// Wire FlagshipCore's ProvisionPhaseBridge (fed by `provision-status`
    /// pushes from .com) into the SAME InstallProgressBridge the polls
    /// report to. This turns a phase push into a Live Activity
    /// transition — provisioning becomes a glass box even when the app is
    /// backgrounded and the user never opened the progress screen. The
    /// phase is the single canonical `ProvisionStatusPhase`.
    @MainActor
    private static func wireProvisionPhaseBridge() {
        ProvisionPhaseBridge.shared.onPhase = { event in
            // serverDomain isn't carried on the push meta; the poll path
            // fills in the FQDN.
            let progress = InstallProgressBridge.shared
            progress.report(
                key: event.serial.isEmpty ? "provision" : event.serial,
                phase: event.phase,
                detail: event.detail
            )
            // Mirror the phase onto the watch's install-progress surface
            // (W1) keyed by the order serial — same install yields the
            // same serial across every phase push, so history accumulates
            // correctly on the watch.
            WatchTimelinePublisher.shared.update(
                phase: event.phase,
                serial: event.serial,
                detail: event.detail,
                podName: progress.nameForKey?(event.serial) ?? "Provisioning"
            )
        }
    }

    /// One-to-one translation from the canonical `ProvisionStatusPhase`
    /// to the widget-extension's ActivityAttributes.Step (the
    /// widget-local twin of the same vocabulary). They're separate types
    /// only because the widget extension can't link FlagshipAPI; the raw
    /// strings are identical so this is a total, lossless mapping.
    @MainActor
    private static func bridge(_ phase: ProvisionStatusPhase) -> InstallProgressAttributes.Step {
        switch phase {
        case .booting:      return .booting
        case .downloading:  return .downloading
        case .partitioning: return .partitioning
        case .installing:   return .installing
        case .installed:    return .installed
        case .registering:  return .registering
        case .sealing:      return .sealing
        case .pairing:      return .pairing
        case .live:         return .live
        case .error:        return .error
        // Forward-compat sentinel for an unrecognised wire phase — keep
        // the Live Activity showing "booting" rather than crashing.
        case .unknown:      return .booting
        }
    }
    private let liveServerClient: any FlagshipServerClient
    private let liveRelay: any QrRelayClient = LiveQrRelayClient()
    private let liveLockPower: any LockPowerClient
    private let liveFrontPage: any FrontPageClient
    private let liveLeads: any LeadsClient
    private let liveServiceUninstall: any ServiceUninstallClient
    private let liveServerTransfer: any ServerTransferClient = LiveServerTransferClient()
    private let liveServerMigration: any ServerMigrationClient = LiveServerMigrationClient()
    private let liveServiceAccess: any ServiceAccessClient
    private let liveMailbox: any SecretMailboxClient
    private let readTokens: AccountReadTokenProvider
    // Cross-device pairing relay (Add a device / Join an account). Its
    // network transport over /qr-pipe is a follow-up, so Release builds
    // refuse with a sentence; Debug builds keep the in-process relay the
    // gym and unit tests pair through.
    #if DEBUG
    private let pairingRelay: any PairingRelayClient = MockPairingRelayClient()
    #else
    private let pairingRelay: any PairingRelayClient = UnavailablePairingRelayClient()
    #endif
    #if DEBUG
    // The mock gym's clients (Debug builds only): every one stands in for
    // its live twin when GymLaunch.usesMocks.
    // Seed the mock with one demo user so "Connect to an existing account" →
    // type "demo" opens a populated sandbox in mock mode WITHOUT minting
    // an identity or hitting the network (DemoFixtures is purely local;
    // the screens are served by MockScreensClient). Nothing is created
    // anywhere — sign-out clears it.
    private let mockServerClient: any FlagshipServerClient = {
        let m = MockFlagshipServerClient()
        m.demoServers = [
            "demo": DemoServerBlock(
                fqdn: "home.demo.flagship.services",
                status: "up",
                ttlIdleMinutes: 30
            )
        ]
        // `-smoke-recovery-enrolled` (screenshot captures): the mock must
        // report recovery too, or Home's recovery-status poll unsets it.
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-smoke-recovery-enrolled") {
            let i = args.firstIndex(of: "-smoke-username")
            let user = i.flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "smoketest"
            m.cloudRecoveryByUser[user.lowercased()] = true
        }
        return m
    }()
    private let mockRelay = MockQrRelayClient()
    // Phone-as-unlock-endpoint relay mailbox. Live in production so the
    // SecretRequestsContainer can fetch + answer the box's boot-secret
    // requests; Mock (empty inbox) in dev/preview.
    private let mockMailbox = MockSecretMailboxClient()
    // Lock/power-off + dead-man box-direct client. Live (box-pinned session)
    // in production; the in-process Mock (records sends, never auto-affirms)
    // in dev/preview/demo.
    private let mockLockPower = MockLockPowerClient()
    // Front-page (owner-assignable apex) box-direct client — same pinned
    // session and live/mock split as lock/power.
    private let mockFrontPage = MockFrontPageClient()
    // Direct (box-read) per-service leadership — `GET /api/leads` over the SAME
    // box-pinned session, preferred over the `.com` `/pods` relay when a box is
    // reachable. The Mock returns nil ("no fresher source") so dev/preview/demo
    // keep the relay value untouched.
    private let mockLeads = MockLeadsClient()
    // Service-uninstall box-direct client — same pinned session and live/mock
    // split as lock/power + front-page.
    private let mockServiceUninstall = MockServiceUninstallClient()
    // Transfer-a-box broker client — hits `.com` (the namespace-migration
    // broker), not a box-pinned pipe, so it's a plain live client; live/mock
    // split as the others.
    private let mockServerTransfer = MockServerTransferClient()
    // Server-migration lane client — hits `.com` (the migration orchestration
    // lane), not a box-pinned pipe; live/mock split as transfer.
    private let mockServerMigration = MockServerMigrationClient()
    // Per-service access gating (#92): box calls ride the SAME box-pinned
    // session (set-mode + redeem are signature-authed daemon endpoints); the
    // invite create/list/revoke calls hit `.com` over the default public-CA
    // session. Live/mock split as the other box-direct clients.
    private let mockServiceAccess = MockServiceAccessClient()
    /// Gym-only (`-smoke-mode -smoke-access-fixture`): a members list on the
    /// demo apps' Access control, signed with fixed keys instead of the Keystore.
    /// `-smoke-non-admin-device` plays a device without the admin root (a
    /// Manager in the apps); `-smoke-member-rank-device` one an admin set to
    /// Member.
    private let accessFixture = AccessFixtureOnce()
    private var accessFixtureKeys: ServiceAccessKeys? {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("-smoke-mode"), args.contains("-smoke-access-fixture"), GymLaunch.usesMocks else { return nil }
        return accessFixture.keys {
            ServiceAccessFixture.seed(access: mockServiceAccess, screens: mockClient,
                                      serviceIds: ["bright-maple--plants", "bright-maple--wiki", "trent--scratchpad"],
                                      nonAdmin: args.contains("-smoke-non-admin-device"),
                                      memberRank: args.contains("-smoke-member-rank-device"))
        }
    }
    /// Every mock client, for the gym's launch seams.
    private var gymMocks: GymMocks {
        GymMocks(screens: mockClient, server: mockServerClient as? MockFlagshipServerClient, mailbox: mockMailbox,
                 lockPower: mockLockPower, frontPage: mockFrontPage, uninstall: mockServiceUninstall,
                 access: mockServiceAccess, transfer: mockServerTransfer, migration: mockServerMigration, relay: mockRelay)
    }
    #else
    private var accessFixtureKeys: ServiceAccessKeys? { nil }
    #endif
    /// What the shell injects: the live clients, or the mock gym's in a Debug
    /// build launched with `-smoke-mode` / `-smoke-onboarding`.
    private var activeClient: any ScreensClient {
        #if DEBUG
        if GymLaunch.usesMocks { return mockClient }
        #endif
        return liveClient
    }
    private var activePodClients: PodScreensClientFactory {
        #if DEBUG
        if GymLaunch.usesMocks { return .shared(mockClient) }
        #endif
        return livePodClients
    }
    private var activeServerClient: any FlagshipServerClient {
        #if DEBUG
        if GymLaunch.usesMocks { return mockServerClient }
        #endif
        return liveServerClient
    }
    private var activeRelay: any QrRelayClient {
        #if DEBUG
        if GymLaunch.usesMocks { return mockRelay }
        #endif
        return liveRelay
    }
    private var activeMailbox: any SecretMailboxClient {
        #if DEBUG
        if GymLaunch.usesMocks { return mockMailbox }
        #endif
        return liveMailbox
    }
    private var activeLockPower: any LockPowerClient {
        #if DEBUG
        if GymLaunch.usesMocks { return mockLockPower }
        #endif
        return liveLockPower
    }
    private var activeFrontPage: any FrontPageClient {
        #if DEBUG
        if GymLaunch.usesMocks { return mockFrontPage }
        #endif
        return liveFrontPage
    }
    private var activeLeads: any LeadsClient {
        #if DEBUG
        if GymLaunch.usesMocks { return mockLeads }
        #endif
        return liveLeads
    }
    private var activeServiceUninstall: any ServiceUninstallClient {
        #if DEBUG
        if GymLaunch.usesMocks { return mockServiceUninstall }
        #endif
        return liveServiceUninstall
    }
    private var activeServiceAccess: any ServiceAccessClient {
        #if DEBUG
        if GymLaunch.usesMocks { return mockServiceAccess }
        #endif
        return liveServiceAccess
    }
    private var activeServerTransfer: any ServerTransferClient {
        #if DEBUG
        if GymLaunch.usesMocks { return mockServerTransfer }
        #endif
        return liveServerTransfer
    }
    private var activeServerMigration: any ServerMigrationClient {
        #if DEBUG
        if GymLaunch.usesMocks { return mockServerMigration }
        #endif
        return liveServerMigration
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .onGeometryChange(for: CGSize.self, of: { $0.size }) { _ in
                    OrientationPolicy.reconcile()
                }
                .environment(appState)
                .environment(linker)
                .environment(toasts)
                .environment(operations)
                .environment(trust)
                .environment(privacy)
                .environment(\.screensClient, activeClient)
                .environment(\.sessionStore, sessionStore)
                .environment(\.podScreensClients, activePodClients)
                .environment(\.flagshipServerClient, activeServerClient)
                .environment(\.qrRelayClient, activeRelay)
                .environment(\.pairingRelayClient, pairingRelay)
                .environment(\.secretMailboxClient, activeMailbox)
                .environment(\.lockPowerClient, activeLockPower)
                .environment(\.frontPageClient, activeFrontPage)
                .environment(\.leadsClient, activeLeads)
                .environment(\.serviceUninstallClient, activeServiceUninstall)
                .environment(\.serviceAccessClient, activeServiceAccess)
                .environment(\.serviceAccessKeys, accessFixtureKeys)
                .environment(\.serverTransferClient, activeServerTransfer)
                .environment(\.serverMigrationClient, activeServerMigration)
                .environment(\.pushRegistrar, pushRegistrar)
                .alert(
                    "Account no longer listed",
                    isPresented: Binding(
                        get: { orphanedPersistedUsername != nil && appState.isUnlocked },
                        set: { presented in
                            if !presented { orphanedPersistedUsername = nil }
                        }
                    )
                ) {
                    Button("Keep on This iPhone", role: .cancel) {
                        orphanedPersistedUsername = nil
                    }
                    Button("Erase Local Keys and Data", role: .destructive) {
                        // This is the only wipe in this flow: an explicit local
                        // choice made after the phone has been unlocked.
                        Keystore.wipe()
                        appState.signOut()
                        orphanedPersistedUsername = nil
                    }
                } message: {
                    Text("Flagship.com no longer lists this account. Nothing on this iPhone has been deleted. You can keep using the local account, or erase its local keys and data to start over.")
                }
                .onAppear {
                    #if DEBUG
                    Self.applySmokeModeIfRequested(appState, linker: linker, operations: operations, trust: trust, privacy: privacy,
                                                   screens: mockClient, mocks: gymMocks)
                    #endif
                    appDelegate.linker = linker
                    linker.makeCurrent()
                    WatchBridge.shared.activate(
                        client: activeClient,
                        mailbox: activeMailbox,
                        currentUser: { [appState] in appState.currentUser }
                    )
                    // Wire the FlagshipCore security-alerts bridge → the
                    // App-target publisher so the boot-approval + audit
                    // surfaces fan out to the paired watch.
                    WatchSecurityAlertsPublisher.shared.activate()
                    let push = PushNotifications(linker: linker)
                    let privacy = self.privacy
                    let registrar = PushRegistrar(appState: appState, client: activeServerClient,
                                                  isEnabled: { privacy.pushNotificationsEnabled })
                    push.onDeviceTokenChange = { token in
                        Task { @MainActor in await registrar.handle(deviceToken: token) }
                    }
                    appDelegate.push = push
                    appDelegate.pushRegistrar = registrar
                    pushRegistrar = registrar
                }
                .task {
                    await restorePersistedIdentity()
                }
                .onOpenURL { url in
                    if let link = DeepLink.parse(url) { linker.enqueue(link) }
                }
                // Universal links (AASA) — the native Camera opening a
                // `https://flagshipserver.com/{join,transfer,…}` link arrives as a
                // web-browsing user activity, NOT via onOpenURL. Route it through
                // the same DeepLink parser (Slice C take-over relies on this).
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL, let link = DeepLink.parse(url) {
                        linker.enqueue(link)
                    }
                }
        }
    }

    @MainActor
    private func restorePersistedIdentity() async {
        guard !persistedIdentityRestoreStarted else { return }
        persistedIdentityRestoreStarted = true

        // Arm the user's local lock preference before restoring. The directory
        // lookup below never participates in deciding whether local access is
        // allowed and cannot delay the Face ID screen.
        appState.requireBiometricAtLaunch = privacy.requireBiometricAtLaunch
        if privacy.requireBiometricAtLaunch && appState.isPaired {
            appState.isUnlocked = false
        }

        if !appState.isPaired {
            if !privacy.requirePassphraseAtLaunch,
               Keystore.hasWrappedUMK,
               Keystore.activeProfileId != Keystore.defaultProfileId {
                let username = Keystore.activeProfileId
                if privacy.requireBiometricAtLaunch {
                    appState.isUnlocked = false
                }
                let outcome = await PersistedSessionReconciler.reconcile(
                    username: username,
                    server: liveServerClient,
                    restore: { appState.restorePersistedSession(username: $0) }
                )
                if outcome == .missing {
                    orphanedPersistedUsername = username
                }
            } else if !Keystore.hasWrappedUMK,
                      // A gym onboarding walk starts on Welcome, even after
                      // an earlier walk signed in to the mock demo.
                      !ProcessInfo.processInfo.arguments.contains("-smoke-onboarding"),
                      let demo = await sessionStore.demoSession {
                DemoAccount.activate(
                    appState,
                    username: demo.username,
                    demoServer: demo.server
                )
                if privacy.requireBiometricAtLaunch {
                    appState.isUnlocked = false
                }
            }
        }
    }
}

/// UIKit bridge for things SwiftUI doesn't fully cover yet:
///   - APNs device-token registration (didRegisterForRemoteNotificationsWithDeviceToken)
///   - UNUserNotificationCenter delegation (notification taps)
final class AppDelegate: NSObject, UIApplicationDelegate {
    var linker: DeepLinker?
    var push: PushNotifications?
    var pushRegistrar: PushRegistrar?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Push is wired up lazily once the user pairs — see
        // PushBootstrap below — so we don't prompt on the cold-start
        // welcome screen.
        return true
    }

    func application(
        _ application: UIApplication,
        supportedInterfaceOrientationsFor window: UIWindow?
    ) -> UIInterfaceOrientationMask {
        OrientationPolicy.mask(for: window)
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            push?.setDeviceToken(deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in push?.setDeviceToken(nil) }
    }
}

#if DEBUG
/// Seeds the gym's Access control fixture once per launch.
private final class AccessFixtureOnce {
    private var cached: ServiceAccessKeys?
    func keys(_ make: () -> ServiceAccessKeys) -> ServiceAccessKeys {
        if let cached { return cached }
        let k = make()
        cached = k
        return k
    }
}
#endif
