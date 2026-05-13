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
    @State private var pushRegistrar: PushRegistrar?
    private let mockClient = MockScreensClient()
    private let liveClient: any ScreensClient

    init() {
        // Keychain-backed token persistence: pod base URL stays in
        // UserDefaults (non-secret), the 32-byte session token lives
        // in Keychain with WhenUnlockedThisDeviceOnly access.
        self.liveClient = LiveScreensClient(store: KeychainSessionStore())
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
                .environment(\.screensClient, activeClient)
                .environment(\.flagshipServerClient, activeServerClient)
                .environment(\.qrRelayClient, activeRelay)
                .environment(\.pushRegistrar, pushRegistrar)
                .onAppear {
                    appDelegate.linker = linker
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
