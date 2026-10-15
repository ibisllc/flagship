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
    /// An app's page talking to one particular server (a row on that server's
    /// page). Internal-only.
    case appDetailOnServer(serviceId: String, serverFqdn: String)
    /// "Create app here" on a server's page: the creation flow, pinned to
    /// that server (docs/app-placement.md §2). Internal-only.
    case createAppOnServer(serverFqdn: String)

    /// Phase 3b — cross-device pairing join. Carries the relay session
    /// id + the admin's ephemeral X25519 public key (base64url) from a
    /// scanned/deep-linked pairing QR. Routes into the add-profile
    /// pairing flow (the incoming/collaborator side). Reachable two
    /// ways: the in-app scanner, OR the native camera opening the
    /// UNIVERSAL LINK `https://flagshipserver.com/join?sid=…&pk=…`
    /// (also the `flagship://join?…` custom-scheme form).
    case joinAccount(sid: String, pk: String)

    /// The remote page's QR, `https://flagshipserver.com/remote?s=<sid>&k=<browser key>`
    /// (older pages: `flagship://remote?s=&k=`): a QR-relay session the phone
    /// joins to seal a ticket to that browser.
    case companionDockApproval(link: String)

    /// Flagship Studio's pairing QR, `https://flagshipserver.com/builder?c=<code>&k=<pk>`
    /// (older Studio builds: `flagship://builder?c=&k=`). Opens the create-server
    /// flow, which pairs with that Studio once the server is designed.
    case builderPair(link: String)

    /// #92 — friend redeem of a service-access capability invite
    /// (docs/service-access-gating.md). Carries the BOX host the `/invite`
    /// link was served from + the 32-byte capability secret (64-hex). The
    /// secret lives ONLY in the link fragment and is NEVER sent to `.com`;
    /// it's POSTed to that box's own redeem endpoint.
    ///
    /// The link ALSO carries the author's stable AID (`a=`, which marks the box
    /// as one we were invited to), for a manual-approve invite the `inviteId`
    /// (`i=`, to sign the acceptance), and the app (`s=`): the friend presents
    /// their id for THAT app (`deriveAppAccountId`), never the global AID. A link
    /// without `s=` still parses but can't be redeemed (ask for a new one). The
    /// canonical fragment is the BARE secret followed by `&a=`/`&i=`/`&s=`
    /// (identical across webapp/iOS/Android).
    /// Reachable two ways:
    ///   - the UNIVERSAL LINK the owner shares,
    ///     `https://<server>.<user>.flagship.services/invite#<secret>&a=<authorAID>&i=<inviteId>`
    ///     (or the bare `#<secret>`), opened by the native browser/AASA, and
    ///   - the `flagship://invite?server=<host>&k=<secret>&a=<authorAID>&i=<inviteId>`
    ///     custom-scheme form the box's `/invite` page offers as "open in the app"
    ///     (a custom scheme can't carry a fragment, so the secret rides `k=` there).
    case inviteRedeem(serverDomain: String, secretHex: String, authorAidHex: String?, inviteId: String?, serviceRef: String? = nil)

    /// Author-finalize of a MANUAL-approve invite (v2 tier 2). The CONSUMER's app
    /// emits this as a reply link/QR after a pending redeem; the AUTHOR opens it,
    /// looks up the matching `create`+`createSig` in their own `.com` listing, and
    /// POSTs the acceptance to their box. Carries the box host, the inviteId, the
    /// serviceRef, the consumer's contact AID, the acceptance signature, and the
    /// signed `acceptedAt`:
    /// `https://flagshipserver.com/invite-accept#server=&iid=&ref=&aid=&sig=&at=`
    /// (the fragment never reaches `.com`; earlier links used `?…`, older apps
    /// `flagship://invite-accept?…`).
    case inviteAccept(serverDomain: String, inviteId: String, serviceRef: String, contactAidHex: String, acceptSigHex: String, acceptedAt: Int64)

    /// Web-experience gating — QR-login for a restricted service's WEBSITE
    /// (docs/service-access-gating.md, "Web-experience gating"). A plain
    /// browser hitting a restricted service gets a knock page carrying this
    /// deeplink (also a QR for cross-device + a copyable "Get link" string);
    /// THIS phone authorizes it by AID-signing a `KnockAuthorization` bound to
    /// the page. Carries the box `server` fqdn, the URL `svc` label (display
    /// only), the `ref` serviceRef (a `<creator>--<slug>` the box keys its
    /// allow-list on), and the single-use `page` id (the box-minted pageId the
    /// authorization signature binds). Reachable two ways:
    ///   - the box's `https://flagshipserver.com/access#server=…&svc=…&ref=…&page=…`
    ///     link (the fragment never reaches `.com`; older boxes: `/access?…` or
    ///     `flagship://access?…`), as the same-device "Access
    ///     site" button and the cross-device QR, and
    ///   - Settings → "Process URL", which pastes either that deeplink OR the
    ///     raw "Get link" string into the same handler.
    case knockAuthorize(serverDomain: String, svc: String, serviceRef: String, pageId: String)

    /// Slice C — take over a transferred box. Carries the giver's IRK-signed
    /// transfer OFFER as its JSON (the same bytes the in-app scanner parses).
    /// Reachable two ways, both carrying the offer in the `o=` QUERY param (NOT
    /// the `#fragment`, which Android/webapp strip) as `base64url(offerJSON)`:
    ///   - the UNIVERSAL LINK the giver shows,
    ///     `https://flagshipserver.com/transfer?o=<b64url>`, opened by the native
    ///     Camera/AASA, and
    ///   - the `flagship://transfer?o=<b64url>` custom-scheme twin.
    /// The offer is a signed NON-secret, so `.com` seeing it is acceptable; the
    /// acquirer still MUST verify the offer signature + expiry before any claim.
    case transferOffer(offerJSON: String)

    /// Share this server (docs/share-a-server.md §5.1): another account's link,
    /// `https://<apex>/share#s=<shareId>&k=<secret>` or `flagship://share?s=&k=`.
    /// The secret stays in the fragment, so `.com` never sees it.
    case shareServer(shareId: String, secretHex: String)

    /// Home's "Shared with me": a server shared with this account is waiting
    /// to start (the `share-start-up` push names no server). Internal-only.
    case sharedWithMe

    /// Settings → Account security (two-factor, recovery codes). The
    /// `account/security` (certificate watch) and `settings/two-factor`
    /// (failed codes) pushes. Their `u=` names the account; the screen
    /// opens for the active one.
    case accountSecurity

    /// Settings, which lists this account's devices and any pending re-pair:
    /// the `account/devices` (quarantined device) and `account/re-pair` pushes.
    case accountDevices

    /// An in-app destination as an https app link,
    /// `https://<controlHost>/app/<route>[?query]`: the form every producer
    /// emits, routed exactly like the legacy `flagship://<route>[?query]`.
    public static func appRouteURL(_ route: String, query: KeyValuePairs<String, String> = [:]) -> URL {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+#?")
        let q = query
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0.value)" }
            .joined(separator: "&")
        return URL(string: "https://\(Endpoints.controlHost)/app/\(route)\(q.isEmpty ? "" : "?\(q)")")!
    }

    /// The legacy custom-scheme twin of an `/app/<route>` link on the control
    /// host (path, query and fragment kept), or nil for any other URL.
    static func legacyForm(ofAppRoute url: URL) -> URL? {
        guard isControlHostLink(url),
              var comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              comps.percentEncodedPath.hasPrefix("/app/") else { return nil }
        let rest = comps.percentEncodedPath.dropFirst("/app/".count)
        let route = rest.prefix { $0 != "/" }
        guard !route.isEmpty,
              route.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else { return nil }
        comps.scheme = "flagship"
        comps.user = nil
        comps.password = nil
        comps.port = nil
        comps.host = String(route)
        comps.percentEncodedPath = String(rest.dropFirst(route.count))
        return comps.url
    }

    /// Parse a `flagship://...` URL (custom scheme) OR a Flagship
    /// UNIVERSAL LINK (`https://flagshipserver.com/join?…`). The custom
    /// scheme mirrors the webapp's `?view=...` router; universal links
    /// are limited to a fixed set of paths on the control host (so an
    /// arbitrary https URL the app receives doesn't become a deep link).
    /// Returns nil for anything we don't recognize.
    public static func parse(_ url: URL) -> DeepLink? {
        if let legacy = legacyForm(ofAppRoute: url) { return parse(legacy) }
        if isControlHostLink(url) {
            switch trimmedPath(url) {
            case "/remote":   return remoteLink(url)
            case "/builder":  return builderLink(url)
            case "/access":   return accessLink(fragmentOrQueryParams(url))
            case "/invite-accept": return inviteAcceptLink(fragmentOrQueryParams(url))
            default: break
            }
        }
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
        // Universal link: Slice C transfer take-over —
        // `https://flagshipserver.com/transfer?o=<b64url>`. The offer JSON rides
        // the `o=` QUERY param (base64url, no padding) so Android/webapp don't
        // strip it the way a #fragment would. The native camera opens this.
        if url.scheme == "https",
           (url.host == Endpoints.controlHost || url.host == "www.\(Endpoints.controlHost)"),
           url.path == ServerTransferFlow.transferLinkPath {
            let params = (URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems ?? [])
                .reduce(into: [String: String]()) { acc, item in
                    if let v = item.value { acc[item.name] = v }
                }
            if let o = params[ServerTransferFlow.transferLinkParam],
               let json = ServerTransferFlow.decodeOfferParam(o) {
                return .transferOffer(offerJSON: json)
            }
            return nil
        }
        if url.scheme == "https",
           (url.host == Endpoints.controlHost || url.host == "www.\(Endpoints.controlHost)"),
           url.path == "/share" {
            guard let parts = ServerShare.parseShareLink(url.absoluteString) else { return nil }
            return .shareServer(shareId: parts.shareId, secretHex: parts.secretHex)
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
                    // Canonical `i=`; tolerate the legacy `iid=` for in-flight links.
                    inviteId: Self.hexParamFromFragment(frag, key: "i")
                        ?? Self.hexParamFromFragment(frag, key: "iid"),
                    serviceRef: Self.appRefFromFragment(frag))
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
            // flagship://invite?server=<host>&k=<64hex>&a=<authorAID>&i=<inviteId>
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
                    // Canonical `i=`; tolerate the legacy `iid=` for in-flight links.
                    inviteId: Self.validHex(params["i"]) ?? Self.validHex(params["iid"]),
                    serviceRef: params["s"].flatMap { ServiceInvite.isAppRef($0) ? $0 : nil })
            }
            return nil
        case "invite-accept":
            return inviteAcceptLink(params)
        case "join":
            // Phase 3b — custom-scheme form of the pairing link.
            if let sid = params["sid"], !sid.isEmpty,
               let pk = params["pk"], !pk.isEmpty {
                return .joinAccount(sid: sid, pk: pk)
            }
            return nil
        case "remote":
            return remoteLink(url)
        case "builder":
            return builderLink(url)
        case "transfer":
            // Slice C — custom-scheme twin of the transfer take-over link:
            // flagship://transfer?o=<b64url(offerJSON)>.
            if let o = params[ServerTransferFlow.transferLinkParam],
               let json = ServerTransferFlow.decodeOfferParam(o) {
                return .transferOffer(offerJSON: json)
            }
            return nil
        case "share":
            guard let parts = ServerShare.parseShareLink(url.absoluteString) else { return nil }
            return .shareServer(shareId: parts.shareId, secretHex: parts.secretHex)
        case "access":
            return accessLink(params)
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
        case "account":
            switch url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) {
            case "security": return .accountSecurity
            case "devices", "re-pair": return .accountDevices
            default: return nil
            }
        case "settings":
            return url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == "two-factor"
                ? .accountSecurity : nil
        case "install-progress":
            // The provision-status push names no server in its link; the
            // create flow is where a phone follows an install.
            return .createServer
        default:
            break
        }
        return nil
    }

    static func isControlHostLink(_ url: URL) -> Bool {
        url.scheme == "https"
            && (url.host == Endpoints.controlHost || url.host == "www.\(Endpoints.controlHost)")
    }

    static func trimmedPath(_ url: URL) -> String {
        let path = url.path
        return path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
    }

    static func queryParams(_ url: URL) -> [String: String] {
        (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [])
            .reduce(into: [String: String]()) { acc, item in
                if let v = item.value { acc[item.name] = v }
            }
    }

    /// `#k=v&…` read the way `URLSearchParams` writes it (`+` is a space).
    static func fragmentParams(_ url: URL) -> [String: String] {
        guard let frag = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedFragment,
              !frag.isEmpty else { return [:] }
        func decode(_ s: Substring) -> String {
            let spaced = s.replacingOccurrences(of: "+", with: " ")
            return spaced.removingPercentEncoding ?? spaced
        }
        var out: [String: String] = [:]
        for pair in frag.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let k = kv.first, !k.isEmpty else { continue }
            out[decode(k)] = kv.count > 1 ? decode(kv[1]) : ""
        }
        return out
    }

    /// The `/access` and `/invite-accept` links carry their params in the
    /// fragment, which a browser never sends to the control host. Links
    /// minted before that carry them in the query.
    static func fragmentOrQueryParams(_ url: URL) -> [String: String] {
        let frag = fragmentParams(url)
        return frag.isEmpty ? queryParams(url) : frag
    }

    private static func remoteLink(_ url: URL) -> DeepLink? {
        RemoteApprovalLink.parse(url.absoluteString) != nil
            ? .companionDockApproval(link: url.absoluteString) : nil
    }

    private static func builderLink(_ url: URL) -> DeepLink? {
        BuilderPairing.looksLikeBuilderCode(url.absoluteString)
            ? .builderPair(link: url.absoluteString) : nil
    }

    /// The knock authorization (`access#server=<fqdn>&svc=<label>&ref=<serviceRef>&page=<pageId>`):
    /// the box's knock page hands it to a browser and THIS phone authorizes it.
    /// `svc` is display-only and may be empty; server/ref/page are required.
    private static func accessLink(_ params: [String: String]) -> DeepLink? {
        let server = params["server"] ?? params["host"] ?? ""
        let svc = params["svc"] ?? ""
        let ref = params["ref"] ?? ""
        let page = params["page"] ?? ""
        guard !server.isEmpty, !ref.isEmpty, !page.isEmpty else { return nil }
        return .knockAuthorize(serverDomain: server, svc: svc, serviceRef: ref, pageId: page)
    }

    /// The CONSUMER's manual-approve acceptance reply; THIS phone is the AUTHOR
    /// finalizing. server/iid/ref/aid(64hex)/sig(128hex)/at(ms) all required.
    private static func inviteAcceptLink(_ params: [String: String]) -> DeepLink? {
        let server = params["server"] ?? params["host"] ?? ""
        let iid = params["iid"] ?? ""
        let ref = params["ref"] ?? ""
        guard !server.isEmpty, !iid.isEmpty, !ref.isEmpty,
              let aid = validHex64(params["aid"]),
              let sig = validHex128(params["sig"]),
              let at = Int64(params["at"] ?? "") else { return nil }
        return .inviteAccept(serverDomain: server, inviteId: iid, serviceRef: ref, contactAidHex: aid, acceptSigHex: sig, acceptedAt: at)
    }

    /// Pull a 64-hex capability secret from a fragment / candidate string.
    /// Accepts the canonical BARE leading secret (`<64hex>` or `<64hex>&…`) or
    /// the legacy `k=<64hex>` form (mirrors the webapp's
    /// `inviteContextFromLocation`). Returns the lowercased hex or nil.
    static func secretFromFragment(_ raw: String?) -> String? {
        guard var s = raw, !s.isEmpty else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        // Canonical: a bare secret as the LEADING token (`<secret>` or `<secret>&…`).
        if let r = s.range(of: "^([0-9a-fA-F]{64})(?:&|$)", options: .regularExpression) {
            return String(s[r].prefix(64)).lowercased()
        }
        // Legacy `k=<hex>` (optionally amid other params).
        if s.range(of: "(?:^|[?&])k=([0-9a-fA-F]{64})", options: .regularExpression) != nil,
           let kr = s.range(of: "(?:^|[?&])k=", options: .regularExpression) {
            let after = String(s[kr.upperBound...])
            return String(after.prefix(64)).lowercased()
        }
        return nil
    }

    /// Pull a `<key>=<hex>` value from a fragment (`#<secret>&a=…&i=…`). Returns
    /// the lowercased hex (any even length) or nil. Used for the v2 `a=` (authorAID)
    /// and `i=` (inviteId) fragment params on the invite link.
    static func hexParamFromFragment(_ raw: String?, key: String) -> String? {
        guard var s = raw, !s.isEmpty else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        guard let r = s.range(of: "(?:^|[?&])\(key)=([0-9a-fA-F]+)", options: .regularExpression) else { return nil }
        let m = String(s[r])
        guard let eq = m.range(of: "\(key)=") else { return nil }
        let v = String(m[eq.upperBound...]).lowercased()
        return v.count % 2 == 0 ? v : nil
    }

    /// The app (`s=<service id>`) an invite link's fragment names, or nil.
    static func appRefFromFragment(_ raw: String?) -> String? {
        guard var s = raw, !s.isEmpty else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        for part in s.split(separator: "&") where part.hasPrefix("s=") {
            let v = String(part.dropFirst(2))
            return ServiceInvite.isAppRef(v) ? v : nil
        }
        return nil
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
    /// "Get link to paste in the app" copies the VERBATIM `access` link
    /// (https, or `flagship://access?…` from older boxes), so a paste is just that URL with possible surrounding
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
    /// The friend share-link `https://<server>/invite#<secret>&a=<authorAID>[&i=<inviteId>]&s=<serviceRef>`.
    /// The secret is the BARE leading token (canonical cross-client format — no
    /// `k=` prefix; matches webapp + Android). v2 carries the author's AID (the
    /// friend derives their per-author contact AID) and — for a manual-approve
    /// invite — the inviteId (`i=`, so the friend can sign the acceptance). For a
    /// v1 bare link pass authorAidHex/inviteId nil → `…/invite#<secret>`.
    public static func inviteLink(serverDomain: String, secretHex: String, authorAidHex: String? = nil, inviteId: String? = nil,
                                  serviceRef: String? = nil) -> String {
        let host = serverDomain.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        let s = secretHex.lowercased()
        guard authorAidHex != nil || inviteId != nil || serviceRef != nil else {
            return "https://\(host)/invite#\(s)"
        }
        var frag = s
        if let a = authorAidHex { frag += "&a=\(a.lowercased())" }
        if let iid = inviteId { frag += "&i=\(iid.lowercased())" }
        // `s=` names the app: the friend redeems with their id for it.
        if let ref = serviceRef { frag += "&s=\(ref)" }
        return "https://\(host)/invite#\(frag)"
    }

    /// The CONSUMER's manual-approve acceptance REPLY link:
    /// `https://flagshipserver.com/invite-accept#server=&iid=&ref=&aid=&sig=&at=`.
    /// The author opens it to finalize the bind; the fragment keeps the
    /// server, app and signature from `.com` when it opens in a browser.
    public static func acceptReplyLink(serverDomain: String, inviteId: String, serviceRef: String, contactAidHex: String, acceptSigHex: String, acceptedAt: Int64) -> String? {
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        func esc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? s }
        let host = serverDomain.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        guard !host.isEmpty, !inviteId.isEmpty, !serviceRef.isEmpty else { return nil }
        return "https://\(Endpoints.controlHost)/invite-accept#server=\(esc(host))&iid=\(esc(inviteId))&ref=\(esc(serviceRef))&aid=\(contactAidHex.lowercased())&sig=\(acceptSigHex.lowercased())&at=\(acceptedAt)"
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

    private static weak var current: DeepLinker?
    private static var undelivered: DeepLink?

    /// Make this the linker `deliver(_:)` feeds (the shell's), handing it any
    /// link that arrived before it existed.
    public func makeCurrent() {
        Self.current = self
        if let link = Self.undelivered {
            Self.undelivered = nil
            enqueue(link)
        }
    }

    /// Route a destination in-process from code with no view environment
    /// (App Intents). Opening an https app link from inside the app could
    /// land in Safari instead.
    public static func deliver(_ link: DeepLink) {
        if let current { current.enqueue(link) } else { undelivered = link }
    }
    public func consume() -> DeepLink? {
        let p = pending
        pending = nil
        return p
    }
}
