import Foundation
import Observation
import FlagshipCore

/// The narrow capability `BootUnlockApprovalViewModel` needs from the
/// boot-secret relay: poll the account's verified unlock requests, and
/// approve one. Production backs this with `SecretRequestCoordinator`
/// (built from the environment exactly as `SecretRequestsContainer` does);
/// tests back it with a fake so the VM drives without network or biometric.
@MainActor
public protocol ApprovalSource {
    /// The freshest verified, non-expired unlock-key + expired-but-present
    /// requests for `serverDomain`, as resolved + re-verified against the
    /// directory STK. (Filtering to one server happens in the VM so the
    /// source can stay the coordinator's whole-account fetch.)
    func verifiedRequests() async throws -> [SecretRequestCoordinator.VerifiedRequest]
    /// Approve one request — re-seals the LUKS key for the box and posts it.
    /// `depositAutoLease` ⇒ the server's mode is "auto" (also deposit a
    /// box-sealed self-unlock lease). Biometric (IRK) fires inside here.
    @discardableResult
    func approve(_ request: SecretRequestCoordinator.VerifiedRequest, depositAutoLease: Bool) async throws -> String?
}

/// `SecretRequestCoordinator` already IS the production approval source —
/// this thin conformance exposes it under the testable protocol.
extension SecretRequestCoordinator: ApprovalSource {
    public func verifiedRequests() async throws -> [SecretRequestCoordinator.VerifiedRequest] {
        try await fetchVerifiedRequests()
    }
    @discardableResult
    public func approve(_ request: SecretRequestCoordinator.VerifiedRequest, depositAutoLease: Bool) async throws -> String? {
        try await confirmAndRespond(request, depositAutoLease: depositAutoLease)
    }
}

/// Surfaces a box's pending boot-unlock request on the server page so the
/// owner can approve it WITHOUT relying on push. The request is parked in
/// the identity-plane mailbox; this VM polls it, so push is just an
/// accelerator (it foregrounds the app sooner) — not a requirement.
///
/// Mirrors `ProvisionTimelineViewModel`'s shape: `@MainActor @Observable`,
/// injected `pollIntervalNanos` (tests pass 1ms), `start()`/`stop()`, a
/// `task` loop calling `pollOnce()`, a soft wall-clock timeout. The
/// coordinator + clock are injected (`makeCoordinator` closure, `now`) so
/// the VM never hard-codes the Keychain / Date.
@MainActor
@Observable
public final class BootUnlockApprovalViewModel {
    /// 5 seconds between polls. `nonisolated` so the `init` default-argument
    /// expression (evaluated at a possibly-nonisolated caller) can read it —
    /// safe: an immutable Sendable constant, not main-actor state.
    public nonisolated static let pollInterval: UInt64 = 5_000_000_000
    /// Soft cap: stop polling after ~45 min — a box that hasn't been approved
    /// by then has almost certainly given up, so stop burning battery.
    public nonisolated static let watchTimeout: UInt64 = 45 * 60_000_000_000

    public enum State: Equatable {
        /// No request for this server is in the mailbox.
        case idle
        /// A live, non-expired unlock-key request is waiting for approval.
        case waiting(SecretRequestCoordinator.VerifiedRequest)
        /// A request existed but is now past its expiry — the box has almost
        /// certainly stopped polling; the user must power-cycle it.
        case stoppedWaiting
        /// Approval crypto + POST in flight.
        case approving
        /// Approval delivered; the box should come online shortly.
        case approved
        /// The last poll/approve failed; Retry re-polls.
        case failed(String)
    }

    public private(set) var state: State = .idle

    private let serverDomain: String
    private let makeCoordinator: () -> ApprovalSource?
    private let pollIntervalNanos: UInt64
    private let now: () -> Int64
    /// "auto" servers deposit a self-unlock lease on approve. Read from the
    /// per-server `BootUnlockStore` so the approval matches the create-time
    /// choice; nil-store ⇒ the product default ("auto").
    private let store: BootUnlockStore
    private var task: Task<Void, Never>?

    public init(
        serverDomain: String,
        makeCoordinator: @escaping () -> ApprovalSource?,
        store: BootUnlockStore = BootUnlockStore(),
        pollIntervalNanos: UInt64 = BootUnlockApprovalViewModel.pollInterval,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.serverDomain = serverDomain
        self.makeCoordinator = makeCoordinator
        self.store = store
        self.pollIntervalNanos = pollIntervalNanos
        self.now = now
    }

    public func start() {
        stop()
        let startedAt = DispatchTime.now().uptimeNanoseconds
        task = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if DispatchTime.now().uptimeNanoseconds - startedAt > Self.watchTimeout { return }
                let done = await self.pollOnce()
                if done { return }
                try? await Task.sleep(nanoseconds: self.pollIntervalNanos)
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
    }

    /// One poll round-trip. Returns true if the loop should stop (a
    /// successful approval is the only stop condition; everything else keeps
    /// polling — a box can power-cycle and re-ask).
    private func pollOnce() async -> Bool {
        // A just-delivered approval is terminal; never let a late poll undo it.
        if case .approving = state { return false }
        if case .approved = state { return true }

        guard let coord = makeCoordinator() else { return false }
        let verified: [SecretRequestCoordinator.VerifiedRequest]
        do {
            verified = try await coord.verifiedRequests()
        } catch {
            // Transient — keep the prior state, try again next tick. Don't
            // thrash to .failed on a network blip.
            return false
        }

        let mine = verified
            .filter { $0.serverDomain == serverDomain && $0.purpose == .unlockKey }
            .sorted { $0.pending.postedAt > $1.pending.postedAt }

        // A live (non-expired) request wins outright.
        if let live = mine.first(where: { now() <= $0.pending.expiresAt }) {
            state = .waiting(live)
            return false
        }
        // Only an expired one present ⇒ the box gave up.
        if mine.contains(where: { now() > $0.pending.expiresAt }) {
            state = .stoppedWaiting
            return false
        }
        // None for this server. If we WERE waiting/approving and it vanished,
        // the box stopped polling rather than us succeeding — say so. (An
        // .approved state already returned above, so it's preserved.)
        switch state {
        case .waiting, .approving:
            state = .stoppedWaiting
        default:
            state = .idle
        }
        return false
    }

    public func approve() async {
        guard case .waiting(let req) = state else { return }
        guard let coord = makeCoordinator() else {
            state = .failed("Sign in to approve this box.")
            return
        }
        state = .approving
        do {
            let depositLease = store.effectiveMode(for: serverDomain) == .auto
            _ = try await coord.approve(req, depositAutoLease: depositLease)
            state = .approved
            stop()
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Re-poll after a failure (the card's Retry).
    public func retry() async {
        state = .idle
        _ = await pollOnce()
    }
}
