import Foundation

/// Bridge between InstallProgressViewModel (FlagshipUI) and any host
/// observer that wants to surface install-progress as a system-level
/// affordance (Live Activity, Watch, Action Center, …).
///
/// FlagshipUI deliberately doesn't import ActivityKit / WidgetKit —
/// those are App-target concerns. The bridge is a closure-typed hook
/// the App registers at boot; FlagshipUI calls the closures during
/// state transitions and the App decides what to do (start a Live
/// Activity, send a watch message, etc.).
///
/// Set hooks on `.shared` from your @main App; leave them nil in
/// previews/tests so the VM stays side-effect-free there.
@MainActor
public final class InstallProgressBridge {
    public static let shared = InstallProgressBridge()

    public var onStart:    ((_ serial: String, _ podName: String?) -> Void)?
    public var onStep:     ((_ step: InstallProgressViewModel.Step) -> Void)?
    public var onComplete: ((_ serverFqdn: String) -> Void)?
    public var onFailed:   ((_ reason: String) -> Void)?

    private init() {}
}
