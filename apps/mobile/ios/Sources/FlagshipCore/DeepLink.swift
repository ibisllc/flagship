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
    case appDetail(serviceId: String)
    case marketplace
    case createServer
    /// Open the recovery-setup flow on the Settings tab. Triggered
    /// in-app from the Home nudge (B9). Not parseable from a URL —
    /// it's an internal-only deep link.
    case recoverySetup
    /// W10 — open the vibe-code chat surface for the given session
    /// id. Fired by the `vibecode-needs-you` push when the AI is
    /// awaiting an env-var or talkToUser response.
    case vibeCodeChat(sessionId: String)

    /// Phase 3b — cross-device pairing join. Carries the relay session
    /// id + the admin's ephemeral X25519 public key (base64url) from a
    /// scanned/deep-linked pairing QR. Routes into the add-profile
    /// pairing flow (the incoming/collaborator side). Reachable two
    /// ways: the in-app scanner, OR the native camera opening the
    /// UNIVERSAL LINK `https://flagshipserver.com/join?sid=…&pk=…`
    /// (also the `flagship://join?…` custom-scheme form).
    case joinAccount(sid: String, pk: String)

    /// Parse a `flagship://...` URL (custom scheme) OR a Flagship
    /// UNIVERSAL LINK (`https://flagshipserver.com/join?…`). The custom
    /// scheme mirrors the webapp's `?view=...` router; universal links
    /// are limited to the `/join` pairing path (so an arbitrary https
    /// URL the app receives doesn't become a deep link). Returns nil
    /// for anything we don't recognize.
    public static func parse(_ url: URL) -> DeepLink? {
        // Universal link: only the /join pairing path is honored. The
        // native camera opens this straight into the app via AASA.
        if url.scheme == "https",
           (url.host == "flagshipserver.com" || url.host == "www.flagshipserver.com"),
           url.path == "/join" {
            let params = (URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems ?? [])
                .reduce(into: [String: String]()) { acc, item in
                    if let v = item.value { acc[item.name] = v }
                }
            if let sid = params["sid"], !sid.isEmpty,
               let pk = params["pk"], !pk.isEmpty {
                return .joinAccount(sid: sid, pk: pk)
            }
            return nil
        }
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
            if let id = params["serviceId"] { return .appDetail(serviceId: id) }
        case "marketplace":
            return .marketplace
        case "create-server":
            return .createServer
        case "join":
            // Phase 3b — custom-scheme form of the pairing link.
            if let sid = params["sid"], !sid.isEmpty,
               let pk = params["pk"], !pk.isEmpty {
                return .joinAccount(sid: sid, pk: pk)
            }
            return nil
        case "vibecode":
            // Two URL shapes accepted:
            //   flagship://vibecode/<sessionId>           (path)
            //   flagship://vibecode?sessionId=<sessionId> (query)
            // The push payload uses the path form; we accept either
            // so deep-link tests can use whichever is more readable.
            let pathSession = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if !pathSession.isEmpty {
                return .vibeCodeChat(sessionId: pathSession)
            }
            if let id = params["sessionId"], !id.isEmpty {
                return .vibeCodeChat(sessionId: id)
            }
            return nil
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
