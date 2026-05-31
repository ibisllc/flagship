import Foundation

/// "I hold a trademark to this name" — prefilled mailto builder.
///
/// Byte-for-byte mirror of the canonical webapp helper
/// (apps/web/public/webapp/lib/trademarkClaim.js) so the iOS, Android,
/// and webapp "name taken" states all open the exact same message. A
/// user who holds a registered trademark to an already-claimed name can
/// email the flagship trademarks desk to start a claim.
public enum TrademarkClaim {
    /// Where trademark claims go.
    public static let email = "trademarks@flagshipserver.com"

    /// Subject line for a trademark claim on `username`.
    public static func subject(username: String) -> String {
        "Trademark claim for the name \"\(username)\""
    }

    /// Plain-text body template. Leaves bracketed placeholders for the
    /// user to fill in. Joined with `\n` to match the JS array template.
    public static func body(username: String) -> String {
        [
            "Hello,",
            "",
            "I'm requesting the Flagship account name \"\(username)\" on the basis",
            "that I hold a registered trademark covering it.",
            "",
            "Trademark holder / company: [your name or company]",
            "Trademark registration number: [registration number]",
            "Jurisdiction / registry: [e.g. USPTO, EUIPO]",
            "Goods/services class(es): [class numbers]",
            "Link or attachment to the registration: [URL or note that it's attached]",
            "",
            "Requested name: \(username)",
            "",
            "Thank you.",
        ].joined(separator: "\n")
    }

    /// Build the full `mailto:` URL (subject + body URL-encoded the same
    /// way JS `encodeURIComponent` does, so the produced string is
    /// byte-identical to the webapp's `trademarkClaimMailto`).
    public static func mailtoURL(username: String) -> URL? {
        let s = encodeURIComponent(subject(username: username))
        let b = encodeURIComponent(body(username: username))
        return URL(string: "mailto:\(email)?subject=\(s)&body=\(b)")
    }

    /// Faithful port of JavaScript's `encodeURIComponent`: percent-encode
    /// every character EXCEPT the unreserved set `A-Za-z0-9` and
    /// `- _ . ! ~ * ' ( )`. Foundation's built-in sets don't match this
    /// exactly, so we pin the allowed set explicitly.
    static func encodeURIComponent(_ value: String) -> String {
        let unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
        let allowed = CharacterSet(charactersIn: unreserved)
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
