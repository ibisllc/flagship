import Foundation
import Observation
import FlagshipAPI

/// The Plan page's warning before Pro ends while apps keep a separate access list on each server
/// (docs/service-access-gating.md "Separate lists per server (Pro)"). It asks the current server, so it stays
/// quietly empty with no server paired or reachable.
@MainActor
@Observable
public final class SeparateListsWarningViewModel {
    /// The account's apps with a separate access list on each server; nil when no server can say.
    public private(set) var accessLists: AccessListsSummary?

    private let client: any ScreensClient
    private let serverNames: [String: String]

    public init(client: any ScreensClient, serverNames: [String: String] = [:]) {
        self.client = client
        self.serverNames = Dictionary(serverNames.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { a, _ in a })
    }

    public func load() async {
        accessLists = try? await client.accessListsSummary()
    }

    /// What happens to separate access lists when Pro ends (the apps have no
    /// cancel button, so this stands in for "before you downgrade").
    public var separateListsWarning: String? {
        Self.separateListsWarning(accessLists) { self.serverName($0) }
    }

    public func serverName(_ fqdn: String) -> String {
        let f = fqdn.lowercased()
        if let name = serverNames[f]?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
        return f.split(separator: ".").first.map(String.init) ?? f
    }

    public static func separateListsWarning(_ s: AccessListsSummary?, name: (String) -> String) -> String? {
        guard let s, s.plan == "pro", s.separateApps > 0 else { return nil }
        let n = s.separateApps
        let one = s.leaders.count == 1 ? s.leaders.first.map(name) : nil
        if n == 1 {
            return one.map { String(localized: "1 app has a separate access list on each server. When Pro ends it will use \($0)'s list.") }
                ?? String(localized: "1 app has a separate access list on each server. When Pro ends it will use its lead server's list.")
        }
        return one.map { String(localized: "\(n) apps have a separate access list on each server. When Pro ends they'll all use \($0)'s list.") }
            ?? String(localized: "\(n) apps have a separate access list on each server. When Pro ends each will use its lead server's list.")
    }
}
