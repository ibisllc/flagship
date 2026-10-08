#if canImport(UIKit)
import UIKit

/// Tablet-sized screens (iPad, an open or partially open iPhone Duo) run
/// landscape-only; phone-sized screens (every other iPhone, a closed Duo) run
/// portrait-only. Decided per screen rather than per device idiom because a
/// Duo is both, depending on which of its displays the app is on.
public enum OrientationPolicy {
    /// Shortest screen side, in points, from which a screen counts as
    /// tablet-sized. The largest iPhone and the Duo's outer display are under
    /// 470pt; the Duo's inner display is 669pt and the smallest iPad 744pt.
    static let tabletMinShortSide: CGFloat = 600

    public static func mask(forScreenSize size: CGSize) -> UIInterfaceOrientationMask {
        min(size.width, size.height) >= tabletMinShortSide ? .landscape : .portrait
    }

    @MainActor
    public static func mask(for window: UIWindow?) -> UIInterfaceOrientationMask {
        guard let screen = window?.windowScene?.screen else {
            return UIDevice.current.userInterfaceIdiom == .pad ? .landscape : .portrait
        }
        return mask(forScreenSize: screen.bounds.size)
    }

    /// Moving between a Duo's displays keeps the current interface
    /// orientation even when the new display's mask excludes it (the app
    /// renders sideways on the inner display, or stays landscape after
    /// folding shut), and iOS refuses a rotation request while the fold is
    /// still animating. Call on every window-size change: rotates each scene
    /// into its display's mask, retrying until the transition settles.
    @MainActor
    public static func reconcile() {
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            reconcile(scene, attemptsLeft: 10)
        }
    }

    @MainActor
    private static func reconcile(_ scene: UIWindowScene, attemptsLeft: Int) {
        let mask = mask(forScreenSize: scene.screen.bounds.size)
        guard !mask.contains(scene.effectiveGeometry.interfaceOrientation.mask), attemptsLeft > 0 else { return }
        for window in scene.windows {
            window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
        }
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask))
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(300))
            reconcile(scene, attemptsLeft: attemptsLeft - 1)
        }
    }
}

private extension UIInterfaceOrientation {
    var mask: UIInterfaceOrientationMask {
        switch self {
        case .portrait: .portrait
        case .portraitUpsideDown: .portraitUpsideDown
        case .landscapeLeft: .landscapeLeft
        case .landscapeRight: .landscapeRight
        default: []
        }
    }
}
#endif
