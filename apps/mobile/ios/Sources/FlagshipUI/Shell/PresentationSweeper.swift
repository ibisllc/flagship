import UIKit

/// Sheets, popovers, confirmation dialogs, alerts, pickers and full-screen
/// covers are presented in their own UIKit layer, ABOVE the lock overlay
/// (which is an ordinary SwiftUI overlay). Without this, a menu or sheet that
/// was open when the app locked stayed visible and operable on top of the lock
/// screen. Locking dismisses every presented controller on every window, so
/// nothing of the locked session is on screen and nothing re-presents on
/// unlock.
@MainActor
enum PresentationSweeper {
    /// Dismiss everything presented over each window's root, without animation.
    static func dismissAll() {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                guard let root = window.rootViewController, root.presentedViewController != nil else { continue }
                root.dismiss(animated: false)
            }
        }
    }

    /// True while anything is presented over any window's root (the gym and
    /// the unit tests ask).
    static var hasPresentation: Bool {
        UIApplication.shared.connectedScenes.contains { scene in
            (scene as? UIWindowScene)?.windows.contains { $0.rootViewController?.presentedViewController != nil } ?? false
        }
    }
}
