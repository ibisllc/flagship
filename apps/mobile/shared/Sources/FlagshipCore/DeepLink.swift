import Foundation
import FlagshipAPI

/// In-app routes that can be triggered from outside the running view
/// tree — Web Push notification tap, custom URL scheme, Universal
/// Link, share-extension, etc. The shell observes `DeepLinker.pending`
/// and pushes the right destination on the right tab.
public enum DeepLink: Equatable, Sendable {
    /// Phone-as-unlock-endpoint RELAY approval list (the sealed-key flow).
    /// Fired by the `secret-request` push when a box is finishing setup /
    /// rebooting in "approve" mode and needs the phone to release its boot
    /// secret. Also the target of the Siri/Shortcuts "Approve unlock" intent.
    case secretRequests
    case serverDetail(podId: String)
    case appDetail(serviceId: String)
    case createServer
    /// Open the recovery-setup flow on the Settings tab. Triggered
    /// in-app from the Home nudge (B9). Not parseable from a URL —
    /// it's an internal-only deep link.
    case recoverySetup
    /// W10 — open the vibe-code chat surface for the given session
    /// id. Fired by the `vibecode-needs-you` push when the AI is
    /// awaiting an env-var or talkToUser response.
    case vibeCodeChat(sessionId: String)
    /// Open the "build a service" (vibe-code) flow on the Services tab.
    /// Triggered in-app from the Home quick action. Internal-only —
    /// not parseable from a URL.
    case startVibeCode

    /// Phase 3b — cross-device pairing join. Carries the relay session
    /// id + the admin's ephemeral X25519 public key (base64url) from a
    /// scanned/deep-linked pairing QR. Routes into the add-profile
    /// pairing flow (the incoming/collaborator side). Reachable two
    /// ways: the in-app scanner, OR the native camera opening the
    /// UNIVERSAL LINK `https://flagshipserver.com/join?sid=…&pk=…`
    /// (also the `flagship://join?…` custom-scheme form).
    case joinAccount(sid: String, pk: String)

    /// #92 — friend redeem of a service-access capability invite
    /// (docs/service-access-gating.md). Carries the BOX host the `/invite`
    /// link was served from + the 32-byte capability secret (64-hex). The
    /// secret lives ONLY in the link fragment and is NEVER sent to `.com`;
    /// it's POSTed to that box's own redeem endpoint. Reachable two ways:
    ///   - the UNIVERSAL LINK the owner shares,
    ///     `https://<server>.<user>.flagship.services/invite#<secret>` (or
    ///     `#k=<secret>`), opened by the native browser/AASA, and
    ///   - the `flagship://invite?server=<host>&k=<secret>` custom-scheme
    ///     form the box's `/invite` page offers as "open in the app" (the
    ///     fragment can't ride a custom scheme reliably, so it's a query).
    case inviteRedeem(serverDomain: String, secretHex: String)

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
           (url.host == Endpoints.controlHost || url.host == "www.\(Endpoints.controlHost)"),
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
        // Universal link: a service-access invite served from a BOX —
        // `https://<server>.<user>.flagship.services/invite#<secret>`. The
        // host must live under the data-plane apex (a box), the path must be
        // `/invite`, and the secret rides the FRAGMENT (never sent to .com).
        if url.scheme == "https",
           let host = url.host,
           host.hasSuffix(".\(Endpoints.dataApex)"),
           url.path == "/invite" || url.path == "/invite/" {
            let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
            if let secret = Self.secretFromFragment(comps?.fragment) {
                return .inviteRedeem(serverDomain: host, secretHex: secret)
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
        case "secret-requests", "secret-request",
             // Back-compat: old `unlock-approve(s)` links now land on the
             // relay approval list (the legacy plaintext flow is gone).
             "unlock-approve", "unlock-approvals":
            return .secretRequests
        case "server":
            if let id = params["podId"] { return .serverDetail(podId: id) }
        case "app":
            if let id = params["serviceId"] { return .appDetail(serviceId: id) }
        case "create-server":
            return .createServer
        case "invite":
            // flagship://invite?server=<host>&k=<64hex> — the "open in app"
            // hand-off from the box's /invite page (a custom scheme can't carry
            // the fragment, so the secret comes as the `k` query). Also accept
            // the secret as the trailing path segment.
            let server = params["server"] ?? params["host"] ?? ""
            let pathSecret = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let candidate = params["k"] ?? params["secret"] ?? pathSecret
            if let secret = Self.secretFromFragment(candidate), !server.isEmpty {
                return .inviteRedeem(serverDomain: server, secretHex: secret)
            }
            return nil
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

    /// Pull a 64-hex capability secret from a fragment / candidate string.
    /// Accepts a bare `<64hex>` or the `k=<64hex>` form (mirrors the webapp's
    /// `inviteSecretFromLocation`). Returns the lowercased hex or nil.
    static func secretFromFragment(_ raw: String?) -> String? {
        guard var s = raw, !s.isEmpty else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        // `k=<hex>` (optionally amid other params) or a bare hex.
        if let r = s.range(of: "(?:^|[?&])k=([0-9a-fA-F]{64})", options: .regularExpression) {
            let m = String(s[r])
            if let eq = m.range(of: "k=") {
                return String(m[eq.upperBound...]).lowercased()
            }
        }
        if s.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) != nil {
            return s.lowercased()
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
