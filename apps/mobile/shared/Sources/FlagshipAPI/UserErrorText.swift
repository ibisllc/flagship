import Foundation

/// The one place a failure becomes a sentence a person reads.
///
/// Every screen that shows an error from `.com` or a box goes through `of`
/// (a thrown error) or `ofRaw` (text a view model, a box or a progress report
/// already stored). Nothing here lets a transport string ("connection closed",
/// "unable to resolve host"), an HTTP status line ("HTTP 503: error code:
/// 1102"), a Cloudflare error code, a Foundation "NSURLErrorDomain" line or a
/// shell line number reach the screen.
///
/// A message somebody wrote for people (a box's own sentence, a view model's
/// "Pick a name first.") passes through unchanged. Mirrors Android's
/// `UserErrorText`.
public enum UserErrorText {

    public static let offline = String(localized: "Couldn't reach the server. Check your connection and try again.")
    public static let dropped = String(localized: "The connection dropped. Try again.")
    public static let timeout = String(localized: "That took too long. Check your connection and try again.")
    public static let serverProblem = String(localized: "Service temporarily unavailable. Try again in a few minutes.")
    /// The phone could not look up the server's address. It is not "can't reach
    /// the server": the connection is fine, a router has just cached the miss.
    public static let nameLookup =
        String(localized: "Your phone can't find this server's address yet. This usually clears within a few minutes. Try again.")
    public static let refused = String(localized: "We couldn't complete that. Try again.")
    public static let generic = String(localized: "Something went wrong. Try again.")

    /// `.com` reasons written for developers, and what to say instead.
    private static let knownReasons: [(pattern: String, sentence: String)] = [
        ("subdomain already controlled by a different rck",
         String(localized: "That name is still held by an earlier, unfinished order. Cancel that order from Home, or choose another name.")),
        ("^stale request",
         String(localized: "This phone's clock looks off. Check the date and time, then try again.")),
        ("^invalid signature",
         String(localized: "Your account key didn't match. Try again, or sign in again.")),
        ("^not authorized",
         String(localized: "This device isn't allowed to do that.")),
    ]

    /// Text that is a runtime artefact rather than a sentence.
    private static let rawMarkers =
        String(localized: "(^HTTP\\s*\\d{3}|\\bexception\\b|nsurlerrordomain|nsposixerrordomain|kcferror|error domain=|\\buserinfo=|\\bcode=-?\\d+|\\bswift\\.|\\boptional\\(|\\bhandshake|\\berrno|\\beconn|\\bsocket\\b|unexpected end of stream|\\bEOF\\b|broken pipe|error code:? ?\\d+|^[\\[{<]|unexpected json|could not parse|stacktrace|\\bnil\\b|\\(null\\)|couldn.t be completed|\\bdecodingerror|\\bkeynotfound)")

    // MARK: - Public

