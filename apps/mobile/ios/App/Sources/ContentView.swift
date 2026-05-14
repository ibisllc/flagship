import SwiftUI
import UIKit
import FlagshipCore
import FlagshipUI

struct ContentView: View {
    @Environment(AppState.self) private var app
    @Environment(DeepLinker.self) private var linker
    @Environment(ToastCenter.self) private var toasts

    var body: some View {
        ZStack {
            if app.isPaired {
                RootShell(initialDestination: smokeInitialDestination ?? .home)
            } else {
                Color.clear
            }
            Toaster()
        }
        .fullScreenCover(isPresented: Binding(
            get: { !app.isPaired },
            set: { _ in /* read-only — onboarding sets paired itself */ }
        )) {
            OnboardingFlow()
                .environment(app)
                .environment(linker)
                .environment(toasts)
        }
        .onChange(of: app.isPaired) { _, paired in
            if paired { Task { await registerPush() } }
            PodStatusPublisher(app: app).publish()
        }
        .onChange(of: app.pods) { _, _ in
            PodStatusPublisher(app: app).publish()
        }
        .onChange(of: app.leaderPodId) { _, _ in
            PodStatusPublisher(app: app).publish()
        }
        .task { PodStatusPublisher(app: app).publish() }
    }

    /// Lazy push registration — only after the user has a paired pod
    /// to receive notifications on. Re-enters every time we transition
    /// from unpaired → paired (post-recovery, fresh signup, etc.).
    ///
    /// The PushNotifications instance + PushRegistrar are owned by the
    /// App scope (see FlagshipApp.body), so the device-token callback
    /// can route through to .com regardless of which view triggered
    /// `registerForRemoteNotifications`.
    /// Smoke-test plumbing: launch with `-smoke-tab <home|apps|activity|settings>`
    /// to land on a specific tab on first paint. Production builds never
    /// pass this arg, so the optional stays nil and `.home` is used.
    private var smokeInitialDestination: RootDestination? {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("-smoke-mode"),
              let idx = args.firstIndex(of: "-smoke-tab"),
              idx + 1 < args.count
        else { return nil }
        switch args[idx + 1] {
        case "home":     return .home
        case "apps":     return .apps
        case "activity": return .activity
        case "settings": return .settings
        default:         return nil
        }
    }

    private func registerPush() async {
        guard let delegate = UIApplication.shared.delegate as? AppDelegate,
              let push = delegate.push else { return }
        if await push.requestAuthorization() {
            await MainActor.run {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }
}
