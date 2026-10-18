import Foundation
import Observation
import FlagshipCore
import FlagshipAPI

/// The Activity tab's "Server approvals" section: the account's pending
/// boot-secret requests, loaded once and answered in place. It lives above the
/// section so the header can show how many wait even while it is collapsed, and
/// it never depends on the daemon feed (a box waiting for approval is exactly
/// when that feed can't load).
///
/// Each request is RE-VERIFIED against the box's STK as resolved from the
/// directory before it is shown; approving fires the biometric inside the
/// coordinator, and the answer goes back through `.com`.
@Observable
@MainActor
public final class SecretRequestsModel {
    public typealias Request = SecretRequestCoordinator.VerifiedRequest

    public enum Outcome: Equatable, Sendable {
        case approved(serverDomain: String)
        /// Another device (or the box's own timeout) answered first: nothing
        /// to say, the card just goes.
        case alreadyAnswered
        case failed(String)
    }

    public static let emptyText = "Nothing waiting for you"
    public static let introText = "Your server is finishing setup. Confirm it's yours to release its boot secret. Only your phone can."
    public static let signInText = "Sign in to approve a server."

    public private(set) var state: LoadingState<[Request]> = .idle
    public private(set) var inFlightId: String?

    private let source: () -> (any ApprovalSource)?
    private let isFirstBootFor: (String) -> Bool
    private let bootUnlock: BootUnlockStore
    private let onRequests: ([Request]) -> Void

    /// `source` builds the coordinator for the signed-in account (nil when no
    /// one is signed in); `isFirstBoot` says whether the box behind a request
    /// has never come online, which picks the longer copy on its card.
    public init(
        source: @escaping () -> (any ApprovalSource)?,
        isFirstBoot: @escaping (String) -> Bool = { _ in true },
        bootUnlock: BootUnlockStore = BootUnlockStore(),
        onRequests: @escaping ([Request]) -> Void = { _ in }
    ) {
        self.source = source
        self.isFirstBootFor = isFirstBoot
        self.bootUnlock = bootUnlock
        self.onRequests = onRequests
    }

    /// How many requests wait; 0 until they have loaded.
    public var pendingCount: Int {
        if case .loaded(let r) = state { return r.count }
        return 0
    }

    public func isFirstBoot(_ serverDomain: String) -> Bool { isFirstBootFor(serverDomain) }

    public func reload() async {
        guard let source = source() else {
            state = .failed(Self.signInText)
            return
        }
        state = .loading
        do {
            let verified = try await source.verifiedRequests()
            state = .loaded(verified)
            onRequests(verified)
        } catch {
            state = .failed(UserErrorText.of(error))
        }
    }

    /// Loads when nothing has been asked yet (the section opening, a push).
    public func loadIfNeeded() async {
        if case .idle = state { await reload() }
    }

    @discardableResult
    public func approve(_ req: Request) async -> Outcome {
        guard let source = source() else { return .failed(Self.signInText) }
        inFlightId = req.id
        defer { inFlightId = nil }
        do {
            // "auto" servers (the default) also get a box-sealed lease so future
            // boots self-unlock without the phone. The returned lease id is the
            // kill-switch handle, kept per server. ("approve" servers deposit
            // nothing; the box asks again every boot.)
            let depositLease = bootUnlock.effectiveMode(for: req.serverDomain) == .auto
            let leaseId = try await source.approve(req, depositAutoLease: depositLease)
            if let leaseId { bootUnlock.setLeaseId(leaseId, for: req.serverDomain) }
            clear(req)
            await reload()
            return .approved(serverDomain: req.serverDomain)
        } catch {
            // `.com` answers 409 when the request was already answered: the
            // approval stands, so the card goes and no error is shown.
            if Self.isAlreadyAnswered(error) {
                clear(req)
                await reload()
                return .alreadyAnswered
            }
            return .failed("Approval failed: \(UserErrorText.of(error))")
        }
    }

    /// The card goes at once; the refresh that follows only confirms it.
    private func clear(_ req: Request) {
        guard case .loaded(let all) = state else { return }
        state = .loaded(all.filter { $0.id != req.id })
    }

    public static func isAlreadyAnswered(_ error: Error) -> Bool {
        if case ScreensClientError.http(409, _) = error { return true }
        return false
    }
}