    /// The sentence for a thrown error. `fallback` replaces the generic
    /// sentence when nothing better is known.
    public static func of(_ error: Error, fallback: String? = nil) -> String {
        if let e = error as? ScreensClientError { return e.errorDescription ?? (fallback ?? generic) }
        if let e = error as? FreeAiError, let d = e.errorDescription { return d }
        if error is CancellationError { return dropped }
        if let u = error as? URLError { return forURLError(u) }
        if error is DecodingError { return String(localized: "Something came back we couldn't read. Try again in a moment.") }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            return forURLError(URLError(URLError.Code(rawValue: ns.code)))
        }
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError, underlying.domain == NSURLErrorDomain {
            return of(underlying, fallback: fallback)
        }
        if ns.domain == NSPOSIXErrorDomain {
            switch Int32(ns.code) {
            case ETIMEDOUT: return timeout
            case ECONNRESET, EPIPE, ECONNABORTED, ENOTCONN: return dropped
            default: return offline
            }
        }
        let text = (error as? LocalizedError)?.errorDescription ?? ns.localizedDescription
        return ofRaw(text, fallback: fallback)
    }

    /// The sentence for text that was stored from a failure: authored text
    /// stays (minus any line number), anything raw becomes `fallback`.
    public static func ofRaw(_ raw: String?, fallback: String? = nil) -> String {
        let text = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return fallback ?? generic }
        if let status = statusFromText(text) {
            return forStatus(status, body: String(text.drop(while: { $0 != ":" }).dropFirst()), fallback: fallback)
        }
        if looksAuthored(text), let f = text.first, f.isUppercase, ".!?".contains(text.last!) {
            return stripInternals(text)
        }
        let lower = text.lowercased()
        if lower.contains("timed out") || lower.contains("timeout") { return timeout }
        if ["unable to resolve", "unknownhost", "unknown host", "could not resolve", "hostname could not be found",
            "failed to connect", "could not connect to the server", "no address associated",
            "appears to be offline", "not connected to the internet", "cannot find host", "cannot connect to host"]
            .contains(where: lower.contains) { return offline }
        if ["closed", "connection reset", "connection lost", "connection was lost", "unexpected end of stream",
            "broken pipe", "software caused"].contains(where: lower.contains) || lower == "eof" { return dropped }
        if looksAuthored(text) { return stripInternals(text) }
        return fallback ?? generic
    }

    /// The sentence in a refused call's `{"error": "..."}` body, when it is one
    /// a person can read (capitalised, ends like a sentence) or a known reason.
    public static func boxSentence(_ body: String) -> String? {
        var raw = body.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.hasPrefix(":") { raw.removeFirst(); raw = raw.trimmingCharacters(in: .whitespacesAndNewlines) }
        var text: String?
        if let data = raw.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            text = ["error", "message"].lazy.compactMap { obj[$0] as? String }.first
        } else if !raw.hasPrefix("{"), !raw.hasPrefix("<") {
            text = raw
        }
        guard let t = text?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        if let known = knownReasons.first(where: { t.range(of: $0.pattern, options: [.regularExpression, .caseInsensitive]) != nil }) {
            return known.sentence
        }
        guard let first = t.first, first.isUppercase, ".!?".contains(t.last!), looksAuthored(t) else { return nil }
        return stripInternals(t)
    }

    /// `message` without a shell or source line number ("... (line 66)").
    public static func stripInternals(_ message: String) -> String {
        var s = message.replacingOccurrences(
            of: "\\s*[(\\[]?\\b(at )?lines? ?\\d+[)\\]]?", with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        s = s.replacingOccurrences(of: "\\s{2,}", with: " ", options: .regularExpression)
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        while let l = s.last, ",:;".contains(l) { s.removeLast() }
        return s
    }

    /// True when `text` carries a runtime artefact (an HTTP status line, a
    /// Cloudflare code, a JSON or HTML body, a Foundation domain line).
    public static func isRawArtefact(_ text: String) -> Bool {
        text.range(of: rawMarkers, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// True when `text` reads as a sentence written for people.
    public static func looksAuthored(_ text: String) -> Bool {
        text.count >= 4 && text.contains(" ")
            && text.range(of: rawMarkers, options: [.regularExpression, .caseInsensitive]) == nil
    }

    /// Status copy for a refused call; a readable box sentence wins over it.
    public static func forStatus(_ status: Int, body: String, fallback: String? = nil) -> String {
        if status >= 500 { return serverProblem }
        if status == 408 { return timeout }
        if let sentence = boxSentence(body) { return sentence }
        return fallback ?? ScreensClientError.plainLanguage(forStatus: status)
    }

    // MARK: - Private

    private static func statusFromText(_ text: String) -> Int? {
        guard let r = text.range(of: "^HTTP\\s*(\\d{3})", options: [.regularExpression, .caseInsensitive]) else { return nil }
        return Int(text[r].filter(\.isNumber))
    }

    private static func forURLError(_ e: URLError) -> String {
        switch e.code {
        case .timedOut: return timeout
        case .networkConnectionLost: return dropped
        case .badServerResponse, .zeroByteResource, .cannotParseResponse:
            return String(localized: "The server had a temporary problem. Please try again in a moment.")
        case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff:
            return String(localized: "You're offline. Check your connection and try again.")
        case .cannotFindHost, .dnsLookupFailed:
            return nameLookup
        default: return offline
        }
    }
}
