import Foundation

/// The account and device names Home's header shows, kept on the phone.
///
/// The names are decrypted from the account directory, which only the
/// Settings page used to load, and they lived in memory: Home showed the full
/// "Elated Iris > Pixel" after a visit to Settings and only the routing handle
/// after the app was reopened. They are saved here when learned and read back
/// when the account opens. A presentation cache, never authoritative: the
/// directory wins whenever it is read. Mirrors Android's `PresentationNameStore`.
public struct PresentationNameStore {
    public struct Names: Equatable, Sendable {
        public let account: String?
        public let device: String?
        public init(account: String?, device: String?) { self.account = account; self.device = device }
    }

    private let defaults: UserDefaults
    private static let prefix = "flagship.presentationNames."

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private static func key(_ cloudName: String) -> String { prefix + cloudName.lowercased() }

    public func get(_ cloudName: String) -> Names? {
        guard let raw = defaults.dictionary(forKey: Self.key(cloudName)) as? [String: String] else { return nil }
        let account = raw["account"].flatMap { $0.isEmpty ? nil : $0 }
        let device = raw["device"].flatMap { $0.isEmpty ? nil : $0 }
        return (account == nil && device == nil) ? nil : Names(account: account, device: device)
    }

    /// Keep what is known; a nil name never erases one already saved.
    public func put(_ cloudName: String, account: String?, device: String?) {
        let known = get(cloudName)
        let a = account.flatMap { $0.isEmpty ? nil : $0 } ?? known?.account
        let d = device.flatMap { $0.isEmpty ? nil : $0 } ?? known?.device
        var raw: [String: String] = [:]
        if let a { raw["account"] = a }
        if let d { raw["device"] = d }
        if raw.isEmpty { return }
        defaults.set(raw, forKey: Self.key(cloudName))
    }

    /// The account left this phone.
    public func clear(_ cloudName: String) {
        defaults.removeObject(forKey: Self.key(cloudName))
    }
}
