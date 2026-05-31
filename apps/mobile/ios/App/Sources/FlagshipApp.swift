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

    init() {
        // Keychain-backed token persistence: pod base URL stays in
        // UserDefaults (non-secret), the 32-byte session token lives
        // in Keychain with WhenUnlockedThisDeviceOnly access.
        self.liveClient = LiveScreensClient(store: KeychainSessionStore())
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
    /// Live Activity. The bridge is set up once at @main init so
    /// any InstallProgressViewModel — onboarding or in-app — drives
    /// the Dynamic Island / Lock Screen without each call site
    /// having to import ActivityKit.
    @MainActor
    private static func wireInstallProgressBridge() {
        let b = InstallProgressBridge.shared
        b.onStart = { serial, podName in
            InstallProgressLiveActivityCenter.shared.start(
                serial: serial,
                podName: podName ?? "Provisioning"
            )
        }
        b.onStep = { step in
            Task { await InstallProgressLiveActivityCenter.shared.advance(to: bridge(step)) }
        }
        b.onComplete = { fqdn in
            Task { await InstallProgressLiveActivityCenter.shared.complete(serverFqdn: fqdn) }
        }
        b.onFailed = { reason in
            Task { await InstallProgressLiveActivityCenter.shared.fail(reason: reason) }
        }
    }

    /// Wire FlagshipCore's ProvisionPhaseBridge (fed by `provision-phase`
    /// pushes from .com) into the SAME InstallProgressBridge the
    /// onboarding flow uses. This turns a phase push into a Live Activity
    /// step transition — provisioning becomes a glass box even when the
    /// app is backgrounded and the user never opened the progress screen.
    @MainActor
    private static func wireProvisionPhaseBridge() {
        ProvisionPhaseBridge.shared.onPhase = { event in
            let progress = InstallProgressBridge.shared
            // The first checkpoint also kicks off the Live Activity (the
            // onboarding path normally calls onStart; a push-only path —
            // e.g. demo-connect from another device — needs it here).
            switch event.phase {
            case "failed":
                progress.onFailed?(event.error ?? "Provisioning failed")
            case "ready":
                progress.onComplete?(event.fqdn)
            default:
                if let step = phaseToStep(event.phase) {
                    progress.onStep?(step)
                }
            }
            // Mirror the phase onto the watch's install-progress surface
            // (W1). The push carries username + fqdn but no serial; the
            // fqdn doubles as the publisher's continuity key — same
            // install yields the same fqdn across every phase push, so
            // history accumulates correctly on the watch.
            WatchTimelinePublisher.shared.update(
                from: event,
                podName: event.fqdn.isEmpty ? "Provisioning" : event.fqdn,
                serial: event.fqdn.isEmpty ? event.username : event.fqdn
            )
        }
    }

    /// Map a wire phase string (`@flagship/protocol` PROVISION_PHASES)
    /// to the FlagshipUI install-progress Step. The four intermediate
    /// cloud-init phases (cloned/deps/built/identity) all collapse onto
    /// `.boot` — the Step enum's coarsest "still setting up" rung — so
    /// the Live Activity advances monotonically without needing a new
    /// step per shell command. Returns nil for phases handled elsewhere
    /// (ready/failed) or unknown future strings.
    @MainActor
    private static func phaseToStep(_ phase: String) -> InstallProgressViewModel.Step? {
        switch phase {
        case "boot", "cloned", "deps", "built", "identity": return .boot
        case "registered":     return .registered
        case "tunnel-online":  return .tunnelOnline
        case "cert-issued":    return .certIssued
        case "ready":          return .ready
        default:               return nil
        }
    }

    /// One-to-one translation from FlagshipUI's Step enum to the
    /// widget-extension's ActivityAttributes.Step. They're separate
    /// types because the widget extension can't import FlagshipUI.
    @MainActor
    private static func bridge(_ step: InstallProgressViewModel.Step) -> InstallProgressAttributes.Step {
        switch step {
        case .registered:   return .registered
        case .boot:         return .boot
        case .tunnelOnline: return .tunnelOnline
        case .certIssued:   return .certIssued
        case .ready:        return .ready
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
                .environment(\.flagshipServerClient, activeServerClient)
                .environment(\.qrRelayClient, activeRelay)
                .environment(\.pairingRelayClient, pairingRelay)
                .environment(\.secretMailboxClient, activeMailbox)
                .environment(\.pushRegistrar, pushRegistrar)
                .onAppear {
                    Self.applySmokeModeIfRequested(appState, linker: linker)
                    // B12 — hydrate the AppState gate from persisted
                    // user preference. Done in onAppear (not init) so
                    // SmokeMode runs first and can leave isPaired
                    // false (in which case requireBiometricAtLaunch
                    // is moot — Welcome is unauthenticated anyway).
                    appState.requireBiometricAtLaunch = privacy.requireBiometricAtLaunch
                    if privacy.requireBiometricAtLaunch && appState.isPaired {
                        appState.isUnlocked = false
                    }
                    appDelegate.linker = linker
                    WatchBridge.shared.activate(client: activeClient)
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
