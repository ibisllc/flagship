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
    /// it's POSTed to that box's own redeem endpoint.
    ///
    /// v2: the link ALSO carries the author's stable AID (`a=`) so the friend
    /// derives their PER-AUTHOR contact AID (`deriveContactAccountId`) to present
    /// (NOT the global AID), and — for a manual-approve invite — the `inviteId`
    /// (`iid=`) so the friend can sign the out-of-band acceptance. Both are
    /// OPTIONAL (a v1 bare-secret link still parses; the friend then falls back to
    /// the global AID + can't manual-accept). Reachable two ways:
    ///   - the UNIVERSAL LINK the owner shares,
    ///     `https://<server>.<user>.flagship.services/invite#k=<secret>&a=<authorAID>&iid=<inviteId>`
    ///     (or the bare `#<secret>`), opened by the native browser/AASA, and
    ///   - the `flagship://invite?server=<host>&k=<secret>&a=<authorAID>&iid=<inviteId>`
    ///     custom-scheme form the box's `/invite` page offers as "open in the app".
    case inviteRedeem(serverDomain: String, secretHex: String, authorAidHex: String?, inviteId: String?)

    /// Author-finalize of a MANUAL-approve invite (v2 tier 2). The CONSUMER's app
    /// emits this as a reply link/QR after a pending redeem; the AUTHOR opens it,
    /// looks up the matching `create`+`createSig` in their own `.com` listing, and
    /// POSTs the acceptance to their box. Carries the box host, the inviteId, the
    /// serviceRef, the consumer's contact AID, the acceptance signature, and the
    /// signed `acceptedAt`. Custom-scheme only (it's a private reply, never a
    /// universal link): `flagship://invite-accept?server=&iid=&ref=&aid=&sig=&at=`.
    case inviteAccept(serverDomain: String, inviteId: String, serviceRef: String, contactAidHex: String, acceptSigHex: String, acceptedAt: Int64)

    /// Web-experience gating — QR-login for a restricted service's WEBSITE
    /// (docs/service-access-gating.md, "Web-experience gating"). A plain
    /// browser hitting a restricted service gets a knock page carrying this
    /// deeplink (also a QR for cross-device + a copyable "Get link" string);
    /// THIS phone authorizes it by AID-signing a `KnockAuthorization` bound to
    /// the page. Carries the box `server` fqdn, the URL `svc` label (display
    /// only), the `ref` serviceRef (a `<creator>-<slug>` the box keys its
    /// allow-list on), and the single-use `page` id (the box-minted pageId the
    /// authorization signature binds). Reachable two ways:
    ///   - the box's `flagship://access?server=…&svc=…&ref=…&page=…` deeplink
    ///     (same-device "Access site" button + cross-device QR), and
    ///   - Settings → "Process URL", which pastes either that deeplink OR the
    ///     raw "Get link" string into the same handler.
    case knockAuthorize(serverDomain: String, svc: String, serviceRef: String, pageId: String)

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
            let frag = comps?.fragment
            if let secret = Self.secretFromFragment(frag) {
                return .inviteRedeem(
                    serverDomain: host,
                    secretHex: secret,
                    authorAidHex: Self.hexParamFromFragment(frag, key: "a"),
                    inviteId: Self.hexParamFromFragment(frag, key: "iid"))
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
            // flagship://invite?server=<host>&k=<64hex>&a=<authorAID>&iid=<inviteId>
            // — the "open in app" hand-off from the box's /invite page (a custom
            // scheme can't carry the fragment, so the secret comes as the `k`
            // query). Also accept the secret as the trailing path segment.
            let server = params["server"] ?? params["host"] ?? ""
            let pathSecret = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let candidate = params["k"] ?? params["secret"] ?? pathSecret
            if let secret = Self.secretFromFragment(candidate), !server.isEmpty {
                return .inviteRedeem(
                    serverDomain: server,
                    secretHex: secret,
                    authorAidHex: Self.validHex64(params["a"]),
                    inviteId: Self.validHex(params["iid"]))
            }
            return nil
        case "invite-accept":
            // flagship://invite-accept?server=&iid=&ref=&aid=&sig=&at= — the
            // CONSUMER's manual-approve acceptance reply; THIS phone is the AUTHOR
            // finalizing. server/iid/ref/aid(64hex)/sig(128hex)/at(ms) all required.
            let server = params["server"] ?? params["host"] ?? ""
            let iid = params["iid"] ?? ""
            let ref = params["ref"] ?? ""
            let aid = Self.validHex64(params["aid"])
            let sig = Self.validHex128(params["sig"])
            let at = Int64(params["at"] ?? "")
            if !server.isEmpty, !iid.isEmpty, !ref.isEmpty, let aid, let sig, let at {
                return .inviteAccept(serverDomain: server, inviteId: iid, serviceRef: ref, contactAidHex: aid, acceptSigHex: sig, acceptedAt: at)
            }
            return nil
        case "join":
            // Phase 3b — custom-scheme form of the pairing link.
            if let sid = params["sid"], !sid.isEmpty,
               let pk = params["pk"], !pk.isEmpty {
                return .joinAccount(sid: sid, pk: pk)
            }
            return nil
        case "access":
            // flagship://access?server=<fqdn>&svc=<label>&ref=<serviceRef>&page=<pageId>
            // — the web-experience-gating knock authorization (the box's knock
            // page hands this to a browser; THIS phone authorizes it). `svc` is
            // display-only and may be empty; server/ref/page are required.
            let server = params["server"] ?? params["host"] ?? ""
            let svc = params["svc"] ?? ""
            let ref = params["ref"] ?? ""
            let page = params["page"] ?? ""
            if !server.isEmpty, !ref.isEmpty, !page.isEmpty {
                return .knockAuthorize(serverDomain: server, svc: svc, serviceRef: ref, pageId: page)
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

    /// Pull a `<key>=<hex>` value from a fragment (`#k=…&a=…&iid=…`). Returns the
    /// lowercased hex (any even length) or nil. Used for the v2 `a=` (authorAID)
    /// and `iid=` (inviteId) fragment params on the invite link.
    static func hexParamFromFragment(_ raw: String?, key: String) -> String? {
        guard var s = raw, !s.isEmpty else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        guard let r = s.range(of: "(?:^|[?&])\(key)=([0-9a-fA-F]+)", options: .regularExpression) else { return nil }
        let m = String(s[r])
        guard let eq = m.range(of: "\(key)=") else { return nil }
        let v = String(m[eq.upperBound...]).lowercased()
        return v.count % 2 == 0 ? v : nil
    }

    /// Validate an arbitrary even-length hex param (nil/empty/odd → nil).
    static func validHex(_ raw: String?) -> String? {
        guard let s = raw, !s.isEmpty,
              s.range(of: "^[0-9a-fA-F]+$", options: .regularExpression) != nil,
              s.count % 2 == 0 else { return nil }
        return s.lowercased()
    }
    static func validHex64(_ raw: String?) -> String? {
        guard let s = raw, s.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) != nil else { return nil }
        return s.lowercased()
    }
    static func validHex128(_ raw: String?) -> String? {
        guard let s = raw, s.range(of: "^[0-9a-fA-F]{128}$", options: .regularExpression) != nil else { return nil }
        return s.lowercased()
    }

    /// Parse a pasted "Process URL" string into a DeepLink. The knock page's
    /// "Get link to paste in the app" copies the VERBATIM `flagship://access?…`
    /// deeplink, so a paste is just that URL with possible surrounding
    /// whitespace. Trims, then defers to `parse`. Returns nil for anything we
    /// don't recognize (the Settings field surfaces a "couldn't read that link"
    /// message). Any recognized deeplink shape is accepted, not only `access`.
    public static func parsePastedString(_ raw: String) -> DeepLink? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else { return nil }
        return parse(url)
    }
}

