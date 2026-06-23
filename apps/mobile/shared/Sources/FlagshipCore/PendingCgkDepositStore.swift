import Foundation

/// Per-service leadership (Phase 6, docs/multi-pod-liveness-session-leadership.md):
/// the Cloud Gossip Key (CGK) is NEVER embedded in the recipe (it is the per-cloud
/// gossip secret) — it is always delivered to a box AFTER it registers, sealed to
/// its registered identity, exactly like the secret-free SWK. This store remembers,
/// per server FQDN, that a CGK deposit is still OWED — and, once done, that it's
/// been DEPOSITED (so a later reconcile pass never double-deposits).
///
/// The EXACT twin of `PendingSwkDepositStore`. Keyed by the canonical FQDN. Three
/// states per server:
///   - absent      → nothing owed (never created here / already cleared).
///   - "pending"   → owed: the box hasn't come online yet OR the deposit failed.
///   - "deposited" → done: the CGK was accepted by `.com` (idempotency marker).
///
/// Unlike the SWK (which is owed only when embed-secrets is OFF), the CGK is owed
/// on EVERY created server — it is never embedded — so the create flow marks it
/// pending unconditionally.
public struct PendingCgkDepositStore {
    private let defaults: UserDefaults
    private static let prefix = "flagship.cgkDeposit."

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private static func key(_ serverDomain: String) -> String {
        prefix + serverDomain.lowercased()
    }

    /// Record that a CGK deposit is OWED for this server.
    public func markPending(for serverDomain: String) {
        defaults.set("pending", forKey: Self.key(serverDomain))
    }

    /// Record that the CGK was accepted by `.com` — the idempotency marker.
    public func markDeposited(for serverDomain: String) {
        defaults.set("deposited", forKey: Self.key(serverDomain))
    }

    /// Clear any record (e.g. the server was cancelled before it came online).
    public func clear(for serverDomain: String) {
        defaults.removeObject(forKey: Self.key(serverDomain))
    }

    /// True iff a CGK deposit is still owed (recorded pending, not yet deposited).
    public func isPending(for serverDomain: String) -> Bool {
        defaults.string(forKey: Self.key(serverDomain)) == "pending"
    }

    /// True iff the CGK was already deposited for this server.
    public func isDeposited(for serverDomain: String) -> Bool {
        defaults.string(forKey: Self.key(serverDomain)) == "deposited"
    }
}
