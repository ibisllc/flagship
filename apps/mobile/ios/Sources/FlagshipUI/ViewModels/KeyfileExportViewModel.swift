import Foundation
import Observation
import CryptoKit
import Flagship
import FlagshipCore

/// Drives "Back up your account key" — reads the UMK out of the
/// Keystore (behind the biometric gate) and wraps it into a
/// passphrase-encrypted `.flagshipkey` file, byte-compatible with
/// `packages/protocol/src/keyfile.ts`.
///
/// The view holds the required control acknowledgment + the passphrase;
/// this VM only validates strength and runs the wrap. The produced file
/// text is handed back so the host can present a share sheet — we never
/// write it anywhere on our own.
@MainActor
@Observable
public final class KeyfileExportViewModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case working
        /// The keyfile text is ready; host presents the share sheet.
        case ready(text: String)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    public var passphrase: String = ""
    public var confirmPassphrase: String = ""

    /// Required before the "Create backup file" button enables.
    public var ackControl: Bool = false

    public let username: String
    public let accountId: String?

    /// Seam so tests can supply the UMK without piercing the Secure
    /// Enclave. Defaults to the real Keystore read (fires biometrics).
    private let readUMK: @MainActor (String) async throws -> SymmetricKey

    public init(
        username: String,
        accountId: String? = nil,
        readUMK: @escaping @MainActor (String) async throws -> SymmetricKey = { reason in
            try await Keystore.currentUMK(reason: reason)
        }
    ) {
        self.username = username
        self.accountId = accountId
        self.readUMK = readUMK
    }

    /// The user acknowledged that the file + passphrase control the account.
    public var acknowledged: Bool {
        ackControl
    }

    /// The backup UI requires at least 12 characters.
    public var passphraseStrong: Bool {
        Self.isStrong(passphrase)
    }

    public var passphrasesMatch: Bool {
        !confirmPassphrase.isEmpty && passphrase == confirmPassphrase
    }

    /// The "Create backup file" CTA is enabled only when everything
    /// lines up: minimum-length passphrase, confirmation matches, and the
    /// acknowledgment is checked.
    public var canCreate: Bool {
        passphraseStrong && passphrasesMatch && acknowledged
    }

    /// A simple minimum-length rule shared by the UI and action layer.
    static func isStrong(_ s: String) -> Bool {
        s.count >= 12
    }

    /// Suggested filename for the share sheet: `<username>.flagshipkey`.
    public var suggestedFilename: String {
        let safe = username.isEmpty ? "account" : username
        return "\(safe).flagshipkey"
    }

    /// Read the UMK + wrap it. On success → `.ready(text:)`.
    public func createBackup() async {
        guard canCreate else { return }
        phase = .working
        do {
            let umk = try await readUMK("Back up your Flagship account key")
            let meta = Keyfile.Meta(
                username: username,
                accountId: accountId,
                createdAt: ISO8601DateFormatter.flagshipUTC.string(from: Date())
            )
            let text = try Keyfile.wrap(umkSeed: umk, passphrase: passphrase, meta: meta)
            phase = .ready(text: text)
        } catch {
            phase = .failed("Couldn't create the backup file: \(error.localizedDescription)")
        }
    }

    public func reset() {
        phase = .idle
    }
}

extension ISO8601DateFormatter {
    /// UTC ISO-8601 with milliseconds — matches the `createdAt` shape in
    /// the golden keyfile (`2026-05-25T00:00:00.000Z`).
    static let flagshipUTC: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()
}
