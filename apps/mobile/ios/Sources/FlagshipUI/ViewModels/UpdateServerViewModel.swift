import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// "Update this server" — phone-ordered, dual-signed in-place update
/// (docs/server-update-mechanism.md).
///
/// Behind the biometric, the admin signs a `flagship/server-update/v1`
/// UpdateOrder naming THIS box + the target commit and deposits it on `.com`'s
/// update lane (`SecretMailboxClient.depositUpdate`). This is the AUTHORIZATION
/// half of the 2-of-2 gate only: the box re-verifies the order under its pinned
/// admin master root AND separately requires the target commit to be
/// maintainer-ENDORSED (the daemon's ReleaseGate) before applying — an order
/// alone can never push unblessed code, and the box rolls back automatically if
/// the new version fails its boot health gate.
///
/// `fromCommit` is ALWAYS the box-reported `currentCommit` from server-detail —
/// never a guess. Without it (old daemon / not a git checkout) the action is
/// disabled. Fire `update(targetCommit:)` once per tap — the biometric fires
/// ONCE inside `signer`.
@Observable
@MainActor
public final class UpdateServerViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case signing
        case posting
        case done
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

    private let username: String
    private let serverFqdn: String
    /// The box-reported running commit (server-detail `currentCommit`).
    /// nil ⇒ the box hasn't reported ⇒ no order can be minted.
    private let currentCommit: String?
    private let mailbox: any SecretMailboxClient
    private let signer: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    /// Resolves the admin master root when this device holds one, else nil
    /// (legacy: the order signs with the IRK). Injected for tests; the default
    /// reads the Keystore — NEVER a bare-IRK default when a root exists.
    private let adminRootKey: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey?
    private let now: () -> Int64

    public init(
        username: String,
        serverFqdn: String,
        currentCommit: String?,
        mailbox: any SecretMailboxClient,
        signer: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey)? = nil,
        adminRootKey: (@MainActor (String) async throws -> Curve25519.Signing.PrivateKey?)? = nil,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.username = username
        self.serverFqdn = serverFqdn
        self.currentCommit = currentCommit?.lowercased()
        self.mailbox = mailbox
        self.now = now
        self.signer = signer ?? { reason in try await Keystore.deriveIRK(reason: reason) }
        // Slice D — the update ORDER is SENSITIVE ⇒ it must sign with the admin
        // master root whenever this device holds one (the `.com` gate REJECTS an
        // IRK-signed order once a root is pinned); IRK only as the legacy
        // fallback for rootless accounts.
        self.adminRootKey = adminRootKey ?? { reason in
            Keystore.hasAdminRoot ? try await Keystore.adminRootKey(reason: reason) : nil
        }
    }

    /// True iff the box has reported a usable current commit — without it no
    /// order can be minted (`fromCommit` must be truth, never a guess).
    public var canUpdate: Bool {
        currentCommit.map(ServerUpdateFlow.isValidCommit) ?? false
    }

    /// The short display form of the running commit ("9f2c1ab3"), or nil.
    public var runningShort: String? {
        guard let c = currentCommit, ServerUpdateFlow.isValidCommit(c) else { return nil }
        return String(c.prefix(8))
    }

    /// Client-side validation for the target field (mirrors the webapp copy).
    /// Returns the failure copy, or nil when the target is orderable.
    public func targetProblem(_ raw: String) -> String? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if t.isEmpty { return nil }
        if !ServerUpdateFlow.isValidCommit(t) {
            return "Enter the full 40-character commit hash of the blessed release."
        }
        if t == currentCommit {
            return "The server is already running this release."
        }
        return nil
    }

    /// True iff `raw` names a complete, different, well-formed target.
    public func canOrder(_ raw: String) -> Bool {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return canUpdate && ServerUpdateFlow.isValidCommit(t) && t != currentCommit
    }

    /// Mint + sign + deposit the update order: biometric → sign → deposit.
    /// Returns true on success.
    @discardableResult
    public func update(targetCommit raw: String) async -> Bool {
        guard let from = currentCommit, ServerUpdateFlow.isValidCommit(from) else {
            phase = .failed("This server hasn't reported its current version yet.")
            return false
        }
        let target = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard ServerUpdateFlow.isValidCommit(target) else {
            phase = .failed("Enter the full 40-character commit hash of the blessed release.")
            return false
        }
        guard target != from else {
            phase = .failed("The server is already running this release.")
            return false
        }

        phase = .signing
        let body: UpdateDepositBody
        do {
            let reason = "Update \(serverFqdn)"
            let irk = try await signer(reason)
            let orderKey = try await adminRootKey(reason)
            body = try ServerUpdateFlow.buildDeposit(
                serverFqdn: serverFqdn,
                username: username,
                targetCommit: target,
                fromCommit: from,
                irk: irk,
                orderKey: orderKey,
                issuedAt: now()
            )
        } catch {
            phase = .failed("Couldn't sign the update order: \(error.localizedDescription)")
            return false
        }

        phase = .posting
        do {
            try await mailbox.depositUpdate(serverDomain: serverFqdn, body: body)
        } catch let e as ScreensClientError {
            phase = .failed(e.errorDescription ?? "That didn't work. Try again in a moment.")
            return false
        } catch {
            phase = .failed("Couldn't reach the server directory. Check your connection and try again.")
            return false
        }
        phase = .done
        return true
    }
}
