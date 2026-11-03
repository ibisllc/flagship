import Foundation

/// The rules every username and custom voi.ci link name meets (docs/voici-namespace-spec.md D12), byte-identical to
/// `voiciNameProblem` / `voiciNameKey` in `packages/protocol/src/voiciName.ts` (vectors in
/// `packages/protocol/test-vectors/voici-name/`): 3 to 30 of a-z 0-9 and -, no leading, trailing or double hyphen;
/// a name may start with a digit. `.com` stays the authority on what is taken (its names registry).
public enum VoiciName {
    /// Shortest and longest a name may be, hyphens counted.
    public static let minLength = 3
    public static let maxLength = 30

    public enum Problem: String, Equatable, Sendable {
        case tooShort = "too-short"
        case tooLong = "too-long"
        case characters
        case hyphens
    }

    /// What a client can check alone. Upper case is folded, not refused, so the answer is about the lower-cased
    /// input, checked in this order: characters, hyphens, length.
    public static func problem(_ typed: String) -> Problem? {
        let name = typed.lowercased()
        let allowed = name.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
        if !allowed { return .characters }
        if name.hasPrefix("-") || name.hasSuffix("-") || name.contains("--") { return .hyphens }
        if name.count < minLength { return .tooShort }
        if name.count > maxLength { return .tooLong }
        return nil
    }

    /// True when `name` is already lower case and meets the format.
    public static func isValid(_ name: String) -> Bool {
        name == name.lowercased() && problem(name) == nil
    }

    /// The safety key `.com` compares every claim on (D9): lower case, hyphens removed, 0 read as o and 1 as l.
    public static func key(_ typed: String) -> String {
        typed.lowercased()
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: "0", with: "o")
            .replacingOccurrences(of: "1", with: "l")
    }
}
