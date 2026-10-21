import Foundation
import FlagshipCore

/// "Connect to an existing account": one page, two ways in. The account-name
/// field signs in (resolve → recovery / demo); the code field joins through
/// the pairing relay. Same rules as the webapp's `lib/connectAccount.js` and
/// Android's `ConnectInput`. Pure: no UI, no network.
public enum ConnectInput: Equatable, Sendable {
    case empty
    /// A `/join` link (https or legacy `flagship://`) or a bare `sid=…&pk=…` code.
    case pairing(String)
    case name(String)
    /// A link, but not a pairing link (or one missing its session).
    case badLink

    public static let routedToJoin = String(localized: "That's a pairing link, so we're joining with it.")
    public static let notACode = String(localized: "That isn't a pairing code. Paste the whole link from the other device, or scan its code.")
    public static let nameInCode = String(localized: "That looks like an account name. Type it under Sign in with your account name.")
    public static let badLinkMessage = String(localized: "That link isn't a pairing link. Ask the other device to show a new code.")
    public static let emptyCode = String(localized: "Paste the pairing link, or scan the code.")

    public static func classify(_ text: String) -> ConnectInput {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return .empty }
        if (try? PairingQr.parseJoinUrl(raw)) != nil { return .pairing(raw) }
        if looksLikeLink(raw) { return .badLink }
        var name = raw.lowercased()
        if name.hasPrefix("@") { name.removeFirst() }
        return .name(name)
    }

    public enum NameField: Equatable, Sendable {
        case none
        case signIn(String)
        case join(link: String, note: String)
        case error(String)
    }

    /// The account-name field: a pasted pairing link goes to join, with a note.
    public static func readNameField(_ text: String) -> NameField {
        switch classify(text) {
        case .empty: return .none
        case .pairing(let link): return .join(link: link, note: routedToJoin)
        case .badLink: return .error(badLinkMessage)
        case .name(let n): return .signIn(n)
        }
    }

    public enum PairingField: Equatable, Sendable {
        case none
        case join(String)
        case error(String)
    }

    /// The pairing field: only a pairing link or bare code joins.
    public static func readPairingField(_ text: String) -> PairingField {
        switch classify(text) {
        case .empty: return .none
        case .pairing(let link): return .join(link)
        case .badLink: return .error(badLinkMessage)
        case .name(let n):
            return n.range(of: #"^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$"#, options: .regularExpression) != nil
                ? .error(nameInCode)
                : .error(notACode)
        }
    }

    private static func looksLikeLink(_ raw: String) -> Bool {
        raw.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*://"#, options: .regularExpression) != nil
            || raw.contains("/join")
            || raw.range(of: #"(^|[?&])(sid|pk)="#, options: .regularExpression) != nil
    }
}
