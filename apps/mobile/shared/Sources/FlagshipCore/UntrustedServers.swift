import Foundation

/// Servers this device stopped trusting (docs/retail-box-setup.md §7.7): the box that came online
/// after a retail claim was not the box the phone paired with. Kept per device until the owner
/// deletes the server. While a server is listed the phone opens no connection to it
/// (`CertPinRegistry` treats it as a known box without a pin) and seals nothing to it
/// (`BoxKeyPins.require` refuses), and Home shows it with a red badge.
public final class UntrustedServers: @unchecked Sendable {
    public static let shared = UntrustedServers()
    static let key = "flagship.untrustedServers.v1"

    private let defaults: UserDefaults
    private let lock = NSLock()

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public static func volatile() -> UntrustedServers {
        UntrustedServers(defaults: UserDefaults(suiteName: "flagship.untrustedServers.volatile.\(UUID().uuidString)") ?? .standard)
    }

    static func normalize(_ domain: String) -> String {
        var d = domain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while d.hasSuffix(".") { d.removeLast() }
        return d
    }

    public var all: Set<String> {
        lock.lock(); defer { lock.unlock() }
        return Set(defaults.stringArray(forKey: Self.key) ?? [])
    }

    public func mark(_ serverDomain: String) {
        let d = Self.normalize(serverDomain)
        guard !d.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        var s = Set(defaults.stringArray(forKey: Self.key) ?? [])
        s.insert(d)
        defaults.set(s.sorted(), forKey: Self.key)
    }

    /// The server was deleted: its name may come back as a new server.
    public func forget(_ serverDomain: String) {
        let d = Self.normalize(serverDomain)
        lock.lock(); defer { lock.unlock() }
        var s = Set(defaults.stringArray(forKey: Self.key) ?? [])
        guard s.remove(d) != nil else { return }
        defaults.set(s.sorted(), forKey: Self.key)
    }

    /// True for the server itself and every name under it (its apps).
    public func contains(host: String) -> Bool {
        let h = Self.normalize(host)
        guard !h.isEmpty else { return false }
        return all.contains { h == $0 || h.hasSuffix(".\($0)") }
    }

    public func clear() {
        lock.lock(); defer { lock.unlock() }
        defaults.removeObject(forKey: Self.key)
    }
}

/// Sealing to a server this device marked untrusted.
public struct ServerUntrustedError: Error, LocalizedError, Equatable, Sendable {
    public let serverDomain: String
    public var errorDescription: String? {
        String(localized: "This phone doesn't trust this server: it is not the box you set up. Delete it from Home.")
    }
}
