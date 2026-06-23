import Foundation

/// Secret-free recipe (docs/recipe-delivery-and-remote-install.md): when a
/// server is created WITHOUT embedding the SWK in the recipe (the default), the
/// phone must deposit the SWK to `.com` AFTER the box registers (so the box can
/// claim it and turn on its service platform). This store remembers, per server
/// FQDN, that a deposit is still OWED — and, once done, that it's been DEPOSITED
/// (so a later reconcile pass never double-deposits).
///
/// Keyed by the canonical FQDN, mirroring `DiskEncryptionStore` /
/// `BootUnlockStore`. Three states per server:
///   - absent      → nothing owed (embed-secrets WAS on, or never created here).
///   - "pending"   → owed: the box hasn't come online yet OR the deposit failed.
///   - "deposited" → done: the SWK was accepted by `.com` (idempotency marker).
public struct PendingSwkDepositStore {
    private let defaults: UserDefaults
    private static let prefix = "flagship.swkDeposit."

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private static func key(_ serverDomain: String) -> String {
        prefix + serverDomain.lowercased()
    }

    /// Record that a deposit is OWED for this server (embed-secrets was OFF).
    public func markPending(for serverDomain: String) {
        defaults.set("pending", forKey: Self.key(serverDomain))
    }

    /// Record that the SWK was accepted by `.com` — the idempotency marker.
    public func markDeposited(for serverDomain: String) {
        defaults.set("deposited", forKey: Self.key(serverDomain))
    }

    /// Clear any record (e.g. the server was cancelled before it came online).
    public func clear(for serverDomain: String) {
        defaults.removeObject(forKey: Self.key(serverDomain))
    }

    /// True iff a deposit is still owed (recorded pending, not yet deposited).
    public func isPending(for serverDomain: String) -> Bool {
        defaults.string(forKey: Self.key(serverDomain)) == "pending"
    }

    /// True iff the SWK was already deposited for this server.
    public func isDeposited(for serverDomain: String) -> Bool {
        defaults.string(forKey: Self.key(serverDomain)) == "deposited"
    }
}
