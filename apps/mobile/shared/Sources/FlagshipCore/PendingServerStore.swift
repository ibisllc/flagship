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

    /// The persisted envelope: the records PLUS the account identity (IRK
    /// pub hex) they belong to. Keying validity on the IRK — not just the
    /// username string — means a reused username with a DIFFERENT account
    /// (a fresh IRK) doesn't inherit the prior account's ghosts (#43 rule d).
    /// `accountKey` is nil for envelopes written before this field existed;
    /// such legacy envelopes are honoured once, then re-stamped on the next
    /// write so the binding self-heals.
    private struct Envelope: Codable {
        var accountKey: String?
        var records: [Record]
    }

    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private func key(_ username: String) -> String {
        "flagship.pendingServers.\(username.lowercased())"
    }

    private func loadEnvelope(username: String) -> Envelope {
        guard let data = defaults.data(forKey: key(username)) else {
            return Envelope(accountKey: nil, records: [])
        }
        if let env = try? JSONDecoder().decode(Envelope.self, from: data) {
            return env
        }
        // Legacy on-disk shape was a bare `[Record]`. Migrate it in-memory
        // (accountKey unknown ⇒ nil, honoured once then re-stamped).
        if let recs = try? JSONDecoder().decode([Record].self, from: data) {
            return Envelope(accountKey: nil, records: recs)
        }
        return Envelope(accountKey: nil, records: [])
    }

    public func list(username: String) -> [Record] {
        loadEnvelope(username: username).records
    }

    /// Upsert by fqdn (a re-mint of the same name replaces the old record).
    /// `accountKey` (the account IRK pub hex) binds the cache to the identity;
    /// pass it on the write so a later username reuse under a new IRK starts
    /// clean. Optional so existing call-sites (which don't yet know the IRK)
    /// keep compiling; when nil the prior binding is preserved.
    public func add(username: String, accountKey: String? = nil, _ rec: Record) {
        var env = loadEnvelope(username: username)
        env.records = env.records.filter { $0.fqdn.lowercased() != rec.fqdn.lowercased() }
        env.records.append(rec)
        if let accountKey { env.accountKey = accountKey.lowercased() }
        save(username: username, env)
    }

    public func remove(username: String, podId: String) {
        var env = loadEnvelope(username: username)
        env.records = env.records.filter { $0.podId != podId }
        save(username: username, env)
    }

    /// Drop any pending record whose fqdn now appears in `liveFqdns` — the box
    /// registered, so it's a real server now and no longer pending.
    public func reconcile(username: String, liveFqdns: Set<String>) {
        var env = loadEnvelope(username: username)
        let lowered = Set(liveFqdns.map { $0.lowercased() })
        env.records = env.records.filter { !lowered.contains($0.fqdn.lowercased()) }
        save(username: username, env)
    }

    /// #43 rule (d) — if the stored envelope belongs to a DIFFERENT account
    /// identity than `accountKey`, wipe it: a reused username under a new IRK
    /// must not inherit the prior account's pending ghosts. A nil stored
    /// accountKey (legacy / first write) is adopted, not wiped. Call this
    /// FIRST on account setup, before any reconcile, then stamp the key.
    public func bindToAccount(username: String, accountKey: String) {
        var env = loadEnvelope(username: username)
        let key = accountKey.lowercased()
        if let stored = env.accountKey, stored != key {
            // Different identity reusing the same name — start clean.
            env = Envelope(accountKey: key, records: [])
        } else {
            env.accountKey = key
        }
        save(username: username, env)
    }

    /// #43 rule (b/c) — reconcile the local cache against SERVER TRUTH. A
    /// pending record survives only if its order is still real OR its fqdn
    /// has registered (`liveFqdns`, handled by the caller flipping it
    /// online). Everything else is a ghost — an order that was wiped /
    /// expired / cancelled server-side — and is dropped so it stops spinning
    /// forever at "booting".
    ///
    /// The unauthenticated `/pods` directory no longer carries raw serials
    /// (a serial is a provision-status write capability) — it carries opaque
    /// `orderRef`s (`OrderRef.compute(serial:)`). A record written by THIS
    /// device holds the raw serial, so we hash it and test membership in
    /// `outstandingOrderRefs`. A record surfaced from the directory on a
    /// NON-creating device has no serial (empty), so it survives by fqdn
    /// membership in `outstandingFqdns` instead.
    ///
    /// Returns the dropped podIds so the caller can also remove them from
    /// AppState in the same pass.
    @discardableResult
    public func dropGhosts(
        username: String,
        outstandingOrderRefs: Set<String>,
        outstandingFqdns: Set<String>,
        liveFqdns: Set<String>
    ) -> [String] {
        var env = loadEnvelope(username: username)
        let liveLower = Set(liveFqdns.map { $0.lowercased() })
        let outstandingLower = Set(outstandingFqdns.map { $0.lowercased() })
        var dropped: [String] = []
        env.records = env.records.filter { rec in
            let stillOutstanding = rec.authCodeSerial.isEmpty
                ? outstandingLower.contains(rec.fqdn.lowercased())
                : outstandingOrderRefs.contains(OrderRef.compute(serial: rec.authCodeSerial))
            let keep = stillOutstanding || liveLower.contains(rec.fqdn.lowercased())
            if !keep { dropped.append(rec.podId) }
            return keep
        }
        save(username: username, env)
        return dropped
    }

    private func save(username: String, _ env: Envelope) {
        if env.records.isEmpty && env.accountKey == nil {
            defaults.removeObject(forKey: key(username))
        } else if let data = try? JSONEncoder().encode(env) {
            defaults.set(data, forKey: key(username))
        }
    }
}
