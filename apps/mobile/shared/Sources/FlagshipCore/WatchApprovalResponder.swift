import Foundation

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
/// account key; otherwise it tells the watch what to do on the phone.
@MainActor
public struct WatchApprovalResponder {
    public static let notEnrolled = "Turn on Quick approve from Apple Watch in Flagship on your iPhone first."
    public static let phoneLocked = "Open Flagship on your iPhone, then approve again."
    public static let signedOut = "Sign in to Flagship on your iPhone first."
    public static let gone = "This server isn't waiting any more."

    let delegateEnrolled: () -> Bool
    let hasSessionKey: () -> Bool
    let makeSource: () -> (any WatchApprovalSource)?

    public init(
        delegateEnrolled: @escaping () -> Bool,
        hasSessionKey: @escaping () -> Bool,
        makeSource: @escaping () -> (any WatchApprovalSource)?
    ) {
        self.delegateEnrolled = delegateEnrolled
        self.hasSessionKey = hasSessionKey
        self.makeSource = makeSource
    }

    public func respond(to cmd: WatchProtocol.ApproveCommand) async -> WatchProtocol.ApproveReply {
        func fail(_ message: String) -> WatchProtocol.ApproveReply {
            WatchProtocol.ApproveReply(requestId: cmd.requestId, ok: false, errorMessage: message)
        }
        guard cmd.kind == "approve-unlock" else { return fail("The watch asked for something this iPhone can't do.") }
        guard delegateEnrolled() else { return fail(Self.notEnrolled) }
        guard hasSessionKey() else { return fail(Self.phoneLocked) }
        guard let source = makeSource() else { return fail(Self.signedOut) }
        do {
            let pending = try await source.fetchVerifiedRequests()
            guard let req = pending.first(where: { $0.id == cmd.requestId && $0.purpose == .unlockKey }) else {
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
