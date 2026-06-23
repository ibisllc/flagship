import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// "Set as preferred server" owner vote (per-service leadership Phase 6,
/// docs/multi-pod-liveness-session-leadership.md).
///
/// Behind the standard biometric, the owner signs the existing
/// `flagship/set-leader/v1` vote for the selected pod's STK and deposits it on
/// `.com`'s `set-leader` lane (`SecretMailboxClient.depositSetLeader`). The box
/// fetches the vote and rides it on its gossip frame (clout); the highest-clout
/// live runner of each service leads it. The UI shows the designated pod as
/// "preferred" IMMEDIATELY (via `app.setLeader`), independent of the box-side
/// gossip catch-up.
///
/// Fire `setPreferred()` once per tap — the biometric fires ONCE inside `signer`.
@Observable
@MainActor
public final class SetPreferredServerViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case signing
        case posting
        case done
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

    private let username: String
    private let serverDomain: String
    /// The chosen box's STK (32-byte hex) — the `preferredStkPubHex` the vote
    /// names. Empty ⇒ the pod has no registered STK yet (vote can't be cast).
    private let preferredStkPubHex: String
    private let mailbox: any SecretMailboxClient
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    private let now: () -> Int64

    public init(
        username: String,
        serverDomain: String,
        preferredStkPubHex: String,
        mailbox: any SecretMailboxClient,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.username = username
        self.serverDomain = serverDomain
        self.preferredStkPubHex = preferredStkPubHex
        self.mailbox = mailbox
        self.now = now
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
    }

    /// True iff a vote can be cast (the pod has a registered STK).
    public var canVote: Bool {
        HexUtil.decode(preferredStkPubHex)?.count == 32
    }

    /// Cast the preferred-server vote: biometric → sign → deposit. Returns true
    /// on success so the caller can mark the pod preferred locally.
    @discardableResult
    public func setPreferred() async -> Bool {
        guard canVote else {
            phase = .failed("This server has no registered identity yet.")
            return false
        }
        phase = .signing
        do {
            let irk = try await signer("Set \(serverDomain) as your preferred server")
            let body = try SetLeaderDeposit.buildDeposit(
                username: username,
                serverDomain: serverDomain,
                preferredStkPubHex: preferredStkPubHex,
                irk: irk,
                now: now()
            )
            phase = .posting
            try await mailbox.depositSetLeader(serverDomain: serverDomain, body: body)
            phase = .done
            return true
        } catch {
            phase = .failed("Couldn't set the preferred server. Please try again.")
            return false
        }
    }
}
