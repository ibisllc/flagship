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

    private let username: String
    private let server: any FlagshipServerClient

    public init(
        username: String,
        server: any FlagshipServerClient,
        defaultDeviceName: String? = nil
    ) {
        self.username = username
        self.server = server
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

            // Create account == generate the UMK. Guard against a
            // double-generate if a prior attempt already minted one
            // (so a retry doesn't orphan the first UMK + its claim).
            if !Keystore.hasWrappedUMK {
                try await Keystore.generateUMK(reason: "Open your Flagship account")
            }

            // Derive the account IRK, self-healing STALE local key material. A
            // wrapped UMK can linger from a PRIOR account on this device — the
            // Keychain survives an app delete+reinstall, and a partial reset can
            // leave another profile's slot behind. If its Secure-Enclave wrapping
            // key is gone/invalidated, the unwrap fails its AES-GCM tag check
            // (.unwrapFailed "authenticationFailure") — the local key is unusable,
            // NOT a biometric cancel. For an open-account that's safe to clear +
            // re-mint: wipe THIS profile's stale slot and generate a fresh UMK.
            // (If the name is already claimed server-side under the old IRK, the
            // claimUsername below conflicts and the user is steered to recovery —
            // we never silently fork a real identity.) Any other error — notably
            // a biometric cancel (.biometricFailed) — rethrows untouched so we
            // don't destroy a usable key just because the user dismissed Face ID.
            let irk: Curve25519.Signing.PrivateKey
            do {
                irk = try await Keystore.deriveIRK(reason: "Open account \(username)")
            } catch Keystore.KeystoreError.unwrapFailed {
                Keystore.wipe()
                try await Keystore.generateUMK(reason: "Open your Flagship account")
                irk = try await Keystore.deriveIRK(reason: "Open account \(username)")
            }
            let irkPubHex = HexUtil.encode(irk.publicKey.rawRepresentation)
            let now = Int64(Date().timeIntervalSince1970 * 1000)

            let claimBytes = UsernameClaim.canonicalBytes(
                username: username, irkPubHex: irkPubHex, issuedAt: now
            )
            let claimSig = try irk.signature(for: claimBytes)
            try await server.claimUsername(.init(
                request: .init(username: username, irkPub: irkPubHex, issuedAt: now),
                signature: HexUtil.encode(claimSig)
            ))

            phase = .opened(deviceName: effectiveDeviceName)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}
