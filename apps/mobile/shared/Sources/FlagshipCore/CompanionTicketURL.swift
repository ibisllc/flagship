import Foundation
import FlagshipAPI

/// P14 — builds the `https://webapp.flagshipserver.com/?companion=...` URL
/// the phone QR encodes. The desktop browser scans the QR, the webapp's
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

    /// Encode the 4-tuple into the canonical
    /// `https://webapp.flagshipserver.com/?companion=<b64url>` URL string.
    /// Returns nil only if the JSON encode itself fails — every other
    /// path is total.
    public static func build(
        ticketId: String,
        ticketSecret: String,
        podBaseUrl: String,
        username: String
    ) -> String? {
        let env = Envelope(
            ticketId: ticketId,
            ticketSecret: ticketSecret,
            podBaseUrl: podBaseUrl,
            username: username
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let json = try? encoder.encode(env) else { return nil }
        let b64 = base64URLNoPadding(json)
        var comps = URLComponents()
        comps.scheme = "https"
        comps.host = webappHost
        comps.path = "/"
        comps.queryItems = [URLQueryItem(name: "companion", value: b64)]
        return comps.url?.absoluteString
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

    /// Parse a built URL back into its envelope. Used by the round-trip
    /// test + (later) by any in-app handler that wants to inspect a
    /// companion URL it generated. Returns nil if the URL doesn't match
    /// the expected shape.
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

public enum CompanionDockApprovalLink {
    public struct Payload: Equatable, Sendable {
        public let serverDomain: String
        public let requestId: String
        public let approvalSecret: String

        public init(serverDomain: String, requestId: String, approvalSecret: String) {
            self.serverDomain = serverDomain
            self.requestId = requestId
            self.approvalSecret = approvalSecret
        }
    }

    /// Accepted deep-link hosts. `remote` is the current label (the feature
    /// was renamed from "dock" on 2026-07-23); `dock` stays accepted so a
    /// browser still serving the pre-rename webapp keeps working against a
    /// freshly built app. The payload is identical either way.
    static let acceptedHosts: Set<String> = ["remote", "dock"]

    public static func parse(_ raw: String) -> Payload? {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "flagship",
              let host = url.host, acceptedHosts.contains(host),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }
        let params = (components.queryItems ?? []).reduce(into: [String: String]()) { out, item in
            if let value = item.value { out[item.name] = value }
        }
        guard let server = params["server"]?.lowercased(),
              server.hasSuffix(".\(Endpoints.dataApex)"),
              let requestId = params["request"]?.lowercased(),
              requestId.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
              let secret = params["code"]?.lowercased(),
              secret.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
        else { return nil }
        return Payload(serverDomain: server, requestId: requestId, approvalSecret: secret)
    }
}
