import Foundation

/// Local, per-account persistence of PENDING servers — ones the phone has
/// delivered a recipe for but whose box hasn't booted + registered yet.
///
/// Registered servers come back from `.com` on every launch (the `/pods`
/// inventory is keyed on the `servers` table, populated at
/// `POST /api/server/register`). A *pending* server doesn't exist there until
/// the box phones home — so without this store a pending server vanishes from
/// the list when the app is closed and reopened, leaving the user no way to see
/// or cancel an in-flight install. Keyed by username; non-secret (names + the
/// auth-code serial used to cancel), so plain UserDefaults is appropriate.
public struct PendingServerStore {
    public struct Record: Codable, Sendable, Equatable {
        public var podId: String
        public var name: String
        public var description: String
        public var fqdn: String
        public var authCodeSerial: String
        public var createdAt: Double

        public init(
            podId: String,
            name: String,
            description: String,
            fqdn: String,
            authCodeSerial: String,
            createdAt: Double
        ) {
            self.podId = podId
            self.name = name
            self.description = description
            self.fqdn = fqdn
            self.authCodeSerial = authCodeSerial
            self.createdAt = createdAt
        }
    }

    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private func key(_ username: String) -> String {
        "flagship.pendingServers.\(username.lowercased())"
    }

    public func list(username: String) -> [Record] {
        guard let data = defaults.data(forKey: key(username)),
              let recs = try? JSONDecoder().decode([Record].self, from: data) else { return [] }
        return recs
    }

    /// Upsert by fqdn (a re-mint of the same name replaces the old record).
    public func add(username: String, _ rec: Record) {
        var recs = list(username: username).filter { $0.fqdn.lowercased() != rec.fqdn.lowercased() }
        recs.append(rec)
        save(username: username, recs)
    }

    public func remove(username: String, podId: String) {
        save(username: username, list(username: username).filter { $0.podId != podId })
    }

    /// Drop any pending record whose fqdn now appears in `liveFqdns` — the box
    /// registered, so it's a real server now and no longer pending.
    public func reconcile(username: String, liveFqdns: Set<String>) {
        let lowered = Set(liveFqdns.map { $0.lowercased() })
        save(username: username, list(username: username).filter { !lowered.contains($0.fqdn.lowercased()) })
    }

    private func save(username: String, _ recs: [Record]) {
        if recs.isEmpty {
            defaults.removeObject(forKey: key(username))
        } else if let data = try? JSONEncoder().encode(recs) {
            defaults.set(data, forKey: key(username))
        }
    }
}
