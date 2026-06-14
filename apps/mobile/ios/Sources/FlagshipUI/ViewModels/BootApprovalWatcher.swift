import Foundation
import FlagshipCore

/// Account-level "which of my boxes are waiting for a boot-unlock approval
/// right now?" — ONE poll that fans the answer out to every server card,
/// detail page, and the post-creation checklist via
/// `AppState.serversAwaitingApproval`.
///
/// DIRECTORY-DRIVEN, NO BIOMETRIC. Detection reads the unauthenticated `/pods`
/// directory's cheap `awaitingUnlock` flag — NOT the IRK-signed mailbox. The
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
    /// the set of server fqdns the directory marks `awaitingUnlock`.
    private let pollAwaiting: () async -> Set<String>
    private let pollIntervalNanos: UInt64
    private var task: Task<Void, Never>?

    public init(
        app: AppState,
        pollAwaiting: @escaping () async -> Set<String>,
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

    /// One directory refresh → publish the set of fqdns with a live unlock
    /// request. Best-effort: the closure swallows failures and returns the
    /// prior set, so a blip never thrashes the UI. Exposed for pull-to-refresh.
    @discardableResult
    public func pollOnce() async -> Set<String> {
        let waiting = await pollAwaiting()
        app.serversAwaitingApproval = waiting
        return waiting
    }
}
