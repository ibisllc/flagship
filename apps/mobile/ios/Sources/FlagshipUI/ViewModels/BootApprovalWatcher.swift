import Foundation
import FlagshipCore

/// Account-level "which of my boxes are waiting for a boot-unlock approval
/// right now?" — ONE poll that fans the answer out to every server card,
/// detail page, and the post-creation checklist via
/// `AppState.serversAwaitingApproval`.
///
/// This is the list-wide complement to `BootUnlockApprovalViewModel`, which
/// owns the SINGLE-server card (the live request + the Approve action). Rather
/// than spin one of those per row (N pollers + N biometric-free fetches), this
/// watcher reuses the SAME `ApprovalSource.verifiedRequests()` account-wide
/// fetch once, maps the verified unlock-key requests to their serverDomains,
/// and publishes the set. A pod is `waitingForApproval` iff its fqdn is in it.
///
/// Mirrors `BootUnlockApprovalViewModel`'s shape: injected coordinator factory
/// + clock + poll interval (tests pass 1ms), best-effort (a fetch failure
/// leaves the prior set untouched — no thrash on a blip), no biometric (the
/// fetch is an IRK-signed *read*; Face ID stays only on the Approve mutation).
@MainActor
@Observable
public final class BootApprovalWatcher {
    /// 5s between polls — matches the per-server card so the two never drift.
    public nonisolated static let pollInterval: UInt64 = 5_000_000_000

    private let app: AppState
    private let makeCoordinator: () -> ApprovalSource?
    private let pollIntervalNanos: UInt64
    private let now: () -> Int64
    private var task: Task<Void, Never>?

    public init(
        app: AppState,
        makeCoordinator: @escaping () -> ApprovalSource?,
        pollIntervalNanos: UInt64 = BootApprovalWatcher.pollInterval,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.app = app
        self.makeCoordinator = makeCoordinator
        self.pollIntervalNanos = pollIntervalNanos
        self.now = now
    }

    public func start() {
        stop()
        task = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.pollOnce()
                try? await Task.sleep(nanoseconds: self.pollIntervalNanos)
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
    }

    /// One account-wide fetch → publish the set of fqdns with a LIVE
    /// (non-expired) unlock-key request. Best-effort: a throw leaves the set
    /// untouched. Exposed for the explicit pull-to-refresh.
    @discardableResult
    public func pollOnce() async -> Set<String> {
        guard let coord = makeCoordinator() else { return app.serversAwaitingApproval }
        let verified: [SecretRequestCoordinator.VerifiedRequest]
        do {
            verified = try await coord.verifiedRequests()
        } catch {
            return app.serversAwaitingApproval
        }
        let t = now()
        let waiting = Set(
            verified
                .filter { $0.purpose == .unlockKey && t <= $0.pending.expiresAt }
                .map { $0.serverDomain.lowercased() }
        )
        app.serversAwaitingApproval = waiting
        return waiting
    }
}
