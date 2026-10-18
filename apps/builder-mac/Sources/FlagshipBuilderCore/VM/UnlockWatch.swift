import Foundation

/// Waits for a sealed guest to come up after its owner approved the unlock.
/// With an order serial the proof is the box's own signed health report from
/// `.com` (received after THIS boot began, daemon active, relay tunnel up).
/// The server's public name is never looked up in that case: it does not exist
/// until the box registers it, and a lookup before then is cached as NXDOMAIN
/// by home routers for the zone's negative TTL (30 minutes seen on a Windows
/// PC on 2026-10-18), leaving a healthy box stuck on "Waiting for you to
/// unlock". Only a server without a serial falls back to fetching its name
/// (TLS ends on the box, so any HTTP response proves the unlock). Mirrors the
/// Windows and Linux Studio; pinned by vm-core-vectors.json "bootEvidence".
public enum UnlockWatch {
    /// Returns true once the guest is proven up; false when cancelled.
    public static func run(
        serverDomain: String,
        healthURL: URL?,
        poweredOnAt: Date,
        now: @escaping @Sendable () -> Date = { Date() },
        fetchHealth: @escaping @Sendable (URL) async -> Data?,
        probeName: @escaping @Sendable (URL) async -> Bool,
        interval: Duration = .seconds(15)
    ) async -> Bool {
        while !Task.isCancelled {
            if let healthURL {
                if let data = await fetchHealth(healthURL),
                   let health = VMServerHealth.fromOrderHealth(data, serverDomain: serverDomain),
                   health.provesBoxIsUp(poweredOnAt: poweredOnAt, now: now()) {
                    return true
                }
            } else if let url = URL(string: "https://\(serverDomain)/"), await probeName(url) {
                return true
            }
            do { try await Task.sleep(for: interval) } catch { return false }
        }
        return false
    }
}
