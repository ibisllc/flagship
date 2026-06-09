import SwiftUI
import UIKit
import Flagship
import FlagshipCore
import FlagshipAPI
import FlagshipUI

@main
struct FlagshipApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var appState = AppState()
    @State private var linker = DeepLinker()
    @State private var toasts = ToastCenter()
    @State private var dev = DeveloperSettings()
    @State private var privacy = PrivacySettings()
    @State private var pushRegistrar: PushRegistrar?
    private let mockClient = MockScreensClient()
    private let liveClient: any ScreensClient
    // The session store backing the live screens client. Owned here so
    // the shell can repoint `podBaseUrl` at the currently selected online
    // server (see PodSessionSync). The same instance is injected into the
    // environment so views drive it without reaching into the client.
    private let sessionStore: any SessionStoring

    init() {
        // Keychain-backed token persistence: pod base URL stays in
        // UserDefaults (non-secret), the 32-byte session token lives
        // in Keychain with WhenUnlockedThisDeviceOnly access.
        let store = KeychainSessionStore()
        self.sessionStore = store
        self.liveClient = LiveScreensClient(store: store)
        Self.wireInstallProgressBridge()
        Self.wireProvisionPhaseBridge()
        // AppState's profile-switch hook bridges into the iOS-only
        // Keystore so UMK/IRK derivation tracks the active cloud. The
        // hook is unset on watchOS (which doesn't link the iOS-only
        // Flagship target / has no keystore).
        appState.onActiveProfileChanged = { cloudName in
            Keystore.setActiveProfile(cloudName)
        }
    }

    /// Smoke-test entry point: when launched with `-smoke-mode YES`
    /// the app skips onboarding and lands directly on the paired
    /// shell with DemoFixtures sample pods. ContentView pairs this
    /// with `-smoke-tab` to pre-route the shell to a tab. Production
    /// builds ignore the flag — `ProcessInfo.arguments` is only
    /// populated when the launcher sets it.
    @MainActor
    private static func applySmokeModeIfRequested(_ app: AppState, linker: DeepLinker) {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("-smoke-mode") else { return }
        if !app.isPaired {
            DemoFixtures.activate(app, username: "smoketest")
        }
    }

    /// Wire the FlagshipUI InstallProgressBridge to the App-target
    /// Live Activity. The bridge is set up once at @main init so the
    /// canonical provisioning timeline (ProvisionTimelineViewModel /
    /// PendingServerScreen, or a push) drives the Dynamic Island / Lock
    /// Screen + the Watch without each call site importing ActivityKit.
    @MainActor
    private static func wireInstallProgressBridge() {
        let b = InstallProgressBridge.shared
        b.onStart = { serial, podName in
            InstallProgressLiveActivityCenter.shared.start(
                serial: serial,
                podName: podName ?? "Provisioning"
            )
        }
        b.onStep = { phase in
            Task { await InstallProgressLiveActivityCenter.shared.advance(to: bridge(phase)) }
        }
        b.onComplete = { fqdn in
            Task { await InstallProgressLiveActivityCenter.shared.complete(serverFqdn: fqdn) }
        }
        b.onFailed = { reason in
            Task { await InstallProgressLiveActivityCenter.shared.fail(reason: reason) }
        }
        // Rich poll-driven path: forward the full canonical status onto
        // the Watch timeline (history + serverDomain). Sparse push-driven
        // updates go through wireProvisionPhaseBridge below.
        b.onStatus = { status, podName in
            WatchTimelinePublisher.shared.update(from: status, podName: podName)
        }
    }

    /// Wire FlagshipCore's ProvisionPhaseBridge (fed by `provision-status`
    /// pushes from .com) into the SAME InstallProgressBridge the
    /// onboarding flow uses. This turns a phase push into a Live Activity
    /// transition — provisioning becomes a glass box even when the app is
    /// backgrounded and the user never opened the progress screen. The
    /// phase is the single canonical `ProvisionStatusPhase`.
    @MainActor
    private static func wireProvisionPhaseBridge() {
        ProvisionPhaseBridge.shared.onPhase = { event in
            let progress = InstallProgressBridge.shared
            switch event.phase {
            case .error:
                progress.onFailed?(event.detail ?? "Setup hit a problem")
            case .live:
                // serverDomain isn't carried on the push meta; the Live
                // Activity already shows the serial — pass the detail or
                // an empty string (the poll path fills in the FQDN).
                progress.onComplete?(event.detail ?? "")
            default:
                progress.onStep?(event.phase)
            }
            // Mirror the phase onto the watch's install-progress surface
            // (W1) keyed by the order serial — same install yields the
            // same serial across every phase push, so history accumulates
            // correctly on the watch.
            WatchTimelinePublisher.shared.update(
                phase: event.phase,
                serial: event.serial,
                detail: event.detail,
                podName: "Provisioning"
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
    // Seed the mock with one demo user so "I already have an account" →
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
        return m
    }()
    private let liveServerClient: any FlagshipServerClient = LiveFlagshipServerClient()
    private let mockRelay = MockQrRelayClient()
    private let liveRelay: any QrRelayClient = LiveQrRelayClient()
    // Phase 3b — cross-device pairing relay seam. The live bidirectional
    // transport over /qr-pipe is a follow-up; the Mock seam is wired so
    // the admin/incoming flows + safeguards are exercisable today.
    private let pairingRelay = MockPairingRelayClient()
    // Phone-as-unlock-endpoint relay mailbox. Live in production so the
    // SecretRequestsContainer can fetch + answer the box's boot-secret
    // requests; Mock (empty inbox) in dev/preview.
    private let mockMailbox = MockSecretMailboxClient()
    private let liveMailbox: any SecretMailboxClient = LiveSecretMailboxClient()
    private var activeClient: any ScreensClient {
        dev.useLiveClient ? liveClient : mockClient
    }
    private var activeServerClient: any FlagshipServerClient {
        dev.useLiveClient ? liveServerClient : mockServerClient
    }
    private var activeRelay: any QrRelayClient {
        dev.useLiveClient ? liveRelay : mockRelay
    }
    private var activeMailbox: any SecretMailboxClient {
        dev.useLiveClient ? liveMailbox : mockMailbox
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(appState)
                .environment(linker)
                .environment(toasts)
                .environment(dev)
                .environment(privacy)
                .environment(\.screensClient, activeClient)
                .environment(\.sessionStore, sessionStore)
                .environment(\.flagshipServerClient, activeServerClient)
                .environment(\.qrRelayClient, activeRelay)
                .environment(\.pairingRelayClient, pairingRelay)
                .environment(\.secretMailboxClient, activeMailbox)
                .environment(\.pushRegistrar, pushRegistrar)
                .onAppear {
                    Self.applySmokeModeIfRequested(appState, linker: linker)
                    // Restore a previously paired session: if the Keystore
                    // still holds a wrapped UMK (a real account that
                    // survives restarts) and we know which cloud was
                    // active, land on the gated shell instead of forcing a
                    // fresh sign-in every launch. Demo/mock sessions never
                    // wrap a UMK, so they fall through to Welcome as before.
                    // Skipped when the user opted into a full passphrase
                    // sign-in on every open (Settings -> Privacy).
                    if !appState.isPaired,
                       !privacy.requirePassphraseAtLaunch,
                       Keystore.hasWrappedUMK,
                       Keystore.activeProfileId != Keystore.defaultProfileId {
                        appState.restorePersistedSession(username: Keystore.activeProfileId)
                    }
                    // B12 — hydrate the AppState gate from persisted
                    // user preference. Done in onAppear (not init) so
                    // SmokeMode + session-restore run first and can leave
                    // isPaired false (in which case requireBiometricAtLaunch
                    // is moot — Welcome is unauthenticated anyway).
                    appState.requireBiometricAtLaunch = privacy.requireBiometricAtLaunch
                    if privacy.requireBiometricAtLaunch && appState.isPaired {
                        appState.isUnlocked = false
                    }
                    appDelegate.linker = linker
                    WatchBridge.shared.activate(client: activeClient)
                    // Wire the FlagshipCore security-alerts bridge → the
                    // App-target publisher so the boot-approval + audit
                    // surfaces fan out to the paired watch.
                    WatchSecurityAlertsPublisher.shared.activate()
                    let push = PushNotifications(linker: linker)
                    let registrar = PushRegistrar(appState: appState, client: activeServerClient)
                    push.onDeviceTokenChange = { token in
                        Task { @MainActor in await registrar.handle(deviceToken: token) }
                    }
                    appDelegate.push = push
                    appDelegate.pushRegistrar = registrar
                    pushRegistrar = registrar
                }
                .onOpenURL { url in
                    if let link = DeepLink.parse(url) { linker.enqueue(link) }
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
