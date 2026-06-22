import Foundation
import Observation
import FlagshipCore

/// The narrow capability `BootUnlockApprovalViewModel` needs from the
/// boot-secret relay. Production backs this with `SecretRequestCoordinator`
/// (built from the environment exactly as `SecretRequestsContainer` does);
/// tests back it with a fake so the VM drives without network or biometric.
@MainActor
public protocol ApprovalSource {
    /// The freshest verified, non-expired unlock-key requests for the account,
    /// re-verified against the directory STK. Still used by the account-wide
    /// approvals LIST (`SecretRequestsContainer`), which is user-initiated.
    /// Biometric (IRK) fires inside here, so it must NOT run on a timer.
    func verifiedRequests() async throws -> [SecretRequestCoordinator.VerifiedRequest]
    /// Approve one already-fetched request. (Used by the full approvals list.)
    @discardableResult
    func approve(_ request: SecretRequestCoordinator.VerifiedRequest, depositAutoLease: Bool) async throws -> String?
    /// One-tap approval for the directory-driven server card: fetch+verify the
    /// live unlock-key request for `serverDomain` and respond, all under a
    /// SINGLE biometric (the coordinator's key providers are memoized). No
    /// separate "check" step — the directory's `awaitingUnlock` flag already
    /// told the UI a request is pending. Throws `.noPendingRequest` if the box
    /// gave up between the directory refresh and the tap.
    @discardableResult
    func approvePendingUnlock(serverDomain: String, depositAutoLease: Bool) async throws -> String?
    /// One-tap approval for the directory-driven ENTITLEMENT card (serve-auth) —
    /// fetch+verify the live `entitlement` request for `serverDomain` and respond
    /// under a single biometric. Satisfied directly by the coordinator's method.
    @discardableResult
    func approvePendingEntitlement(serverDomain: String) async throws -> String?
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
    // `approvePendingUnlock(serverDomain:depositAutoLease:)` is satisfied
    // directly by the coordinator's own method of the same name.
}

/// Backs the per-server boot-unlock approval card. DIRECTORY-DRIVEN: the box's
/// pending request is detected by the pod's cheap `awaitingUnlock` flag (from
/// the unauthenticated `/pods` directory — NO biometric), so the card surfaces
/// the Approve/Deny prompt the instant the directory says the box is waiting,
/// with no "check for unlock request" tap and no Face ID just to look. Face ID
/// fires ONCE, only when the owner taps Approve (the whole ceremony — mailbox
/// fetch, unseal, response, lease — runs under a single biometric).
@MainActor
@Observable
public final class BootUnlockApprovalViewModel {
    public enum State: Equatable {
        /// The directory doesn't show this box waiting — render nothing.
        case idle
        /// The directory says the box is waiting; show Approve/Deny. No
        /// biometric has fired (or will, until the owner taps Approve).
        case requestPending
        /// Approval crypto + POST in flight (the one Face ID happened here).
        case approving
        /// Approval delivered; the box should come online shortly.
        case approved
        /// The approve failed (incl. the box already gave up). Retry re-arms.
        case failed(String)
    }

    public private(set) var state: State = .idle

    private let serverDomain: String
    /// Which inbox request this card approves: `.unlockKey` (release the disk
    /// key) or `.entitlement` (authorize the box to serve). The detection flag
    /// and the approve dispatch both key off this, so ONE card type serves both
    /// lanes of the Box Request Inbox.
    private let purpose: SecretPurpose
    private let makeCoordinator: () -> ApprovalSource?
    /// "auto" servers deposit a self-unlock lease on approve. Read from the
    /// per-server `BootUnlockStore` so the approval matches the create-time
    /// choice; nil-store ⇒ the product default ("auto").
    private let store: BootUnlockStore
    /// Latches when the owner taps Deny, so the card doesn't immediately
    /// reappear while the directory flag is still set this session.
    private var denied = false

    public init(
        serverDomain: String,
        purpose: SecretPurpose = .unlockKey,
        makeCoordinator: @escaping () -> ApprovalSource?,
        store: BootUnlockStore = BootUnlockStore(),
        initialAwaiting: Bool = false
    ) {
        self.serverDomain = serverDomain
        self.purpose = purpose
        self.makeCoordinator = makeCoordinator
        self.store = store
        // Seed the state from the directory flag so the FIRST body render is
        // already the request card (a non-empty view) when the box is waiting —
        // instead of an `EmptyView` (.idle) that depends on `.onAppear` firing to
        // flip it (a zero-size view's onAppear can silently no-op inside a
        // ScrollView; that left the Approve card permanently blank for a box that
        // was already waiting when the screen opened — the live office.harry2 bug).
        if initialAwaiting { self.state = .requestPending }
    }

    /// Directory-driven surfacing — NO biometric, NO network. The card calls
    /// this with the pod's `awaitingUnlock` flag on appear and whenever it
    /// changes. `true` arms the Approve/Deny prompt; `false` (box unlocked or
    /// gave up) clears it. Never disturbs an in-flight or terminal approve.
    public func setAwaitingUnlock(_ awaiting: Bool) {
        switch state {
        case .approving, .approved:
            return
        case .failed:
            // Keep a failure visible until the user acts; but if the box is no
            // longer waiting, the failure is moot — clear it.
            if !awaiting { state = .idle; denied = false }
            return
        case .idle, .requestPending:
            break
        }
        if awaiting {
            state = denied ? .idle : .requestPending
        } else {
            denied = false
            state = .idle
        }
    }

    /// Owner tapped Approve. ONE biometric ceremony: fetch+verify the live
    /// request, unseal the key, respond, and (auto mode) deposit the lease —
    /// all under a single Face ID via the memoized coordinator.
    public func approve() async {
        guard let coord = makeCoordinator() else {
            state = .failed("Sign in to approve this box.")
            return
        }
        state = .approving
        do {
            switch purpose {
            case .unlockKey:
                // "auto" servers also get a box-sealed self-unlock lease.
                let depositLease = store.effectiveMode(for: serverDomain) == .auto
                _ = try await coord.approvePendingUnlock(serverDomain: serverDomain, depositAutoLease: depositLease)
            case .entitlement:
                _ = try await coord.approvePendingEntitlement(serverDomain: serverDomain)
            }
            state = .approved
        } catch {
            state = .failed(HumanError.humanize(error))
        }
    }

    /// Owner tapped Deny — hide the prompt for this session without contacting
    /// the box (it simply times out on its own and power-cycles to re-ask).
    public func deny() {
        denied = true
        state = .idle
    }

    /// Re-arm after a failure (the card's Retry) — back to the pending prompt.
    public func retry() {
        denied = false
        state = .requestPending
    }

    /// No background work to tear down anymore (detection is directory-driven),
    /// but the card still calls this on disappear.
    public func stop() {}
}
