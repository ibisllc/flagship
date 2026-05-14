import Foundation
import FlagshipAPI

/// Hook for surfacing the fresh pending-unlock list to host
/// integrations (Apple Watch, Action Center, future widgets). Same
/// pattern as InstallProgressBridge — FlagshipUI doesn't import
/// WatchConnectivity / WidgetKit, so we expose a closure the App
/// registers from @main.
///
/// Call `broadcast(_:)` from view-models that have just refreshed
/// the unlock-approval list; the App wires the closure to
/// `WatchBridge.shared.publishPending(_:)`.
@MainActor
public enum PendingApprovalsBroadcast {
    public static var send: (([PendingUnlockApproval]) -> Void)?

    public static func broadcast(_ approvals: [PendingUnlockApproval]) {
        send?(approvals)
    }
}
