import Foundation
import Observation
import FlagshipAPI
import FlagshipCore

/// Settings → "Open secured sessions" (docs/service-access-gating.md,
/// "Web-experience gating"). Lists the browser QR-login sessions THIS phone has
/// authorized (held locally in `SecuredSessionStoring`), lets the owner refresh
/// each one's `online`/`offline` (rate-limited ~1/min/secretId), and stop one
/// (close on the box + remove locally).
///
/// The box rate-limits status to ~1/min/secretId (429 = "checked too
/// recently"). We debounce client-side too: a Refresh within `minRefreshMs`
/// (default 60s) of the last is a no-op that surfaces a subtle "checked
/// recently" hint rather than hitting the box. A server 429 (the two clocks can
/// disagree) is handled identically — we keep the last known status.
@Observable
@MainActor
public final class SecuredSessionsViewModel {

    public private(set) var sessions: [SecuredSession] = []
    /// Last-known liveness per secretId (nil = not yet checked this launch).
    public private(set) var statuses: [String: SecuredSessionStatus] = [:]
    /// Secrets currently mid-refresh — drives the per-row spinner.
    public private(set) var refreshing: Set<String> = []
    /// Secrets whose last Refresh was debounced/429'd — drives the subtle
    /// "checked recently" hint. Cleared the moment a real refresh lands.
    public private(set) var recentlyChecked: Set<String> = []

    private let client: any ServiceAccessClient
    private let store: any SecuredSessionStoring
    /// Per-secretId last-real-query wall time (ms) for the client debounce.
    private var lastQueryAt: [String: Int64] = [:]
    private let minRefreshMs: Int64
    private let now: () -> Int64

    public init(
        client: any ServiceAccessClient,
        store: any SecuredSessionStoring,
        minRefreshMs: Int64 = 60_000,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.client = client
        self.store = store
        self.minRefreshMs = minRefreshMs
        self.now = now
    }

    /// (Re)load the held sessions from the local store.
    public func load() {
        sessions = store.list()
        // Drop status/debounce state for sessions that no longer exist.
        let live = Set(sessions.map { $0.secretId })
        statuses = statuses.filter { live.contains($0.key) }
        lastQueryAt = lastQueryAt.filter { live.contains($0.key) }
        recentlyChecked = recentlyChecked.intersection(live)
    }

    /// Whether a Refresh on `session` would be debounced (too soon since the
    /// last real query). The row can grey its Refresh accordingly.
    public func canRefresh(_ session: SecuredSession) -> Bool {
        guard let last = lastQueryAt[session.secretId] else { return true }
        return now() - last >= minRefreshMs
    }

    /// Refresh a single session's status. Debounced ≥`minRefreshMs` per
    /// secretId; a server 429 keeps the last status + flags "checked recently".
    public func refresh(_ session: SecuredSession) async {
        let id = session.secretId
        if refreshing.contains(id) { return }
        if let last = lastQueryAt[id], now() - last < minRefreshMs {
            recentlyChecked.insert(id)
            return
        }
        refreshing.insert(id)
        defer { refreshing.remove(id) }
        do {
            let status = try await client.sessionStatus(serverDomain: session.serverId, secretId: id)
            lastQueryAt[id] = now()
            statuses[id] = status
            recentlyChecked.remove(id)
        } catch ServiceAccessError.statusRateLimited {
            // The box's clock said too-soon; keep the last status + hint.
            lastQueryAt[id] = now()
            recentlyChecked.insert(id)
        } catch {
            // Transient — leave the last-known status untouched.
        }
    }

    /// Stop a session: close it on the box (idempotent), then drop it locally.
    /// The local removal proceeds even if the close call fails (the session
    /// still expires on its own on the box; the owner wanted it gone here).
    public func stop(_ session: SecuredSession) async {
        let id = session.secretId
        do {
            try await client.closeSession(serverDomain: session.serverId, secretId: id)
        } catch {
            // best-effort — remove locally regardless.
        }
        store.remove(secretId: id)
        statuses.removeValue(forKey: id)
        lastQueryAt.removeValue(forKey: id)
        recentlyChecked.remove(id)
        sessions.removeAll { $0.secretId == id }
    }
}
