import Foundation
import FlagshipAPI

/// `.com`'s re-pair initiate refusals that carry a stable `code` (security
/// report F3, packages/control-plane/src/rePair.ts `RePairRefusalCode`) as
/// sentences. Mirrors the webapp's lib/rePairRefusal.js and Android's
/// `RePairRefusalText`.
public enum RePairRefusalText {
    public static let vetoedRecently = String(localized: "An admin of this account rejected a recovery with this device less than a day ago. You can try again after a day, or ask the admin.")
    public static let replay = String(localized: "This recovery request was already used. Start the recovery again.")
    public static let credentialUsed = String(localized: "That code was already used for a recovery. Wait for a new code, or repeat the recovery step, and try again.")
    public static let stale = String(localized: "This device's clock doesn't match Flagship's. Set the date and time to automatic, then try again.")

    /// The sentence for a refusal body's `code`, or nil when it has none of these.
    public static func text(code: String?) -> String? {
        switch code {
        case "re-pair-vetoed-recently": return vetoedRecently
        case "re-pair-replay", "re-pair-cancelled-replay": return replay
        case "re-pair-credential-used": return credentialUsed
        case "re-pair-stale": return stale
        default: return nil
        }
    }

    /// The sentence for an initiate's refusal, or nil when the error is something else.
    public static func refusal(_ error: Error) -> String? {
        guard case ScreensClientError.http(_, let body) = error else { return nil }
        guard let obj = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any] else { return nil }
        return text(code: obj["code"] as? String)
    }
}
