import Foundation
import FlagshipAPI
import FlagshipCore

/// LiveSync — the iOS app-scope single live-update canal.
///
/// ONE long-poll loop against the backend hanging GET
///   `GET /api/users/:u/stream?cursor=<hex>`
/// which returns `{ cursor, pods, pending, … }` — a SUPERSET of `/pods` (same
/// `pods[]` with `pendingRequests`, same `pending[]` with `phase`) plus an
/// opaque cursor. We echo the last cursor back; the server HOLDS up to ~25s and
/// returns the instant anything meaningful changes (or on timeout, the same
/// cursor). On every snapshot we feed the SAME shared state the views already
/// read — `AppState.pods` (via the existing `PendingServerReconciler`) and the
/// unified Box Request Inbox `AppState.boxRequestInbox` — so the UI updates with
/// no manual refresh. It collapses the per-screen pollers (BootApprovalWatcher's
/// timer, the per-pending PendingPodWatcher timers, the Home inventory re-poll)
/// into ONE channel.
///
/// Shape mirrors `AiChatAlertPoller`: an `isActive`-gated foreground loop with
/// an injected client + timers, app-scope (wired at the shell, NOT one screen),
/// fully unit-testable with the MockSecretMailboxClient (no real network, no
/// hang). GRACEFUL FALLBACK: a stream error / non-200 drops to a plain `/pods`
/// fetch (today's behavior) so behavior never degrades — `/pods` stays the net.
@MainActor
@Observable
public final class LiveSyncCoordinator {
    /// ± jitter on each reconnect so a fleet that times out together doesn't
    /// reconnect in lockstep (thundering herd).
    public nonisolated static let jitterNanos: UInt64 = 500_000_000   // 0.5s
    /// Wait between rounds when /stream is down (the /pods fallback cadence —
    /// the safety net, matching BootApprovalWatcher's 5s feel).
    public nonisolated static let fallbackNanos: UInt64 = 5_000_000_000 // 5s
    /// The longest gap between retries while `.com` keeps failing. Every retry
    /// is a request the Free plan counts (and a Cloudflare 1102 means the Worker
    /// is already struggling), so a failing loop backs off instead of repeating
    /// every 5 s.
    public nonisolated static let maxBackoffNanos: UInt64 = 120_000_000_000 // 2 min
    /// While /pods still answers but /stream does not, the screen refreshes at
    /// most this slowly.
    public nonisolated static let podsOnlyMaxNanos: UInt64 = 30_000_000_000 // 30s

    /// The wait before retry number `streak` (1 = the first failure): the
    /// fallback cadence doubled each time, capped.
    public nonisolated static func backoffNanos(streak: Int, fallback: UInt64 = fallbackNanos) -> UInt64 {
        let doublings = max(0, min(streak - 1, 16))
        return min(maxBackoffNanos, fallback << UInt64(doublings))
    }

    private let app: AppState
    private let mailbox: any SecretMailboxClient
    /// Gate — only poll while paired + unlocked (mirrors the sliver's
    /// hide-under-lock). The loop self-pauses when false and resumes when true.
    private let isActive: @MainActor () -> Bool
    /// Build the reconciler for a directory the loop already fetched. Injected so
    /// the SWK-deposit side-effect (and `now`) can be wired by the caller while
    /// the test path stays side-effect-free.
    private let makeReconciler: @MainActor (_ fetch: @escaping PendingServerReconciler.PodsFetcher) -> PendingServerReconciler
    private let jitter: () -> UInt64
    private let fallback: UInt64

    private var task: Task<Void, Never>?
    /// The last cursor the stream returned — echoed back to detect change.
    private var cursor: String?
    /// Whether the last round fell back to /pods (a prior stream error).
    public private(set) var degraded = false
    /// Consecutive failed rounds; the retry gap doubles with it.
    private var streak = 0
    /// Whether the last /pods fallback answered, so a failing stream can lean on it.
    private var podsAnswered = true

