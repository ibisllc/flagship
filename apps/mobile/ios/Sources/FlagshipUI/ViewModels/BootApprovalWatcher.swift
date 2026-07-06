import Foundation
import FlagshipCore

/// Account-level "which of my boxes are waiting for an approval right now, and
/// for WHAT?" — ONE poll that publishes the unified Box Request Inbox
/// (docs/box-request-inbox.md) into `AppState.boxRequestInbox` (keyed by
/// lowercased fqdn → the typed `[BoxRequest]`). Every server card, detail page,
/// and the post-creation checklist read their per-server state off that one
/// object — `unlock-key` and `entitlement` are two `type` values in one inbox,
/// not two parallel sets, so a new request type later is one registry entry, no
/// new watcher/boolean.
///
/// DIRECTORY-DRIVEN, NO BIOMETRIC. Detection reads the unauthenticated `/pods`
/// directory's cheap `pendingRequests` digest — NOT the IRK-signed mailbox. The
/// previous implementation polled `verifiedRequests()` every 5s, which derives
/// the IRK from the Secure Enclave: on a real device that fired Face ID every
/// five seconds on the Home tab (it was silent only on the simulator, where the
/// wrap key is a plain Keychain item — which is why it slipped through). Face ID
/// now fires ONLY on the actual Approve mutation, never to detect.
@MainActor
@Observable
public final class BootApprovalWatcher {
    /// 5s between directory polls — a cheap unauthenticated GET, so a box that
    /// starts waiting surfaces its Approve affordance within a few seconds
    /// without any prompt.
    public nonisolated static let pollInterval: UInt64 = 5_000_000_000

    private let app: AppState
    /// Refresh the `/pods` directory (unauthenticated, NO biometric) and return
    /// the unified inbox the directory reports (lowercased fqdn → `[BoxRequest]`).
    private let pollAwaiting: () async -> [String: [BoxRequest]]
    private let pollIntervalNanos: UInt64
    private var task: Task<Void, Never>?

    public init(
        app: AppState,
        pollAwaiting: @escaping () async -> [String: [BoxRequest]],
        pollIntervalNanos: UInt64 = BootApprovalWatcher.pollInterval
    ) {
        self.app = app
        self.pollAwaiting = pollAwaiting
        self.pollIntervalNanos = pollIntervalNanos
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

    /// One directory refresh → publish the unified inbox. Best-effort: the
    /// closure swallows failures and returns the prior inbox, so a blip never
    /// thrashes the UI. Exposed for pull-to-refresh.
    @discardableResult
    public func pollOnce() async -> [String: [BoxRequest]] {
        let inbox = await pollAwaiting()
        app.boxRequestInbox = inbox
        return inbox
    }
}
