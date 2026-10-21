import Foundation

/// `.com`'s rate-limit refusal: HTTP 429 with
/// `{ "error": "rate-limited", "endpoint", "limit", "retryAfterSec", "message" }`
/// (apps/com/src/rateLimit.ts). The sentence is built here from `limit` and
/// `retryAfterSec` with the Worker's own wording, so it reads the same on
/// every client. MIRRORS `rateLimitedMessage` / `retryAfterPhrase`.
public struct RateLimitedRefusal: Equatable, Sendable {
    /// Which budget ran out.
    public enum Limit: String, Equatable, Sendable {
        case ip
        case irk
        case usernameHash
    }

    public let endpoint: String?
    public let limit: Limit?
    public let retryAfterSec: Int?
    /// The Worker's own sentence, used only when ours can't be built.
    public let serverMessage: String?

    public init(endpoint: String? = nil, limit: Limit?, retryAfterSec: Int?, serverMessage: String? = nil) {
        self.endpoint = endpoint
        self.limit = limit
        self.retryAfterSec = retryAfterSec
        self.serverMessage = serverMessage
    }

    public static let fallbackMessage = String(localized: "Too many tries. Try again later.")

    /// "Too many tries from your network. Try again in about 12 minutes."
    public var message: String {
        if let limit, let retryAfterSec {
            return Self.sentence(limit: limit, retryAfterSec: retryAfterSec)
        }
        if let m = serverMessage?.trimmingCharacters(in: .whitespacesAndNewlines), !m.isEmpty {
            return m
        }
        return Self.fallbackMessage
    }

    public static func sentence(limit: Limit, retryAfterSec: Int) -> String {
        let who: String
        switch limit {
        case .ip: who = "from your network"
        case .irk: who = "from this account"
        case .usernameHash: who = "for this account name"
        }
        return String(localized: "Too many tries \(who). Try again \(retryAfterPhrase(retryAfterSec)).")
    }

    public static func retryAfterPhrase(_ sec: Int) -> String {
        if sec < 60 { return "in a minute" }
        let min = (sec + 59) / 60
        if min < 60 { return "in about \(min) minute\(min == 1 ? "" : "s")" }
        let h = max(1, Int((Double(min) / 60).rounded()))
        return "in about \(h) hour\(h == 1 ? "" : "s")"
    }

    /// The refusal in a 429 body, or nil for any other answer (including the
    /// older 429 shapes: free AI's `code`, the username-suggest cooldown).
    public static func from(status: Int, body: Data) -> RateLimitedRefusal? {
        guard status == 429,
              let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              obj["error"] as? String == "rate-limited" else { return nil }
        let retry: Int?
        if let n = obj["retryAfterSec"] as? NSNumber, n.doubleValue.isFinite, n.doubleValue >= 0 {
            retry = Int(n.doubleValue.rounded(.up))
        } else {
            retry = nil
        }
        return RateLimitedRefusal(
            endpoint: obj["endpoint"] as? String,
            limit: (obj["limit"] as? String).flatMap(Limit.init(rawValue:)),
            retryAfterSec: retry,
            serverMessage: obj["message"] as? String
        )
    }

    public static func from(status: Int, body: String) -> RateLimitedRefusal? {
        from(status: status, body: Data(body.utf8))
    }

    /// The refusal behind a caught error, if it is one.
    public static func from(_ error: Error) -> RateLimitedRefusal? {
        switch error {
        case let ScreensClientError.http(status, message):
            return from(status: status, body: message)
        case let FreeAiError.rateLimited(refusal):
            return refusal
        default:
            return nil
        }
    }
}
