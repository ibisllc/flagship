import Foundation

/// The PQ channel to a strict server (docs/architecture-v2/pq-suites.md §13), as the request
/// path sees it. FlagshipCore's `PqBoxChannelTunnel` implements it; the app registers one at
/// launch. `send` gets the transport the outer session requests (hello, finish, call) go over,
/// so they keep the relay, LAN and DNS fallbacks of every other request.
public protocol PqBoxTunnel: Sendable {
    /// True when requests to `host` must go over the channel (the server is strict for this device).
    func carries(host: String) -> Bool
    /// The server answered `pq-channel-required`: from now on requests to it go over the channel.
    func markStrict(host: String)
    func send(_ request: URLRequest, host: String,
              transport: @escaping @Sendable (URLRequest) async throws -> (Data, URLResponse)) async throws -> (Data, URLResponse)
}

public enum PqBoxTunnelRegistry {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var tunnel: (any PqBoxTunnel)?

    public static var current: (any PqBoxTunnel)? {
        lock.lock(); defer { lock.unlock() }
        return tunnel
    }

    public static func register(_ t: (any PqBoxTunnel)?) {
        lock.lock(); defer { lock.unlock() }
        tunnel = t
    }
}
