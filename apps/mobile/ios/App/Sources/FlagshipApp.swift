import SwiftUI
import UIKit
import FlagshipCore
import FlagshipAPI

@main
struct FlagshipApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var appState = AppState()
    @State private var linker = DeepLinker()
    @State private var toasts = ToastCenter()
    @State private var dev = DeveloperSettings()
    private let mockClient = MockScreensClient()
    private let liveClient: any ScreensClient

    init() {
        // Keychain-backed token persistence: pod base URL stays in
        // UserDefaults (non-secret), the 32-byte session token lives
        // in Keychain with WhenUnlockedThisDeviceOnly access.
        self.liveClient = LiveScreensClient(store: KeychainSessionStore())
    }
    private let serverClient: any FlagshipServerClient = MockFlagshipServerClient()
    private let mockRelay = MockQrRelayClient()
    private let liveRelay: any QrRelayClient = LiveQrRelayClient()
    private var activeClient: any ScreensClient {
        dev.useLiveClient ? liveClient : mockClient
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
                .environment(\.flagshipServerClient, serverClient)
                .environment(\.qrRelayClient, activeRelay)
                .onAppear { appDelegate.linker = linker }
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
