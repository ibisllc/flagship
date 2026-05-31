import Foundation

/// Per-server boot-unlock state the phone remembers locally, keyed by the
/// server's canonical FQDN (`serverDomain`). Two facts:
///
///   - `mode` — the user's create-time choice. "auto" (the box self-unlocks
///     via a box-sealed lease after the first approved boot, the default) or
///     "approve" (phone-gated every boot). The recipe carries this to the box;
///     the phone keeps it so the approval screen knows whether to deposit a
///     self-unlock lease and the server-detail screen knows whether to offer
///     the kill switch.
///   - `leaseId` — set once an "auto" server's first boot is approved and a
///     box-sealed lease is deposited (returned by
///     `SecretRequestCoordinator.confirmAndRespond`). The kill switch revokes
///     by id.
///
/// Non-secret (no key material — the lease ciphertext lives on `.com`, the id
/// is just a handle), so plain `UserDefaults` is appropriate.
///
/// Cross-device caveat: a server created on THIS phone always has its mode
/// persisted here. When a DIFFERENT paired device approves a box it didn't
/// create, `mode(for:)` is nil; `effectiveMode(for:)` then falls back to the
/// product default ("auto"). Depositing a lease for a box that is actually in
/// "approve" mode is harmless — that box never reads the lease (boot-stage:
/// approve ⇒ relay-only).
public struct BootUnlockStore {
    public enum Mode: String, Sendable, Hashable, CaseIterable {
        case auto
        case approve
    }

    private let defaults: UserDefaults
    private static let modePrefix = "flagship.bootUnlock.mode."
    private static let leasePrefix = "flagship.bootUnlock.leaseId."

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private static func key(_ prefix: String, _ serverDomain: String) -> String {
        prefix + serverDomain.lowercased()
    }

    /// The explicitly stored mode, or nil if this device never recorded one
    /// for the server (e.g. a box created on another paired device).
    public func mode(for serverDomain: String) -> Mode? {
        guard let raw = defaults.string(forKey: Self.key(Self.modePrefix, serverDomain)) else { return nil }
        return Mode(rawValue: raw)
    }

    /// The mode to act on — absent ⇒ the product default ("auto").
    public func effectiveMode(for serverDomain: String) -> Mode {
        mode(for: serverDomain) ?? .auto
    }

    public func setMode(_ mode: Mode, for serverDomain: String) {
        defaults.set(mode.rawValue, forKey: Self.key(Self.modePrefix, serverDomain))
    }

    public func leaseId(for serverDomain: String) -> String? {
        defaults.string(forKey: Self.key(Self.leasePrefix, serverDomain))
    }

    /// Record (or clear, with nil) the deposited lease id for a server.
    public func setLeaseId(_ leaseId: String?, for serverDomain: String) {
        let k = Self.key(Self.leasePrefix, serverDomain)
        if let leaseId { defaults.set(leaseId, forKey: k) } else { defaults.removeObject(forKey: k) }
    }
}
