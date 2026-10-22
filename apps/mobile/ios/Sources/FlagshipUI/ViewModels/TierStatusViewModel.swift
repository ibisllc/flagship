import Foundation
import Observation
import FlagshipAPI

/// Backs the dedicated tier-status / subscription screen (P7). Loads
/// `GET /api/screens/tier-status` and exposes the rendering-friendly
/// derivations the webapp `views/tier-status.js` computes inline.
@MainActor
@Observable
public final class TierStatusViewModel {
    public private(set) var state: LoadingState<TierStatusResponse> = .idle
    /// The account's apps with a separate access list on each server; nil
    /// when the box can't say (best-effort, the card just hides).
    public private(set) var accessLists: AccessListsSummary?

    private let client: any ScreensClient
    private let serverNames: [String: String]

    public init(client: any ScreensClient, serverNames: [String: String] = [:]) {
        self.client = client
        self.serverNames = Dictionary(serverNames.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { a, _ in a })
    }

    public func load() async {
        state = .loading
        async let lists = summary()
        do {
            state = .loaded(try await client.tierStatus())
        } catch {
            state = .failed(error.localizedDescription)
        }
        accessLists = await lists
    }

    private func summary() async -> AccessListsSummary? {
        try? await client.accessListsSummary()
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
            return one.map { "1 app has a separate access list on each server. When Pro ends it will use \($0)'s list." }
                ?? "1 app has a separate access list on each server. When Pro ends it will use its lead server's list."
        }
        return one.map { "\(n) apps have a separate access list on each server. When Pro ends they'll all use \($0)'s list." }
            ?? "\(n) apps have a separate access list on each server. When Pro ends each will use its lead server's list."
    }

    /// Dispatcher usage progress, 0...100. Mirrors `pct(used, quota)` in
    /// tier-status.js: 0 when either is missing or quota is 0, else
    /// `min(100, round(used / quota * 100))`.
    public static func usagePercent(used: Double?, quota: Double?) -> Int {
        guard let used, let quota, quota != 0 else { return 0 }
        return min(100, Int((used / quota * 100).rounded()))
    }
}
