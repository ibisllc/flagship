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
/// The view holds the three required acknowledgments + the passphrase;
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

    /// The three required acknowledgments. All must be true before the
    /// "Create backup file" button enables.
    public var ackControl: Bool = false
    public var ackOffline: Bool = false
    public var ackNoRecovery: Bool = false

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

    /// All three acknowledgments checked.
    public var acknowledged: Bool {
        ackControl && ackOffline && ackNoRecovery
    }

    /// Enough-strength passphrase: at least 12 chars and not trivially
    /// uniform. The keyfile floor is 8; we ask for more in the UI since
    /// this file is the keys to the whole account.
    public var passphraseStrong: Bool {
        Self.isStrong(passphrase)
    }

    public var passphrasesMatch: Bool {
        !confirmPassphrase.isEmpty && passphrase == confirmPassphrase
    }

    /// The "Create backup file" CTA is enabled only when everything
    /// lines up: strong passphrase, confirmation matches, all three
    /// acknowledgments checked.
    public var canCreate: Bool {
        passphraseStrong && passphrasesMatch && acknowledged
    }

    /// A simple, defensible strength rule. Surfaces enforce; this is a
    /// floor, not a meter. >= 12 chars, and at least 3 of 4 character
    /// classes (lower / upper / digit / symbol).
    static func isStrong(_ s: String) -> Bool {
        guard s.count >= 12 else { return false }
        let lower = s.contains { $0.isLowercase }
        let upper = s.contains { $0.isUppercase }
        let digit = s.contains { $0.isNumber }
        let symbol = s.contains { !$0.isLetter && !$0.isNumber && !$0.isWhitespace }
        let classes = [lower, upper, digit, symbol].filter { $0 }.count
        return classes >= 3
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
