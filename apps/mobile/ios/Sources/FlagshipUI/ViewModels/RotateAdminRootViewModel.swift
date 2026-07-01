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
///   5. only on success re-seals the NEW root device-local + re-escrows it
///      under recovery.
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
/// new root unrecorded). So the local re-seal is the LAST step.
@Observable
@MainActor
public final class RotateAdminRootViewModel {

    public enum Phase: Equatable, Sendable {
        case idle
        case rotating
        /// Rotation accepted + the new root re-sealed. `newAdminRootPubHex` is
        /// the account's new authority anchor (lowercased hex).
        case rotated(newAdminRootPubHex: String)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle

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
    /// Seam: re-escrow the NEW root under the WebAuthn-PRF recovery credential
    /// (§5.2 / D-3). Runs after a successful rotation so a later credential
    /// recovery can re-establish the CURRENT root. Optional: the host wires it
    /// to the recovery re-enroll flow (which needs the recovery passphrase /
    /// credential); nil ⇒ skipped (the user can re-run recovery setup later).
    private let reEscrowNewAdminRoot: (@MainActor () async -> Void)?

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
        reEscrowNewAdminRoot: (@MainActor () async -> Void)? = nil
    ) {
        self.server = server
        self.username = username
        self.hasAdminRoot = hasAdminRoot
        self.loadOldAdminRoot = loadOldAdminRoot
        self.sealNewAdminRoot = sealNewAdminRoot
        self.reEscrowNewAdminRoot = reEscrowNewAdminRoot
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

        // 5 — .com accepted; NOW replace the local root + re-escrow it. A
        // re-seal failure here leaves the account rotated at `.com`/boxes but
        // this device still holding the OLD root — surface it so the user can
        // recover onto the new root.
        do {
            try await sealNewAdminRoot(newRoot.rawRepresentation)
        } catch {
            phase = .failed("Your admin key was rotated, but saving it on this device failed. Recover on this device to finish. (\(error.localizedDescription))")
            return
        }
        await reEscrowNewAdminRoot?()

        phase = .rotated(newAdminRootPubHex: newPubHex)
    }

    public func reset() { phase = .idle }
}
