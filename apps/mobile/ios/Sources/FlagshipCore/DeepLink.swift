import Foundation

/// In-app routes that can be triggered from outside the running view
/// tree — Web Push notification tap, custom URL scheme, Universal
/// Link, share-extension, etc. The shell observes `DeepLinker.pending`
/// and pushes the right destination on the right tab.
public enum DeepLink: Equatable, Sendable {
    case unlockApprove(requestId: String)
    /// Show the activity tab's pending-approvals list (no specific
    /// requestId). Used by the Siri/Shortcuts ApproveUnlockIntent
    /// when the user asks generically rather than from a push.
    case unlockApprovalsList
    case serverDetail(podId: String)
    case appDetail(appId: String)
    case marketplace
    case createServer
    /// Open the recovery-setup flow on the Settings tab. Triggered
    /// in-app from the Home nudge (B9). Not parseable from a URL —
    /// it's an internal-only deep link.
    case recoverySetup

    /// Parse a `flagship://...` URL. Mirrors the webapp's `?view=...`
    /// scheme (apps/web/public/webapp/lib/router.js → parseViewQuery).
    /// Returns nil for anything we don't recognize.
    public static func parse(_ url: URL) -> DeepLink? {
        guard url.scheme == "flagship" else { return nil }
        let host = url.host ?? ""
        let params = (URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems ?? [])
            .reduce(into: [String: String]()) { acc, item in
                if let v = item.value { acc[item.name] = v }
            }
        switch host {
        case "unlock-approve":
            if let id = params["requestId"], id != "latest", id != "any" {
                return .unlockApprove(requestId: id)
            }
            return .unlockApprovalsList
        case "unlock-approvals":
            return .unlockApprovalsList
        case "server":
            if let id = params["podId"] { return .serverDetail(podId: id) }
        case "app":
            if let id = params["appId"] { return .appDetail(appId: id) }
        case "marketplace":
            return .marketplace
        case "create-server":
            return .createServer
        default:
            break
        }
        return nil
    }
}

import Observation

/// Single source of truth for "an out-of-band navigation event is
/// waiting to be consumed." Set by the SceneDelegate / URL handler /
/// push-notification handler; cleared by the shell once routed.
@Observable
@MainActor
public final class DeepLinker {
    public var pending: DeepLink?
    public init() {}
    public func enqueue(_ link: DeepLink) { pending = link }
    public func consume() -> DeepLink? {
        let p = pending
        pending = nil
        return p
    }
}
