import Foundation
import FlagshipAPI

/// P14 — the `https://webapp.flagshipserver.com/?companion=...` URL shape a
/// companion ticket travels in, plus the pod base URL helper. The webapp's
/// boot-time handler decodes the `companion` query param into the
/// 4-tuple `{ ticketId, ticketSecret, podBaseUrl, username }` and POSTs
/// `/api/companion/redeem` against `podBaseUrl`.
///
/// Wire-shape parity matters here: Android + daemon + webapp all decode
/// the same shape. Field names are byte-identical with the daemon's
/// TypeScript `CompanionTicketEnvelope`.
public enum CompanionTicketURL {
    /// Static landing host the webapp lives at. The browser hits this
    /// URL first; the in-page JS parses the `companion` query param and
    /// redirects + redeems against the user's pod. Via `Endpoints`
    /// (prod-default `webapp.flagshipserver.com` + test override).
    public static var webappHost: String { Endpoints.webappHost }

    public struct Envelope: Codable, Equatable, Sendable {
        public let ticketId: String
        public let ticketSecret: String
        public let podBaseUrl: String
        public let username: String

        public init(ticketId: String, ticketSecret: String, podBaseUrl: String, username: String) {
            self.ticketId = ticketId
            self.ticketSecret = ticketSecret
            self.podBaseUrl = podBaseUrl
            self.username = username
        }
    }

    /// Derive `podBaseUrl` from a `PodInfo.fqdn` value the way the
    /// daemon expects: prefix `https://`, no trailing slash. Kept on
    /// this helper so the call site can't drift from the encoder.
    public static func podBaseUrl(forFqdn fqdn: String) -> String {
        let trimmed = fqdn.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("https://") || trimmed.hasPrefix("http://") {
            return trimmed
        }
        return "https://\(trimmed)"
    }

    /// Base64url-no-padding encoder per RFC 4648 §5.
    static func base64URLNoPadding(_ data: Data) -> String {
        var s = data.base64EncodedString()
        s = s.replacingOccurrences(of: "+", with: "-")
        s = s.replacingOccurrences(of: "/", with: "_")
        while s.hasSuffix("=") { s.removeLast() }
        return s
    }

    /// Companion decoder — re-pads, swaps `-_` back to `+/`, base64-
    /// decodes, then JSON-decodes. Symmetric to `base64URLNoPadding`.
    static func decodeBase64URLNoPadding(_ s: String) -> Data? {
        var t = s
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t.append("=") }
        return Data(base64Encoded: t)
    }

    /// Parse a companion URL into its envelope. Returns nil if the URL
    /// doesn't match the expected shape.
    public static func parse(_ urlString: String) -> Envelope? {
        guard let url = URL(string: urlString),
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let value = comps.queryItems?.first(where: { $0.name == "companion" })?.value,
              let data = decodeBase64URLNoPadding(value),
              let env = try? JSONDecoder().decode(Envelope.self, from: data)
        else { return nil }
        return env
    }
}

/// The QR the remote page (`remote.flagshipserver.com`) shows:
/// `https://flagshipserver.com/remote?s=<sid>&k=<browser X25519 key>` (older
/// pages: `flagship://remote?s=&k=`). It names only a QR-relay session and the
/// browser's ephemeral key, never an account or a server; the phone picks the
/// server and seals a single-use ticket to the browser.
public enum RemoteApprovalLink {
    public static func parse(_ raw: String) -> QrRelay.QrSession? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text), isRemoteUrl(url),
              let session = try? QrRelay.parseQrUrl(text),
              let sid = Base64URL.decode(session.sid), sid.count == 16
        else { return nil }
        return session
    }

    private static func isRemoteUrl(_ url: URL) -> Bool {
        if url.scheme == "flagship" { return url.host == "remote" }
        return DeepLink.isControlHostLink(url) && DeepLink.trimmedPath(url) == "/remote"
    }
}

/// The payload the phone seals to the remote browser: a single-use companion
/// ticket for the server the owner picked. Field names match the webapp's
/// `parseRemoteTicket` (`lib/companionDockStart.js`).
public struct RemoteTicketPayload: Codable, Equatable, Sendable {
    public static let kindTag = "flagship/remote-ticket/v1"
    public let kind: String
    public let ticketId: String
    public let ticketSecret: String
    public let podBaseUrl: String
    public let username: String

    public init(ticketId: String, ticketSecret: String, podBaseUrl: String, username: String) {
        self.kind = Self.kindTag
        self.ticketId = ticketId
        self.ticketSecret = ticketSecret
        self.podBaseUrl = podBaseUrl
        self.username = username
    }
}
