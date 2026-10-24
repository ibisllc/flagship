import Foundation
import FlagshipAPI

/// What the watch's Approve needs from the boot-secret relay. Production is
/// `SecretRequestCoordinator`; tests use a fake.
@MainActor
public protocol WatchApprovalSource {
    func fetchVerifiedRequests() async throws -> [SecretRequestCoordinator.VerifiedRequest]
    @discardableResult
    func confirmAndRespond(_ verified: SecretRequestCoordinator.VerifiedRequest, depositAutoLease: Bool) async throws -> String?
}

extension SecretRequestCoordinator: WatchApprovalSource {}

/// Answers the watch's "approve this boot unlock" on the phone. The watch only
/// asks; the phone does the approval it would do for its own Approve button:
/// it re-fetches the pending requests, re-verifies them against the directory
/// STK, unseals the disk key and posts the sealed response, signed with the
/// watch-delegate key (role "delegate", scope "boot-approval") that the boot
/// relay checks against the owner's IRK-attested grant. The consent is that
/// signature, never a flag the watch sends.
///
/// It never starts a Face ID prompt: the phone may be in a pocket with the app
/// in the background, so it proceeds only when the owner opted into quick
/// approve (a delegate key is enrolled) and this app session already holds the
/// account key. Otherwise it tells the watch exactly what to do on the phone
/// (turn on Quick approve, unlock the open app once, or open the app and
/// unlock it) and calls `onNeedsUnlock`, so the app, once in front, can say
/// the watch is waiting.
@MainActor
public struct WatchApprovalResponder {
    public static let notEnrolled = String(localized: "Turn on Approve from watch in Flagship on your iPhone first.")
    /// The app is in front on the iPhone but hasn't used Face ID this session.
    public static let unlockOnce = String(localized: "Unlock Flagship on your iPhone once, then approve again.")
    /// The app is closed or in the background.
    public static let openAndUnlock = String(localized: "Open Flagship on your iPhone and unlock it once, then approve again.")
    public static let signedOut = String(localized: "Sign in to Flagship on your iPhone first.")
    public static let gone = String(localized: "This server isn't waiting any more.")
    /// A server this phone has not pinned yet is approved once on the iPhone, where its code shows.
    public static let approveOnPhoneFirst = String(localized: "Approve this server once on your iPhone first. Its code shows there.")
    /// The iPhone's app is locked behind a required update (docs/security-notices.md 6.3).
    public static let updateRequired = String(localized: "Update Flagship on your iPhone first. Approving is paused until you do.")
    /// The owner locked the server (SEC-LOCK-001): a watch can't start it.
    public static let serverLocked = String(localized: "This server is locked. Approve its start-up from your iPhone.")
    /// The directory's box key differs from the one this phone pinned: nothing was sent.
    public static let keyMismatch = String(localized: "This server's key doesn't match. Approve its start-up from your phone.")
    /// The start-up request isn't signed by the server's pinned key: nothing was sent.
    public static let badSignature = String(localized: "This start-up request isn't signed by your server. Approve it from your phone.")

    let delegateEnrolled: () -> Bool
    let hasSessionKey: () -> Bool
    let appInForeground: () -> Bool
    let onNeedsUnlock: (_ requestId: String) -> Void
    let makeSource: () -> (any WatchApprovalSource)?
    let isPaused: () -> Bool
    /// Option (a): answer without the account key, from this watch's copy of the server's disk key. Nil when
    /// the copy path isn't wired.
    let lockedApprove: ((_ requestId: String) async -> WatchBootApprover.Outcome)?

    public init(
        delegateEnrolled: @escaping () -> Bool,
        hasSessionKey: @escaping () -> Bool,
        appInForeground: @escaping () -> Bool = { false },
        onNeedsUnlock: @escaping (_ requestId: String) -> Void = { _ in },
        makeSource: @escaping () -> (any WatchApprovalSource)?,
        isPaused: @escaping () -> Bool = { UpdateLock.shared.isLocked },
        lockedApprove: ((_ requestId: String) async -> WatchBootApprover.Outcome)? = nil
    ) {
        self.lockedApprove = lockedApprove
        self.delegateEnrolled = delegateEnrolled
        self.hasSessionKey = hasSessionKey
        self.appInForeground = appInForeground
        self.onNeedsUnlock = onNeedsUnlock
        self.makeSource = makeSource
        self.isPaused = isPaused
    }

    public func respond(to cmd: WatchProtocol.ApproveCommand) async -> WatchProtocol.ApproveReply {
        func fail(_ message: String) -> WatchProtocol.ApproveReply {
            WatchProtocol.ApproveReply(requestId: cmd.requestId, ok: false, errorMessage: message)
        }
        if isPaused() { return fail(Self.updateRequired) }
        guard cmd.kind == "approve-unlock" else { return fail(String(localized: "The watch asked for something this iPhone can't do.")) }
        guard delegateEnrolled() else { return fail(Self.notEnrolled) }
        // The watch's own copy first: it needs no account key. The account-key path stays the fallback.
        var copyFailure: String?
        if let lockedApprove {
            switch await lockedApprove(cmd.requestId) {
            case .approved: return WatchProtocol.ApproveReply(requestId: cmd.requestId, ok: true)
            case .locked: return fail(Self.serverLocked)
            case .gone: return fail(Self.gone)
            case .keyMismatch: return fail(Self.keyMismatch)
            case .badSignature: return fail(Self.badSignature)
            case .failed(let message): copyFailure = message
            case .noCopy: break
            }
        }
        guard hasSessionKey() else {
            if let copyFailure { return fail(copyFailure) }
            onNeedsUnlock(cmd.requestId)
            return fail(appInForeground() ? Self.unlockOnce : Self.openAndUnlock)
        }
        guard let source = makeSource() else { return fail(Self.signedOut) }
        do {
            let pending = try await source.fetchVerifiedRequests()
            // The watch's row may come from the account inbox (`<fqdn>#<nonce>`
            // with the FQDN lower-cased) or the Approvals screen: same request.
            let wanted = cmd.requestId.lowercased()
            guard let req = pending.first(where: { $0.id.lowercased() == wanted && $0.purpose == .unlockKey }) else {
                return fail(Self.gone)
            }
            // Only a server this phone pinned: a first sight shows its code on the phone, a changed key is refused.
            switch req.trust {
            case .pinned: break
            case .keyChanged: return fail(FirstContact.keyChangedText)
            case .notFromRecipe: return fail(FirstContact.notFromRecipeText)
            case .firstSight: return fail(Self.approveOnPhoneFirst)
            }
            // No auto-unlock lease: that deposit is signed with the owner IRK,
            // and the delegate's approval covers this unlock alone.
            try await source.confirmAndRespond(req, depositAutoLease: false)
            return WatchProtocol.ApproveReply(requestId: cmd.requestId, ok: true)
        } catch ScreensClientError.http(let status, _) where status == 423 {
            return fail(Self.serverLocked)
        } catch {
            return fail(String(localized: "Approval failed: \(error.localizedDescription)"))
        }
    }
}
