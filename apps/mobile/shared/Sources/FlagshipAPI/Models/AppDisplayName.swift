import Foundation

/// The name an app is shown under. The box sends a `name` only on some rows
/// (a copy still underway); otherwise the name comes from the slug, a DNS
/// label, so "chess-club" reads "Chess Club" rather than "Chess-Club".
public enum AppDisplayName {
    public static func fromSlug(_ slug: String) -> String {
        let words = slug.split(whereSeparator: { $0 == "-" || $0 == "_" }).map { word -> String in
            guard let first = word.first else { return "" }
            return first.uppercased() + word.dropFirst()
        }
        let joined = words.filter { !$0.isEmpty }.joined(separator: " ")
        return joined.isEmpty ? slug : joined
    }

    /// `<account>--<slug>` → the slug's name; an id without `--` is taken as the slug.
    public static func fromServiceId(_ serviceId: String) -> String {
        if let delim = serviceId.range(of: "--", options: .backwards) {
            return fromSlug(String(serviceId[delim.upperBound...]))
        }
        return fromSlug(serviceId)
    }
}

extension AppSummary {
    /// The box's own `name` when it sends one, else the slug as words.
    public var displayName: String {
        if let n = name?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty { return n }
        return AppDisplayName.fromSlug(slug)
    }
}
