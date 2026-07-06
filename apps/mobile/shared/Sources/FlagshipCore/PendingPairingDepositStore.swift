import Foundation

/// Secret-free recipe (docs/recipe-delivery-and-remote-install.md): the FIRST
/// recipe carries ZERO pairing secrets. The default (online) create flow stashes
/// the create-time owner-IRK-signed `add-paired-session` order locally and, once
/// the box registers with its identity pub, seals it to the box identity and
/// deposits it on `.com`'s blind pairing-deposit lane. This store remembers, per
/// server FQDN, the STASHED order JSON that is still OWED — and, once done, that
/// it's been DEPOSITED (so a later reconcile never double-deposits).
///
/// The twin of `PendingSwkDepositStore`. Keyed by the canonical FQDN. Three
/// states per server:
///   - absent              → nothing owed (embed-secrets WAS on, or not created here).
///   - "<pairingOrderJson>" → owed: the stashed plaintext order to seal + deposit.
///   - "deposited"         → done: the order was accepted by `.com` (idempotency).
public struct PendingPairingDepositStore {
    private let defaults: UserDefaults
    private static let prefix = "flagship.pairingDeposit."
    private static let depositedMarker = "deposited"

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private static func key(_ serverDomain: String) -> String {
        prefix + serverDomain.lowercased()
    }

    /// Stash the create-time order JSON — a deposit is OWED (embed-secrets OFF).
    public func markPending(for serverDomain: String, pairingOrderJson: String) {
        defaults.set(pairingOrderJson, forKey: Self.key(serverDomain))
    }

    /// Record that the order was accepted by `.com` — the idempotency marker.
    public func markDeposited(for serverDomain: String) {
        defaults.set(Self.depositedMarker, forKey: Self.key(serverDomain))
    }

    /// Clear any record (e.g. embed-secrets was ON, or the server was cancelled).
    public func clear(for serverDomain: String) {
        defaults.removeObject(forKey: Self.key(serverDomain))
    }

    /// The stashed order JSON iff a deposit is still owed, else nil.
    public func pendingOrder(for serverDomain: String) -> String? {
        let v = defaults.string(forKey: Self.key(serverDomain))
        guard let v, v != Self.depositedMarker else { return nil }
        return v
    }

    /// True iff the order was already deposited for this server.
    public func isDeposited(for serverDomain: String) -> Bool {
        defaults.string(forKey: Self.key(serverDomain)) == Self.depositedMarker
    }
}
