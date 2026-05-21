import Foundation

/// Mirror of the JSON the Node CLI's `verify` subcommand emits on success.
/// Anything missing means the recipe didn't verify and we don't try to be
/// clever — the wizard treats missing fields as a hard error and surfaces
/// the raw stderr.
public struct VerifyResult: Codable, Equatable, Sendable {
    public let ok: Bool
    public let serverDomain: String
    public let username: String?
    public let serverName: String?
    public let expiresAt: String?
    public let installerGitRef: String?
    public let signatureValid: Bool?

    public init(ok: Bool,
                serverDomain: String,
                username: String? = nil,
                serverName: String? = nil,
                expiresAt: String? = nil,
                installerGitRef: String? = nil,
                signatureValid: Bool? = nil) {
        self.ok = ok
        self.serverDomain = serverDomain
        self.username = username
        self.serverName = serverName
        self.expiresAt = expiresAt
        self.installerGitRef = installerGitRef
        self.signatureValid = signatureValid
    }

    public static func parse(jsonText: String) -> VerifyResult? {
        // The CLI prints other lines around the JSON (in some modes); scan for
        // the first '{' and try to decode from there. Robust to a trailing
        // newline or a "shredded recipe: ..." line that occasionally appears
        // for the user-data subcommand.
        guard let start = jsonText.firstIndex(of: "{") else { return nil }
        let tail = jsonText[start...]
        let data = Data(tail.utf8)
        return try? JSONDecoder().decode(VerifyResult.self, from: data)
    }

    /// Parsed expiry as a Date, or nil if the CLI didn't emit one or
    /// the timestamp didn't parse. Uses ISO 8601 — the CLI prints
    /// `new Date(blob.authCode.expiresAt).toISOString()`.
    public var expiresAtDate: Date? {
        guard let s = expiresAt else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    /// Human-readable "expires in 5h 47m" / "expired 3m ago" string,
    /// computed against `now` so callers can drive a timer.
    public func expiryLabel(now: Date = Date()) -> String? {
        guard let exp = expiresAtDate else { return nil }
        let remaining = exp.timeIntervalSince(now)
        if remaining < 0 {
            return "expired \(Self.formatDuration(-remaining)) ago"
        }
        return "expires in \(Self.formatDuration(remaining))"
    }

    static func formatDuration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        let h = total / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        if h >= 1 { return "\(h)h \(m)m" }
        if m >= 1 { return "\(m)m" }
        return "\(s)s"
    }
}
