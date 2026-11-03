import Foundation
import FlagshipAPI

/// The sentences for the one voi.ci namespace (docs/voici-namespace-spec.md), shared by the account-name fields and
/// the service page's link field. The same English as the webapp's and Android's, so the catalogs agree: a format
/// problem gets its own line, and any refusal of a name a person may not take (another account's, a look-alike of
/// one, a link name, a code, a reserved word, a name on hold) gets the one generic line.
public enum NameRuleText {
    public static var taken: String { String(localized: "Taken or too similar to an existing name") }

    public static func problem(_ p: VoiciName.Problem) -> String {
        switch p {
        case .tooShort: return String(localized: "At least 3 characters")
        case .tooLong: return String(localized: "At most 30 characters")
        case .characters: return String(localized: "Letters, numbers and hyphens only")
        case .hyphens: return String(localized: "No hyphen at the start or end, or two in a row")
        }
    }

    /// `.com`'s `problem` field (too-short, too-long, characters, hyphens); an unknown or missing one reads as characters.
    public static func problem(code: String?) -> String {
        problem(code.flatMap(VoiciName.Problem.init(rawValue:)) ?? .characters)
    }

    /// The sentence for a refused username claim or account bootstrap (`409 {code:"taken"}` or
    /// `400 {code:"invalid", problem}`), or nil when the refusal is about something else.
    public static func refusal(_ error: Error) -> String? {
        guard case let ScreensClientError.http(status, message) = error,
              let data = message.data(using: .utf8),
              let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let code = body["code"] as? String else { return nil }
        switch (status, code) {
        case (409, "taken"), (409, "reserved"): return taken
        case (400, "invalid"): return problem(code: body["problem"] as? String)
        default: return nil
        }
    }
}
