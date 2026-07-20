import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Backs the **Open account** step of create-onboarding.
///
/// Phase 2 of the login redesign decouples *account identity* from
/// *server provisioning* (`docs/login-and-account-redesign.md`,
/// principles 1 + 6). Creating an account is its own act:
///
///   1. **Generate the UMK.** This is the missing step today — the old
///      flow assumed a UMK already existed and threw `keyNotFound` when
///      it didn't, because `generateUMK` was never called anywhere in
///      onboarding. Open-account is the correct, single place to mint
///      it. (The later add-server flow must NOT re-generate.)
///   2. **Derive the IRK** (now that the UMK exists) and sign + POST a
///      standalone, idempotent `claimUsername`. The claim used to live
///      inside `CreateServerViewModel.mintInstallBlob`; it moved here so
///      a person can open an account with **zero servers**.
///   3. **Capture a human-readable device name** ("everyone is addressed
///      as a device with a human-readable name"). The default is the
///      OS-reported device name, falling back to "<username>'s iPhone".
///
/// On success the host calls `app.completeOnboarding(username:, pods: [])`
/// and lands the user on Home with no servers + an "Add your first
/// server" CTA. The server-mint flow becomes a reusable "Add a server"
/// reachable from Home, parameterized by the already-claimed username —
/// it derives the IRK (UMK already present) and must NOT re-claim.
@Observable
@MainActor
public final class OpenAccountViewModel {
    public enum Phase: Equatable, Sendable {
        case naming
        case opening
        /// Terminal success. Carries the resolved device name so the
        /// host can record it on the profile if desired.
        case opened(deviceName: String)
        case failed(String)
    }

    public var phase: Phase = .naming
    /// Human-readable device name. Pre-filled with a sensible default;
    /// the user may edit it before opening the account.
    public var deviceName: String
    public var accountName: String
    public private(set) var createdDeviceId: String?

    private let username: String
    private let server: any FlagshipServerClient

    public init(
        username: String,
        server: any FlagshipServerClient,
        defaultDeviceName: String? = nil
    ) {
        self.username = username
        self.server = server
        self.accountName = username.split(separator: "-")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
        self.deviceName = OpenAccountViewModel.resolveDefaultDeviceName(
            username: username,
            provided: defaultDeviceName
        )
    }

    /// The default device name shown in the field. Prefers a non-empty
    /// caller-provided name (e.g. `UIDevice.current.name`) and otherwise
    /// composes "<username>'s iPhone". The composed form is also the
    /// fallback if the OS hands back an empty string.
    public nonisolated static func resolveDefaultDeviceName(
        username: String,
        provided: String?
    ) -> String {
        if let provided, !provided.trimmingCharacters(in: .whitespaces).isEmpty {
            return provided
        }
        return "\(username)'s iPhone"
    }

    /// The device name the account opens with — the typed value, or the
    /// composed default if the user cleared the field.
    public var effectiveDeviceName: String {
        let trimmed = deviceName.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty
            ? OpenAccountViewModel.resolveDefaultDeviceName(username: username, provided: nil)
            : trimmed
    }

    public var effectiveAccountName: String {
        (try? AccountMetadata.validateDisplayName(accountName)) ?? username
    }

    public var canOpen: Bool {
        if case .opening = phase { return false }
        return true
    }

