import Foundation

/// Per-server disk-encryption fact the phone remembers locally, keyed by the
/// server's canonical FQDN. Recorded at create-server time from the same
/// `encryptDisk` toggle that drives `InstallBlob.diskEncryption`.
///
/// The ONLY use today is UX wording: the lock/power buttons read "Lock and
/// turn off" / "Lock and restart" on a LUKS box (powering off drops the
/// in-memory disk key ⇒ a lock), and drop "Lock and " on a non-LUKS box.
///
/// GAP: `ServerDetailResponse` and `PodInfo` do NOT carry the LUKS state, so
/// a box created on a DIFFERENT paired device (or restored after a wipe) has
/// no record here. `isLuks(for:)` defaults to TRUE in that case — the safe,
/// spec-aligned default ("default to the LUKS labels"): worst case the button
/// says "Lock and turn off" on a box that wasn't encrypted, which is merely
/// imprecise wording, never a wrong action.
public struct DiskEncryptionStore {
    private let defaults: UserDefaults
    private static let prefix = "flagship.diskEncryption."

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private static func key(_ serverDomain: String) -> String {
        prefix + serverDomain.lowercased()
    }

    /// Record the create-time choice. `true` ⇒ LUKS (encrypted), `false` ⇒ none.
    public func setLuks(_ luks: Bool, for serverDomain: String) {
        defaults.set(luks ? "luks" : "none", forKey: Self.key(serverDomain))
    }

    /// The stored mode, or nil if this device never recorded one.
    public func mode(for serverDomain: String) -> String? {
        defaults.string(forKey: Self.key(serverDomain))
    }

    /// Whether to use the LUKS ("Lock and …") labels. Absent ⇒ true (default
    /// to the lock wording, per the spec's "default to the LUKS labels").
    public func isLuks(for serverDomain: String) -> Bool {
        guard let raw = mode(for: serverDomain) else { return true }
        return raw != "none"
    }
}
