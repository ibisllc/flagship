import Foundation

/// `Endpoints` — the SINGLE source of truth for the backend apexes the app
/// talks to. The control plane (`flagshipserver.com` + its `boot.` / `web.` /
/// `recovery.` sub-origins) and the data plane (`flagship.services`) used to
/// be hardcoded as a literal in each client / model (~10 sites); this
/// consolidates them so the gym test env (`gym.flagshipserver.com` /
/// `gym.flagship.services`, docs/ui-test-gym.md §12-G2) is one knob.
///
/// Prod is byte-identical: with no override set, every accessor resolves to
/// today's literal exactly as before. Unlike the webapp (which derives the
/// apex from the served origin), a native app isn't "served" from a host, so
/// the test-build seam is an explicit override — `setOverride(_:)` — that the
/// app applies at launch from a launch-arg (`-apex-host <host>`) or a
/// `DeveloperSettings` field. PROD callers never set it.
public enum Endpoints {
    /// Today's prod control apex host (no scheme).
    public static let prodControlHost = "flagshipserver.com"
    /// Today's prod data-plane apex suffix (no leading dot).
    public static let prodDataApex = "flagship.services"

    /// Process-wide override, set ONCE at launch by the test build. nil ⇒ prod
    /// defaults (so the live app + the unit suite are byte-identical).
    public struct Override: Sendable {
        public let controlHost: String
        public let dataApex: String
        public let secure: Bool
        public init(controlHost: String, dataApex: String, secure: Bool = true) {
            self.controlHost = controlHost
            self.dataApex = dataApex
            self.secure = secure
        }
    }

    private static let lock = NSLock()
    private nonisolated(unsafe) static var _override: Override?

    /// Install the override (test build only). Pass nil to clear.
    public static func setOverride(_ override: Override?) {
        lock.lock()
        defer { lock.unlock() }
        _override = override
    }

    /// Convenience: derive the override from a single apex host
    /// (`gym.flagshipserver.com`), mirroring the data apex's `gym.` prefix
    /// (`gym.flagship.services`) the way the webapp does.
    public static func setOverride(controlHost host: String, secure: Bool = true) {
        setOverride(Override(controlHost: host, dataApex: dataApexFor(controlHost: host), secure: secure))
    }

    private static func currentOverride() -> Override? {
        lock.lock()
        defer { lock.unlock() }
        return _override
    }

    /// Map a control host to its sibling data apex: `gym.flagshipserver.com`
    /// → `gym.flagship.services`; the prod host → `flagship.services`.
    static func dataApexFor(controlHost host: String) -> String {
        if host == prodControlHost { return prodDataApex }
        if host.hasSuffix(".\(prodControlHost)") {
            let prefix = String(host.dropLast(prodControlHost.count)) // keeps the trailing dot
            return "\(prefix)\(prodDataApex)"
        }
        return prodDataApex
    }

    // MARK: - Control plane

    /// The control-plane apex host (no scheme): `flagshipserver.com` (prod).
    public static var controlHost: String {
        currentOverride()?.controlHost ?? prodControlHost
    }

    private static var scheme: String { (currentOverride()?.secure ?? true) ? "https" : "http" }

    /// The control-plane apex base URL: `https://flagshipserver.com` (prod).
    public static var controlBaseUrl: URL {
        URL(string: "\(scheme)://\(controlHost)")!
    }

    /// A sub-origin of the control apex, e.g. `boot.flagshipserver.com`.
    public static func subOrigin(_ prefix: String) -> URL {
        URL(string: "\(scheme)://\(prefix).\(controlHost)")!
    }

    /// The boot-worker base URL (`boot.<apex>`).
    public static var bootBaseUrl: URL { subOrigin("boot") }

    /// The cloud-recovery sub-origin (`recovery.<apex>`).
    public static var recoveryBaseUrl: URL { subOrigin("recovery") }

    /// The webapp host (`web.<apex>`) — the companion-dock receiver host.
    public static var webappHost: String { "web.\(controlHost)" }

    /// The server-register endpoint baked into a fresh InstallBlob.
    public static var registrationUrl: String {
        "\(scheme)://\(controlHost)/api/server/register"
    }

    // MARK: - Data plane

    /// The data-plane apex suffix (no leading dot): `flagship.services` (prod).
    public static var dataApex: String {
        currentOverride()?.dataApex ?? prodDataApex
    }

    /// A server's canonical FQDN: `<server>.<user>.flagship.services`.
    public static func serverFqdn(server: String, user: String) -> String {
        "\(server).\(user).\(dataApex)"
    }

    /// A user's data-plane zone host: `<user>.flagship.services`.
    public static func userZoneHost(_ user: String) -> String {
        "\(user).\(dataApex)"
    }
}