    /// Open the account: generate the UMK, derive the IRK, and POST the
    /// standalone username claim. Idempotent on retry — the claim is
    /// keyed by `(username, irkPub)` server-side, so re-running after a
    /// transport blip re-claims under the same IRK without a 409, and
    /// `generateUMK` is skipped if a UMK already exists (a previous
    /// partial run).
    ///
    /// On success transitions to `.opened`; the host then calls
    /// `app.completeOnboarding(username:, pods: [])`.
    public func openAccount() async {
        guard canOpen else { return }
        phase = .opening
        do {
            // Per-profile keying: land this new account's UMK in ITS OWN
            // slot (keyed by the username/cloudName) so opening a second
            // profile never clobbers an existing profile's device key.
            // The default-profile path (single-profile users) is
            // byte-identical since the first cloudName maps to the legacy
            // slot only when it normalizes to the default sentinel — but
            // here we always point at the named slot before key-gen.
            Keystore.setActiveProfile(username)

            // Create account == generate the UMK + derive the account IRK.
            // The common fresh-account path does BOTH in ONE biometric
            // ceremony (`generateUMKAndDeriveIRK` derives the IRK from the
            // in-memory seed it just wrapped — no second Face ID), fixing the
            // back-to-back prompt storm. The retry path (a UMK already exists
            // from a prior partial run) still self-heals stale local key
            // material: deriving from the existing UMK can fail its AES-GCM tag
            // check (.unwrapFailed "authenticationFailure") if the Secure-Enclave
            // wrapping key was lost/invalidated — that's an unusable local key,
            // NOT a biometric cancel — so we wipe THIS profile's stale slot and
            // re-mint. (If the name is already claimed server-side under the old
            // IRK, the claimUsername below conflicts and the user is steered to
            // recovery — we never silently fork a real identity.) A real
            // biometric cancel (.biometricFailed) rethrows untouched so we don't
            // destroy a usable key just because the user dismissed Face ID.
            // Slice D — the FIRST device also mints the ADMIN MASTER ROOT (a
            // fresh random Ed25519, NOT UMK-derived) alongside the UMK/IRK, in the
            // SAME single-Face-ID ceremony (`openAccountRoots`), and publishes its
            // pubkey to `.com` in the claim. Holding the root ⇒ this device is
            // admin by default. The retry path (a UMK already exists from a prior
            // partial run) reuses it + backfills an admin root if one is missing.
            let irk: Curve25519.Signing.PrivateKey
            let adminRoot: Curve25519.Signing.PrivateKey
            var adminRootPubHex: String?
            if !Keystore.hasWrappedUMK {
                let roots = try await Keystore.openAccountRoots(reason: "Open your Flagship account")
                irk = roots.irk
                adminRoot = roots.adminRoot
                adminRootPubHex = roots.adminRootPubHex
            } else {
                do {
                    irk = try await Keystore.deriveIRK(reason: "Open account \(username)")
                } catch Keystore.KeystoreError.unwrapFailed {
                    Keystore.wipe()
                    let roots = try await Keystore.openAccountRoots(reason: "Open your Flagship account")
                    irk = roots.irk
                    adminRootPubHex = roots.adminRootPubHex
                }
                // Backfill: a partial prior run may have made the UMK but not the
                // admin root. Publish the existing root, or mint one now.
                if adminRootPubHex == nil {
                    if let existing = Keystore.adminRootPubHex() {
                        adminRootPubHex = existing
                    } else {
                        adminRootPubHex = try? await Keystore.generateAdminRoot()
                    }
                }
                adminRoot = try await Keystore.adminRootKey(reason: "Authorize your private account name")
            }
            guard let adminRootPubHex else { throw Keystore.KeystoreError.keyNotFound }
            let irkPubHex = HexUtil.encode(irk.publicKey.rawRepresentation)
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let umkKey = try await Keystore.currentUMK(reason: "Create your private account directory")
            let umk = umkKey.withUnsafeBytes { Data($0) }
            let deviceId = try AccountMetadata.generateDeviceId()
            let deviceKey = try AccountMetadata.deriveAccountDeviceKey(umk: umk, accountId: username, deviceId: deviceId)
            let devicePubHex = HexUtil.encode(deviceKey.publicKey.rawRepresentation)
            guard let aidPub = ServiceInvite.deriveAccountIdPub(umkSeed: umk) else {
                throw AccountMetadataError.invalidKey
            }

            let claimBytes = UsernameClaim.canonicalBytes(
                username: username, irkPubHex: irkPubHex, issuedAt: now
            )
            let claimSig = try irk.signature(for: claimBytes)
            let accountCiphertext = try AccountMetadata.encrypt(
                displayName: effectiveAccountName,
                keyBytes: AccountMetadata.deriveAccountProfileKey(umk: umk),
                coordinates: .init(accountId: username, recordType: .accountProfile, revision: 1, keyVersion: 1)
            )
            let accountSignature = try adminRoot.signature(for: AccountMetadata.canonicalAccountProfile(
                accountId: username, revision: 1, keyVersion: 1, ciphertext: accountCiphertext,
                issuedAt: now, signerPubHex: adminRootPubHex
            ))
            let deviceCiphertext = try AccountMetadata.encrypt(
                displayName: effectiveDeviceName,
                keyBytes: AccountMetadata.deriveDeviceDirectoryKey(umk: umk),
                coordinates: .init(accountId: username, deviceId: deviceId, recordType: .deviceSelfProfile, revision: 1, keyVersion: 1)
            )
            let deviceSignature = try deviceKey.signature(for: AccountMetadata.canonicalDeviceSelfProfile(
                accountId: username, deviceId: deviceId, revision: 1, keyVersion: 1,
                ciphertext: deviceCiphertext, issuedAt: now, signerPubHex: devicePubHex
            ))
            let scopes = [
                "browse", "install-service", "vibe-code", "add-device", "manage-services",
                "revoke-others", "admin", "view-directory",
            ]
            let grant = DeviceCapabilityGrantEnvelope(
                grantId: UUID().uuidString.lowercased(), username: username, deviceId: deviceId,
                devicePubKeyHex: devicePubHex, scopes: scopes, issuedAt: now,
                expiresAt: now + 90 * 24 * 3_600_000
            )
            let grantSignature = try adminRoot.signature(for: grant.canonicalBytes())
            _ = try await server.bootstrapAccount(.init(
                claim: .init(
                    request: .init(username: username, irkPub: irkPubHex, issuedAt: now),
                    signature: HexUtil.encode(claimSig)
                ),
                aidPub: HexUtil.encode(aidPub),
                adminRootPub: adminRootPubHex,
                device: .init(deviceId: deviceId, devicePubHex: devicePubHex, platformClass: "ios"),
                grant: .init(
                    grantId: grant.grantId, username: username, deviceId: deviceId,
                    devicePubHex: devicePubHex, scopes: scopes, issuedAt: grant.issuedAt,
                    expiresAt: grant.expiresAt, signatureHex: HexUtil.encode(grantSignature)
                ),
                accountProfile: .init(
                    accountId: username, revision: 1, keyVersion: 1,
                    nonceHex: accountCiphertext.nonceHex, ciphertextHex: accountCiphertext.ciphertextHex,
                    issuedAt: now, signerPubHex: adminRootPubHex, signatureHex: HexUtil.encode(accountSignature)
                ),
                deviceProfile: .init(
                    accountId: username, deviceId: deviceId, revision: 1, keyVersion: 1,
                    nonceHex: deviceCiphertext.nonceHex, ciphertextHex: deviceCiphertext.ciphertextHex,
                    issuedAt: now, signerPubHex: devicePubHex, signatureHex: HexUtil.encode(deviceSignature)
                )
            ))

            createdDeviceId = deviceId
            phase = .opened(deviceName: effectiveDeviceName)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}