    public init(
        app: AppState,
        mailbox: any SecretMailboxClient,
        isActive: @escaping @MainActor () -> Bool,
        makeReconciler: @escaping @MainActor (_ fetch: @escaping PendingServerReconciler.PodsFetcher) -> PendingServerReconciler,
        jitter: @escaping () -> UInt64 = { UInt64.random(in: 0...LiveSyncCoordinator.jitterNanos) },
        fallbackNanos: UInt64 = LiveSyncCoordinator.fallbackNanos
    ) {
        self.app = app
        self.mailbox = mailbox
        self.isActive = isActive
        self.makeReconciler = makeReconciler
        self.jitter = jitter
        self.fallback = fallbackNanos
    }

    public func start() {
        stop()
        task = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if self.isActive() {
                    let nextDelay = await self.tickOnce()
                    if Task.isCancelled { return }
                    try? await Task.sleep(nanoseconds: nextDelay)
                } else {
                    // Paused (backgrounded / locked / signed out). Re-check soon;
                    // the next active tick reconnects (cursor preserved).
                    try? await Task.sleep(nanoseconds: self.fallback)
                }
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
    }

    /// One round-trip. Returns the nanoseconds to wait before the next request.
    /// On a successful /stream read we reconnect immediately (+ jitter) — the
    /// server already held. On a fallback /pods read (stream error) we wait the
    /// fallback cadence. Always feeds the shared state; never throws to the loop.
    @discardableResult
    public func tickOnce() async -> UInt64 {
        guard let user = app.currentUser, !user.isEmpty else { return fallback }
        do {
            let snap = try await mailbox.fetchLiveSync(username: user, cursor: cursor)
            degraded = false
            streak = 0
            podsAnswered = true
            let changed = snap.cursor != cursor
            cursor = snap.cursor
            // Only feed the shared state on a genuine change. A timeout hold
            // returns the same cursor, so a steady stream never churns the UI.
            if changed {
                await feed(directory: snap.directory)
            }
            // Long-poll: reconnect right away (+ jitter).
            return jitter()
        } catch {
            // /stream unreachable / non-200 → fall back to the plain /pods fetch
            // so behavior never degrades below today's. Then wait the fallback
            // cadence (the next round retries /stream first).
            degraded = true
            streak += 1
            // Clear the cursor so the next /stream attempt connects fresh and
            // returns the current state immediately.
            cursor = nil
            // When /pods failed too (the service itself is failing: a 5xx such
            // as Cloudflare's 1102, or a 429), ask it only every fourth round,
            // so an outage is not hit twice a round.
            if podsAnswered || streak == 1 || streak % 4 == 0 {
                if let dir = try? await mailbox.fetchPods(username: user) {
                    await feed(directory: dir)
                    podsAnswered = true
                    // /pods answered, so only /stream is failing: keep the
                    // screen fresh, but not every 5 s for as long as the stream
                    // stays down.
                    return min(Self.backoffNanos(streak: streak, fallback: fallback), Self.podsOnlyMaxNanos) + jitter()
                }
                podsAnswered = false
            }
            return Self.backoffNanos(streak: streak, fallback: fallback) + jitter()
        }
    }

    /// Feed the SHARED app state from a directory snapshot: reconcile pods
    /// (pending → online, surface new orders, drop ghosts) AND publish the
    /// unified Box Request Inbox. This is exactly what the per-screen pollers
    /// used to do — now driven from the one canal.
    private func feed(directory dir: PodsDirectoryResponse) async {
        // Pods + pending: reuse the existing reconciler. We hand it a fetcher
        // that just returns the directory we already have (no second round-trip).
        let reconciler = makeReconciler { _ in dir }
        await reconciler.reconcile()

        // Box Request Inbox: project each pod's `pendingRequests` digest into the
        // typed inbox (the SAME projection BootApprovalWatcher's pollAwaiting
        // does). Unknown/future purposes a not-yet-updated client can't satisfy
        // are dropped (they need no affordance).
        var inbox: [String: [BoxRequest]] = [:]
        for pod in dir.pods {
            let key = pod.serverDomain.lowercased()
            let reqs: [BoxRequest] = pod.pendingRequests.compactMap { r in
                guard let purpose = SecretPurpose(rawValue: r.type) else { return nil }
                return BoxRequest(
                    nonceHex: r.id,
                    serverDomain: pod.serverDomain,
                    type: purpose,
                    issuedAt: r.issuedAt,
                    expiresAt: r.expiresAt
                )
            }
            if !reqs.isEmpty { inbox[key] = reqs }
        }
        app.boxRequestInbox = inbox
    }
}
