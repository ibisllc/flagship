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
    public static let notEnrolled = "Turn on Quick approve from Apple Watch in Flagship on your iPhone first."
    /// The app is in front on the iPhone but hasn't used Face ID this session.
    public static let unlockOnce = "Unlock Flagship on your iPhone once, then approve again."
    /// The app is closed or in the background.
    public static let openAndUnlock = "Open Flagship on your iPhone and unlock it once, then approve again."
    public static let signedOut = "Sign in to Flagship on your iPhone first."
    public static let gone = "This server isn't waiting any more."
    /// The iPhone's app is locked behind a required update (docs/security-notices.md 6.3).
    public static let updateRequired = "Update Flagship on your iPhone first. Approving is paused until you do."

    let delegateEnrolled: () -> Bool
    let hasSessionKey: () -> Bool
    let appInForeground: () -> Bool
    let onNeedsUnlock: (_ requestId: String) -> Void
    let makeSource: () -> (any WatchApprovalSource)?
    let isPaused: () -> Bool

    public init(
        delegateEnrolled: @escaping () -> Bool,
        hasSessionKey: @escaping () -> Bool,
        appInForeground: @escaping () -> Bool = { false },
        onNeedsUnlock: @escaping (_ requestId: String) -> Void = { _ in },
        makeSource: @escaping () -> (any WatchApprovalSource)?,
        isPaused: @escaping () -> Bool = { UpdateLock.shared.isLocked }
    ) {
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
        guard cmd.kind == "approve-unlock" else { return fail("The watch asked for something this iPhone can't do.") }
        guard delegateEnrolled() else { return fail(Self.notEnrolled) }
        guard hasSessionKey() else {
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
            // No auto-unlock lease: that deposit is signed with the owner IRK,
            // and the delegate's approval covers this unlock alone.
            try await source.confirmAndRespond(req, depositAutoLease: false)
            return WatchProtocol.ApproveReply(requestId: cmd.requestId, ok: true)
        } catch {
            return fail("Approval failed: \(error.localizedDescription)")
        }
    }
}
