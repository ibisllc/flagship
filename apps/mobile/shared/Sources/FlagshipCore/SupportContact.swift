import Foundation

/// Where "Contact us" goes when a server's setup stopped. The message names the
/// order number and the step so support can find the install. Mirrors Android's
/// `SetupStoppedCard` mail and the webapp's support link.
public enum SupportContact {
    public static let email = "support@flagshipserver.com"

    public static func subject() -> String { String(localized: "Server setup stopped") }

    public static func body(serial: String, step: String?) -> String {
        String(localized: "My server's setup stopped.\nOrder: \(serial)\nStep: \(step ?? "")\n")
    }

    public static func setupStoppedURL(serial: String, step: String?) -> URL? {
        let s = TrademarkClaim.encodeURIComponent(subject())
        let b = TrademarkClaim.encodeURIComponent(body(serial: serial, step: step))
        return URL(string: "mailto:\(email)?subject=\(s)&body=\(b)")
    }

    /// "Email us" from "Why is {name} held?": the name in the subject, and a body to fill in.
    public static func heldNameURL(name: String) -> URL? {
        let s = TrademarkClaim.encodeURIComponent(String(localized: "Account name: \(name)"))
        let b = TrademarkClaim.encodeURIComponent(String(localized: "Name I want: \(name)") + "\n" + String(localized: "Why:") + "\n")
        return URL(string: "mailto:\(email)?subject=\(s)&body=\(b)")
    }
}
