import Foundation

/// Bridge between the FlagshipUI security surfaces (boot-approval mailbox
/// + audit log) and the App-target WCSession publisher. FlagshipUI can't
/// import the App target (and FlagshipCore can't import FlagshipUI or
/// FlagshipAPI — dependency direction), so the App wires these closures
/// at boot — same pattern as `ProvisionPhaseBridge`.
///
/// FlagshipUI fetches its richer `AuditEvent` / `PendingSecretRequest`
/// rows, projects them onto the FlagshipCore-owned `WatchProtocol` wire
/// types, and calls the bridge. The App-side closure forwards to
/// `WatchSecurityAlertsPublisher`, which merges + publishes via
/// `WatchBridge`.
///
/// Set the closures on `.shared` from your @main App; leave them nil in
/// previews/tests so the view-models stay side-effect-free there.
@MainActor
public final class WatchSecurityAlertsBridge {
    public static let shared = WatchSecurityAlertsBridge()

    /// Called when the pending-boot-approval list changes (the mailbox
    /// surface fetched a fresh set). Carries the full set; the watch
    /// trims/sorts.
    public var onApprovals: ((_ approvals: [WatchProtocol.PendingApproval]) -> Void)?

    /// Called when the account audit log is (re)loaded. Carries the
    /// fetched events; the watch trims to the newest few.
    public var onEvents: ((_ events: [WatchProtocol.SecurityAlert]) -> Void)?

    private init() {}

    /// Forward a fresh pending-approval set. No-op when unwired.
    public func publishApprovals(_ approvals: [WatchProtocol.PendingApproval]) {
        onApprovals?(approvals)
    }

    /// Forward a fresh audit-event set. No-op when unwired.
    public func publishEvents(_ events: [WatchProtocol.SecurityAlert]) {
        onEvents?(events)
    }
}