/// Builders for the service-access-gating share links (the inverse of
/// `DeepLink.parse`). Kept here in FlagshipCore so the create screen + the
/// redeem VM build the SAME canonical link shapes the parser accepts.
public enum ServiceInviteLinks {
    /// The friend share-link `https://<server>/invite#k=<secret>&a=<authorAID>[&iid=<inviteId>]`.
    /// v2 carries the author's AID (the friend derives their per-author contact
    /// AID) and — for a manual-approve invite — the inviteId (so the friend can
    /// sign the acceptance). For a v1 bare link pass authorAidHex/inviteId nil →
    /// `…/invite#<secret>`.
    public static func inviteLink(serverDomain: String, secretHex: String, authorAidHex: String? = nil, inviteId: String? = nil) -> String {
        let host = serverDomain.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        let s = secretHex.lowercased()
        guard authorAidHex != nil || inviteId != nil else {
            return "https://\(host)/invite#\(s)"
        }
        var frag = "k=\(s)"
        if let a = authorAidHex { frag += "&a=\(a.lowercased())" }
        if let iid = inviteId { frag += "&iid=\(iid.lowercased())" }
        return "https://\(host)/invite#\(frag)"
    }

    /// The CONSUMER's manual-approve acceptance REPLY link (a private channel —
    /// custom scheme only): `flagship://invite-accept?server=&iid=&ref=&aid=&sig=&at=`.
    /// The author opens it to finalize the bind.
    public static func acceptReplyLink(serverDomain: String, inviteId: String, serviceRef: String, contactAidHex: String, acceptSigHex: String, acceptedAt: Int64) -> String? {
        func esc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s }
        let host = serverDomain.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        guard !host.isEmpty, !inviteId.isEmpty, !serviceRef.isEmpty else { return nil }
        return "flagship://invite-accept?server=\(esc(host))&iid=\(esc(inviteId))&ref=\(esc(serviceRef))&aid=\(contactAidHex.lowercased())&sig=\(acceptSigHex.lowercased())&at=\(acceptedAt)"
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
