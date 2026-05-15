import SwiftUI
import UIKit
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
        Self.wirePendingApprovalsBroadcast()
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

    /// Wire FlagshipUI's PendingApprovalsBroadcast to the WatchBridge
    /// — every refresh of the unlock-approval list mirrors to the
    /// paired Apple Watch via WCSession applicationContext.
    @MainActor
    private static func wirePendingApprovalsBroadcast() {
        PendingApprovalsBroadcast.send = { approvals in
            WatchBridge.shared.publishPending(approvals)
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
    private let mockServerClient: any FlagshipServerClient = MockFlagshipServerClient()
    private let liveServerClient: any FlagshipServerClient = LiveFlagshipServerClient()
    private let mockRelay = MockQrRelayClient()
    private let liveRelay: any QrRelayClient = LiveQrRelayClient()
    private var activeClient: any ScreensClient {
        dev.useLiveClient ? liveClient : mockClient
    }
    private var activeServerClient: any FlagshipServerClient {
        dev.useLiveClient ? liveServerClient : mockServerClient
    }
    private var activeRelay: any QrRelayClient {
        dev.useLiveClient ? liveRelay : mockRelay
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
