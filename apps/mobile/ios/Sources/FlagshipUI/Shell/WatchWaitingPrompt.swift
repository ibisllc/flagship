import SwiftUI
import Flagship
import FlagshipCore

/// Says in the app that the watch's Approve is waiting for this session's
/// first Face ID. The watch's reply already told the owner to unlock; this
/// is the same ask where they now are. Face ID opens only from the owner's
/// tap here, in front, never from the watch's request.
struct WatchWaitingPrompt: ViewModifier {
    @Environment(AppState.self) private var app
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.scenePhase) private var scenePhase
    private let prompt = WatchApprovalPrompt.shared

    func body(content: Content) -> some View {
        content.alert(
            WatchApprovalPrompt.title,
            isPresented: Binding(
                get: {
                    app.isPaired && prompt.shouldAsk(
                        inFront: scenePhase == .active,
                        appUnlocked: app.isUnlocked,
                        hasSessionKey: Keystore.hasSessionKey()
                    )
                },
                // Asked once: a cancelled Face ID doesn't bring it back.
                set: { shown in if !shown { prompt.clear() } }
            )
        ) {
            Button("Unlock") { Task { await unlock() } }
            Button("Not now", role: .cancel) { prompt.clear() }
        } message: {
            Text(WatchApprovalPrompt.message(serverName: serverName))
        }
    }

    private var serverName: String? {
        guard let fqdn = prompt.current?.serverFqdn?.lowercased() else { return nil }
        return app.pods.first(where: { $0.fqdn.lowercased() == fqdn })?.name
    }

    private func unlock() async {
        guard let context = try? await BiometricGate().evaluateReturningContext(
            reason: "Let your Apple Watch approve"
        ) else { return }
        Keystore.cacheSessionUMK(authenticatedBy: context)
        if Keystore.hasSessionKey() { toasts.success(WatchApprovalPrompt.afterUnlock) }
    }
}

extension View {
    func watchWaitingPrompt() -> some View { modifier(WatchWaitingPrompt()) }
}
