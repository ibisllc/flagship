#if canImport(UIKit)
import UIKit

/// Apple-native edge-swipe-back, on every pushed screen.
///
/// UIKit wires the interactive "pop" gesture (swipe in from the left edge to
/// go back) to the *default* navigation back button. Any screen that hides or
/// replaces that back button — a custom header, `navigationBarBackButtonHidden`,
/// etc. — silently disables the gesture, so the view follows your finger a
/// little and then springs back instead of popping. That's the behaviour you
/// saw on the recovery / secure-account screen.
///
/// Re-point the gesture's delegate at the navigation controller itself and let
/// it begin whenever there's a previous screen to return to. This restores the
/// standard iOS feel — swipe past the threshold (or with enough velocity) pops
/// one step back, through successive pushes — across every tab's
/// `NavigationStack` and every detail screen, regardless of how its header is
/// drawn.
///
/// `@retroactive` is required under the Swift 6 language mode: we're conforming
/// a UIKit type we don't own to a UIKit protocol we don't own. The override of
/// `viewDidLoad` is permitted because `UINavigationController` is an
/// Objective-C class and `viewDidLoad` is a dynamic method.
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        // Only the interactive-pop recognizer has us as its delegate, so this
        // gates exactly that gesture: begin it only when the stack has somewhere
        // to pop back to (never at a tab/stack root).
        viewControllers.count > 1
    }
}
#endif
