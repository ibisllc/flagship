import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Drives "Import backup file" — bring this device into an account using
/// its `.flagshipkey` backup. The flow mirrors the credentialed takeover
/// in `RealAccountLoginViewModel`, swapping the WebAuthn-PRF unwrap for a
/// passphrase-decrypt of the keyfile:
///
///   1. The host hands us the picked file's text + the user's passphrase.
///   2. `Keyfile.unwrap` decrypts the UMK seed (argon2id + AES-256-GCM).
///   3. Point the Keystore at this account's slot + `installUMK`.
///   4. Initiate the takeover re-pair (new IRK derives from the installed
///      UMK), then complete it. On `.finalized` the host flips AppState.
///
/// Errors map to the approved copy: wrong passphrase → "That passphrase
/// didn't open the file."; not a keyfile → "This isn't a Flagship key
/// file."
@MainActor
@Observable
public final class KeyfileImportViewModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case working
        /// Re-pair initiated — the takeover grace is running server-side.
        case completed(username: String, completesAt: Int64)
        /// Re-pair complete — the host flips AppState to paired on this.
        case finalized(username: String)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    public var passphrase: String = ""

    private let server: any FlagshipServerClient
    /// Seam so tests can assert the imported UMK is installed without
    /// piercing the Secure Enclave. Defaults to the real Keystore write.
    private let installUMK: @MainActor (SymmetricKey, String) async throws -> Void

    public init(
        server: any FlagshipServerClient,
        installUMK: @escaping @MainActor (SymmetricKey, String) async throws -> Void = { seed, reason in
            try await Keystore.installUMK(seed, reason: reason)
        }
    ) {
        self.server = server
        self.installUMK = installUMK
    }

    public var canImport: Bool {
        !passphrase.isEmpty
    }

    /// Unwrap the keyfile, install the UMK, and initiate the takeover
    /// re-pair. `fileText` is the raw `.flagshipkey` contents the host
    /// read from the picked file.
    public func importBackup(fileText: String) async {
        guard canImport else {
            phase = .failed("Enter the passphrase for this backup file.")
            return
        }
        phase = .working

        // 1 — Decrypt the keyfile.
        let seed: SymmetricKey
        let meta: Keyfile.Meta
        do {
            (seed, meta) = try Keyfile.unwrap(fileText: fileText, passphrase: passphrase)
        } catch let e as Keyfile.KeyfileError {
            phase = .failed(humanizedKeyfileError(e))
            return
        } catch {
            phase = .failed("This isn't a Flagship key file.")
            return
        }

        let username = meta.username

        // 2 — Install the recovered UMK into THIS account's slot, so a
        // second imported cloud lands in its own slot and never clobbers
        // an already-present profile. installUMK resets the IRK lineage
        // to v1 under the imported UMK.
        Keystore.setActiveProfile(username)
        do {
            try await installUMK(seed, "Bring this device into your Flagship account")
        } catch {
            phase = .failed("Couldn't install your account key. \(HumanError.humanize(error))")
            return
        }

        // 3 — Initiate the takeover re-pair. New IRK derives from the
        // just-installed UMK. On a fresh device we don't hold the
        // displaced key, so the old-pubkey slot carries the new pubkey
        // (the Worker keys the takeover on the username row).
        do {
            let resp = try await initiateTakeoverRePair(username: username)
            phase = .completed(username: username, completesAt: resp.completesAt)
        } catch ScreensClientError.http(let status, let message) where status == 401 && (message ?? "").contains("totpProof") {
            // #52 — the account has a second factor enrolled, which the
            // cloud now requires at initiate even for single-device
            // accounts. The keyfile sheet has no second-factor field
            // (yet); route the user to the sign-in flow, which prompts
            // for it.
            phase = .failed("This account has a second factor enrolled. Use \"I already have an account\" to sign in — it will ask for your authenticator or recovery code.")
        } catch {
            phase = .failed("Couldn't start bringing this device in. \(HumanError.humanize(error))")
        }
    }

    /// Finalize the takeover once its grace has elapsed. The complete
    /// endpoint is a public, idempotent CAS-swap. 404 == already
    /// swapped (success); 425 == too early (stay in grace); 403/409 ==
    /// objected (cancelled).
    public func completeTakeover() async {
        guard case .completed(let username, let completesAt) = phase else { return }
        phase = .working
        do {
            _ = try await server.completeRePair(username: username)
            phase = .finalized(username: username)
        } catch ScreensClientError.http(let status, _) where status == 404 {
            phase = .finalized(username: username)
        } catch ScreensClientError.http(let status, _) where status == 425 {
            phase = .completed(username: username, completesAt: completesAt)
        } catch ScreensClientError.http(let status, _) where status == 403 || status == 409 {
            phase = .failed("This was cancelled. If it's still you, try again.")
        } catch ScreensClientError.http(let status, _) where status == 410 {
            // #52 — completion window elapsed; the cloud swept the row.
            phase = .failed("This expired before it was completed. Start again.")
        } catch {
            phase = .failed("Couldn't finish bringing this device in. \(HumanError.humanize(error))")
        }
    }

    private func initiateTakeoverRePair(username: String) async throws -> RePairInitiateResponse {
        let newKey = try await Keystore.deriveIRK(reason: "Authorize this device")
        let newPubHex = HexUtil.encode(newKey.publicKey.rawRepresentation)
        let oldPubHex = newPubHex
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let canonical = RePairInitiate.canonicalBytes(
            username: username,
            newIrkPubHex: newPubHex,
            oldIrkPubHex: oldPubHex,
            issuedAt: issuedAt
        )
        let signature = try newKey.signature(for: canonical)
        return try await server.initiateRePair(
            username: username,
            body: RePairInitiateRequest(
                request: .init(
                    username: username,
                    newIrkPub: newPubHex,
                    oldIrkPub: oldPubHex,
                    issuedAt: issuedAt
                ),
                signature: HexUtil.encode(signature),
                totpProof: nil
            ),
            ifMatch: nil
        )
    }

    public func reset() {
        phase = .idle
    }

    private func humanizedKeyfileError(_ e: Keyfile.KeyfileError) -> String {
        switch e {
        case .badPassphrase: return "That passphrase didn't open the file."
        case .malformed:     return "This isn't a Flagship key file."
        case .version:       return "This backup was made by a newer version of Flagship. Update the app and try again."
        }
    }
}
