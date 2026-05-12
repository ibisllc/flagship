import Foundation

/// Tiny utility for normalizing a user-supplied server name into a DNS
/// label (used as the subdomain prefix inside `.flagship.services`).
public enum SlugUtil {
    public static func slugify(_ name: String) -> String {
        let allowed = CharacterSet.lowercaseLetters.union(.decimalDigits).union(CharacterSet(charactersIn: "-"))
        let lower = name.lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .unicodeScalars
            .filter { allowed.contains($0) }
            .map(String.init)
            .joined()
        return lower.isEmpty ? "server" : lower
    }
}
