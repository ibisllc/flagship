import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Slice D §5 — the owner-facing "Rotate admin key" action (Account security /
/// a "my device may be compromised" flow).
///
/// Rotation is the compromise remedy AND the revoke-every-other-admin remedy.
/// It:
///   1. loads the CURRENT admin master root (biometric),
///   2. mints a fresh RANDOM new admin master root,
///   3. signs the spine `admin-root-rotation/v1` envelope with the OLD root
///      (`old → new`, the box verifies it against its pinned OLD root — `.com`
///      is never a trust anchor),
///   4. POSTs it to `.com` `POST /api/users/:username/admin-root-rotation`,
///   5. only on success re-seals the NEW root device-local,
///   6. then — if recovery is enrolled — asks the user for the interactive
///      re-escrow step (§5.3 / D-3): the recovery envelope still wraps the
///      OLD root, so a later credential recovery would restore a dead key
///      until the user runs `updateRecoveryBackup(passphrase:)` (recovery
///      passphrase + WebAuthn PRF against the EXISTING credential; see
///      `AdminRootReEscrow`).
///
/// ⚠️ Rotation EXCLUDES every OTHER admin device: they still hold the OLD root,
/// so once each box re-pins to the new root their old-root-signed orders stop
/// verifying. That IS the "revoke an admin" / "a device may be stolen"
/// semantic — there is no separate per-device admin-revoke; you rotate and the
/// non-recovering admins fall out. A device promoted via a master-root SEAL
/// (bare-root admin) can only be removed this way (it holds a key, not a
/// grant), which is exactly the accepted trade-off in the spec (§4.3).
///
/// Order matters: sign + POST FIRST, and re-seal the NEW root locally only
/// AFTER `.com` accepts it. If the POST fails we must NOT have already
/// replaced this device's sealed root — that would strand it (old root gone,
/// new root unrecorded). So the local re-seal is the LAST mutating step, and
/// the recovery re-escrow comes strictly AFTER it: by then the rotation is
/// published + sealed, so a re-escrow failure (or skip) can never fail the
/// rotation itself — it only leaves the recovery backup pointing at the old
/// root, which the user can fix later by re-running recovery setup.
@Observable
@MainActor
public final class RotateAdminRootViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case rotating
        /// Rotation accepted + the new root re-sealed. `newAdminRootPubHex` is
        /// the account's new authority anchor (lowercased hex).
        case rotated(newAdminRootPubHex: String)
        /// Rotation accepted + sealed, but recovery is enrolled and its
        /// envelope still wraps the OLD root — the UI renders the inline
        /// re-escrow step (passphrase → `updateRecoveryBackup`, or
        /// `skipRecoveryUpdate`). The rotation itself is DONE in this state.
        case rotatedNeedsRecoveryUpdate(newAdminRootPubHex: String)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    /// True while `updateRecoveryBackup` is in flight (drives the button's
    /// progress state).
    public private(set) var isUpdatingRecoveryBackup = false
    /// Inline, retryable error from the last `updateRecoveryBackup` attempt.
    public private(set) var recoveryUpdateError: String?
    /// Set by `skipRecoveryUpdate` so the UI can warn that the recovery
    /// backup still wraps the OLD admin root.
    public private(set) var didSkipRecoveryUpdate = false

    private let server: any FlagshipServerClient
    private let username: @MainActor () -> String?

    /// Seam: does THIS device hold the admin master root? Only such a device
    /// can rotate (it must sign `old → new` with the OLD root). Defaults to
    /// `Keystore.hasAdminRoot`.
    private let hasAdminRoot: @MainActor () -> Bool
    /// Seam: unseal the CURRENT admin master root (biometric). Defaults to
    /// `Keystore.adminRootKey`.
    private let loadOldAdminRoot: @MainActor (String) async throws -> Curve25519.Signing.PrivateKey
    /// Seam: seal the freshly-minted NEW admin root seed device-local.
    /// Defaults to `Keystore.importAdminRoot`.
    private let sealNewAdminRoot: @MainActor (Data) async throws -> Void
    /// Seam: is WebAuthn-PRF cloud recovery enrolled for this account? Decides
    /// whether a successful rotation lands in `.rotatedNeedsRecoveryUpdate`
    /// (the envelope wraps the OLD root and needs the interactive re-escrow)
    /// or straight in `.rotated`. A throw is treated as "not enrolled" — the
    /// check is best-effort and must NEVER fail an already-published rotation.
    /// Defaults to `server.hasCloudRecovery`.
    private let recoveryEnrolled: @MainActor () async throws -> Bool
    /// Seam: the interactive re-escrow of the CURRENT admin root under the
    /// existing recovery credential (§5.3 / D-3), taking the user's recovery
    /// passphrase. Defaults to `AdminRootReEscrow` built on the production
    /// WebAuthn provider — the passphrase + PRF assert EMIT the wrap key, so
    /// the step is user-driven, not automatic.
    private let reEscrow: @MainActor (String) async throws -> Void

    private struct NoAccountError: LocalizedError {
        var errorDescription: String? { "No active account on this device." }
    }

    public init(
        server: any FlagshipServerClient,
        username: @escaping @MainActor () -> String?,
        hasAdminRoot: @escaping @MainActor () -> Bool = { Keystore.hasAdminRoot },
        loadOldAdminRoot: @escaping @MainActor (String) async throws -> Curve25519.Signing.PrivateKey = { reason in
            try await Keystore.adminRootKey(reason: reason)
        },
        sealNewAdminRoot: @escaping @MainActor (Data) async throws -> Void = { seed in
            _ = try await Keystore.importAdminRoot(seed: seed, reason: "Save your new admin key")
        },
        recoveryEnrolled: (@MainActor () async throws -> Bool)? = nil,
        reEscrow: (@MainActor (String) async throws -> Void)? = nil
    ) {
        self.server = server
        self.username = username
        self.hasAdminRoot = hasAdminRoot
        self.loadOldAdminRoot = loadOldAdminRoot
        self.sealNewAdminRoot = sealNewAdminRoot
        self.recoveryEnrolled = recoveryEnrolled ?? {
            guard let user = username(), !user.isEmpty else { return false }
            return try await server.hasCloudRecovery(username: user)
        }
        self.reEscrow = reEscrow ?? { passphrase in
            guard let user = username(), !user.isEmpty else { throw NoAccountError() }
            try await AdminRootReEscrow(
                client: server,
                webAuthn: PlatformWebAuthnProvider()
            ).run(username: user, passphrase: passphrase)
        }
    }

    /// True iff the control should be enabled — only a device that holds the
    /// master root can drive a rotation (§8.2).
    public var canRotate: Bool { hasAdminRoot() }

    /// Run the rotation. Idempotent-safe to retry on failure (nothing local is
    /// mutated until `.com` accepts).
    public func rotate() async {
        guard let user = username(), !user.isEmpty else {
            phase = .failed("No active account on this device.")
            return
        }
        guard hasAdminRoot() else {
            phase = .failed("This device isn't an admin, so it can't rotate the admin key.")
            return
        }
        phase = .rotating

        // 1 — the OLD root (the box's pinned anchor + the rotation signer).
        let oldRoot: Curve25519.Signing.PrivateKey
        do {
            oldRoot = try await loadOldAdminRoot("Rotate your admin key")
        } catch {
            phase = .failed("Couldn't access your admin key: \(error.localizedDescription)")
            return
        }
        let oldPubHex = HexUtil.encode(oldRoot.publicKey.rawRepresentation)

        // 2 — a fresh RANDOM new root (NOT derived — the authority root never is).
        let newRoot = Curve25519.Signing.PrivateKey()
        let newPubHex = HexUtil.encode(newRoot.publicKey.rawRepresentation)

        // 3 — sign the spine `old → new` proof with the OLD root.
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let rotation = AdminRootRotation(
            username: user,
            oldAdminRootPubHex: oldPubHex,
            newAdminRootPubHex: newPubHex,
            issuedAt: issuedAt
        )
        let signatureHex: String
        do {
            signatureHex = HexUtil.encode(try rotation.sign(withOldAdminRoot: oldRoot))
        } catch {
            phase = .failed("Couldn't sign the rotation: \(error.localizedDescription)")
            return
        }

        // 4 — publish. On any failure we STOP here: the local sealed root is
        // still the OLD one, so this device remains a working admin.
        do {
            _ = try await server.postAdminRootRotation(
                username: user,
                body: AdminRootRotationRequest(
                    rotation: .init(
                        username: user,
                        oldAdminRootPub: oldPubHex,
                        newAdminRootPub: newPubHex,
                        issuedAt: issuedAt
                    ),
                    signatureHex: signatureHex
                )
            )
        } catch {
            phase = .failed("Couldn't rotate your admin key: \(error.localizedDescription)")
            return
        }

        // 5 — .com accepted; NOW replace the local root. A re-seal failure
        // here leaves the account rotated at `.com`/boxes but this device
        // still holding the OLD root — surface it so the user can recover
        // onto the new root.
        do {
            try await sealNewAdminRoot(newRoot.rawRepresentation)
        } catch {
            phase = .failed("Your admin key was rotated, but saving it on this device failed. Recover on this device to finish. (\(error.localizedDescription))")
            return
        }

        // 6 — the rotation is DONE (published + sealed); everything from here
        // is best-effort and must not undo that. If recovery is enrolled, the
        // envelope still wraps the OLD root — hand the UI the interactive
        // re-escrow step. An enrollment-check failure ⇒ treat as not enrolled
        // (the user can always re-run recovery setup later).
        didSkipRecoveryUpdate = false
        recoveryUpdateError = nil
        let enrolled = (try? await recoveryEnrolled()) ?? false
        phase = enrolled
            ? .rotatedNeedsRecoveryUpdate(newAdminRootPubHex: newPubHex)
            : .rotated(newAdminRootPubHex: newPubHex)
    }

    /// Run the interactive re-escrow (§5.3 / D-3) with the user's recovery
    /// passphrase. Success completes the flow (`.rotated`); failure keeps the
    /// step on screen with an inline, retryable error — the rotation itself is
    /// already done either way.
    public func updateRecoveryBackup(passphrase: String) async {
        guard case .rotatedNeedsRecoveryUpdate(let newPubHex) = phase else { return }
        recoveryUpdateError = nil
        isUpdatingRecoveryBackup = true
        defer { isUpdatingRecoveryBackup = false }
        do {
            try await reEscrow(passphrase)
            phase = .rotated(newAdminRootPubHex: newPubHex)
        } catch {
            recoveryUpdateError = error.localizedDescription
        }
    }

    /// Decline the re-escrow step. The recovery envelope keeps wrapping the
    /// OLD admin root (a later credential recovery restores a dead key) — the
    /// UI warns via `didSkipRecoveryUpdate`; re-running recovery setup fixes it.
    public func skipRecoveryUpdate() {
        guard case .rotatedNeedsRecoveryUpdate(let newPubHex) = phase else { return }
        didSkipRecoveryUpdate = true
        recoveryUpdateError = nil
        phase = .rotated(newAdminRootPubHex: newPubHex)
    }

    public func reset() {
        phase = .idle
        recoveryUpdateError = nil
        didSkipRecoveryUpdate = false
    }
}
