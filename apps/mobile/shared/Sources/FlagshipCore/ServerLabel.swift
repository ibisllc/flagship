import Foundation

/// Validates a server (pod) subdomain — the leftmost `<server>` label of
/// `<server>.<user>.flagship.services`. Mirror of the authoritative
/// server-side check `packages/control-plane/src/labels.ts`
/// (`validateServerLabel`): a standard RFC-1123 DNS label — 1–63 lowercase
/// letters/digits with interior hyphens (no leading/trailing hyphen), minus a
/// small reserved set that would collide with the per-user/per-server DNS
/// plumbing or gossip fan-out addresses.
///
/// The create flow validates + REJECTS non-conforming input rather than
/// silently slugifying it — what the user types IS the subdomain, so there is
/// no hidden transform and no false expectation that a free-text name is
/// preserved.
public enum ServerLabel {
    /// RFC-1123 label: `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` (1–63 chars, no
    /// leading/trailing hyphen). Identical to labels.ts `LABEL_RE`.
    static let pattern = "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"

    /// The FULL reserved set from labels.ts `RESERVED_SERVER_LABELS` (the
    /// webapp's inline copy is stale — it omits broadcast/servers/all).
    public static let reserved: Set<String> = [
        "www", "api", "admin", "flagship", "flagshipserver", "services",
        "ns1", "ns2", "mail", "tunnel", "control", "status",
        "broadcast", "servers", "all",
    ]

    public enum Validation: Equatable {
        case ok(String)          // the normalized (lowercased) label
        case invalid(String)     // a human-readable reason
    }

    /// Validate `input` as a server subdomain. Lowercases first (domains are
    /// case-insensitive), the same normalization the server applies.
    public static func validate(_ input: String) -> Validation {
        let norm = input.trimmingCharacters(in: .whitespaces).lowercased()
        if norm.range(of: pattern, options: .regularExpression) == nil {
            return .invalid("lowercase letters, digits, and hyphens (not at the start or end)")
        }
        if reserved.contains(norm) {
            return .invalid("\"\(norm)\" is reserved — pick another")
        }
        return .ok(norm)
    }

    /// True iff `input` is a syntactically valid, non-reserved subdomain.
    public static func isValid(_ input: String) -> Bool {
        if case .ok = validate(input) { return true }
        return false
    }

    /// The validation message for a NON-empty invalid input, else nil (so an
    /// empty field shows no error, and a valid one clears it).
    public static func errorMessage(_ input: String) -> String? {
        if input.trimmingCharacters(in: .whitespaces).isEmpty { return nil }
        if case .invalid(let reason) = validate(input) { return reason }
        return nil
    }

    /// The normalized label (lowercased), or the raw input when invalid — the
    /// caller validates before minting, so this is only reached with valid input.
    public static func normalized(_ input: String) -> String {
        if case .ok(let label) = validate(input) { return label }
        return input.trimmingCharacters(in: .whitespaces).lowercased()
    }
}
