import Foundation

/// `.com`'s refusal when a device that isn't an admin device of the account
/// tries to add a server (owner rule 2026-10-16): a 403
/// `{"error": "<the sentence>", "code": "add-server-admin-only"}`. The apps
/// show their own copy of the same sentence, never the server's text.
public enum AddServerRefusal {
    public static let message = String(localized: "Only an admin device of this account can add servers.")
    public static let code = "add-server-admin-only"

    public static func matches(status: Int, body: String) -> Bool {
        guard status == 403,
              let obj = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any]
        else { return false }
        return obj["code"] as? String == code
    }
}
