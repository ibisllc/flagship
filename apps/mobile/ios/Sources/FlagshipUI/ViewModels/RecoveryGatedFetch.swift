import Foundation
import Flagship
import FlagshipAPI
import FlagshipCore

/// The gated recovery fetch in the order SEC-REPAIR-001 sets: the passphrase is already derived (it
/// feeds the PRF), then `.com`'s challenge, then ONE passkey sheet that both evaluates the PRF and
/// signs the challenge, then the fetch carrying that signature. Shared by recovery on a new device
/// and by the admin-root re-escrow, which reads the same record.
public enum RecoveryGatedFetch {
    public struct Result: Sendable {
        public let fetched: RecoveryFetchResponse
        public let prfSecret: Data
    }

    public enum Failure: Error, Equatable, LocalizedError {
        case noRecord
        public var errorDescription: String? { String(localized: "No cloud recovery for that account name.") }
    }

    public static func run(
        client: any FlagshipServerClient,
        webAuthn: any WebAuthnProvider,
        username: String,
        secrets: RecoveryDerivation.Secrets
    ) async throws -> Result {
        guard let state = try await client.recoveryRecordState(username: username) else { throw Failure.noRecord }
        var challenge: String?
        do {
            challenge = try await client.recoveryChallenge(username: username).challenge
        } catch where RecoveryPasskeyCopy.isUnavailable(error) && state.passkeyRequired != true {
            // A record from before the check, on a `.com` without it: the passphrase alone releases it.
            challenge = nil
        }
        let challengeBytes = challenge.flatMap(RecoveryPasskey.challengeBytes) ?? Self.randomChallenge()
        let asserted = try await webAuthn.recoveryAssert(credentialId: state.credentialId, prfSalt: secrets.prfSalt,
                                                         challenge: challengeBytes)
        let fetched = try await client.fetchWrappedUmk(
            username: username,
            fetchTokenHex: HexUtil.encode(secrets.fetchToken),
            passkey: challenge.map { asserted.fetchField(challenge: $0) }
        )
        // The stored credential changed between the two reads: the PRF came from the wrong passkey.
        guard fetched.credentialId.lowercased() == state.credentialId.lowercased() else {
            throw ScreensClientError.http(status: 409, message: String(localized: "Your account recovery changed while this ran. Try again."))
        }
        return Result(fetched: fetched, prfSecret: asserted.prfSecret)
    }

    /// One of `.com`'s passkey refusals (already in the owner's words), as opposed to a wrong passphrase.
    public static func isPasskeyRefusal(_ error: Error) -> Bool {
        guard case let ScreensClientError.http(_, message) = error else { return false }
        return ["passkey-required", "passkey-challenge", "passkey-invalid", "passkey-unavailable"]
            .compactMap(RecoveryPasskeyCopy.message(forCode:)).contains(message)
    }

    private static func randomChallenge() -> Data {
        Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    }
}
