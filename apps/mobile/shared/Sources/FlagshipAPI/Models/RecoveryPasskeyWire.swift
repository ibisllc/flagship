import Foundation

/// SEC-REPAIR-001 wire shapes: `.com` checks the recovery passkey's own signature before it releases a
/// recovery record. Wire parity with packages/control-plane/src/webauthnRecovery.ts.

/// `POST /api/recovery/by-username/<u>/challenge` → what the passkey signs (base64url).
public struct RecoveryChallenge: Codable, Equatable, Sendable {
    public let challenge: String
    public let expiresAt: Int64?
    public init(challenge: String, expiresAt: Int64? = nil) {
        self.challenge = challenge
        self.expiresAt = expiresAt
    }
}

/// The `/fetch` body's `passkey` field: the challenge and the assertion over it, every byte field
/// base64url (FlagshipCore `RecoveryPasskey.fetchPasskeyField` builds the same object).
public struct RecoveryPasskeyAssertion: Codable, Equatable, Sendable {
    public struct Assertion: Codable, Equatable, Sendable {
        public let credentialId: String
        public let authenticatorData: String
        public let clientDataJSON: String
        public let signature: String
        public init(credentialId: String, authenticatorData: String, clientDataJSON: String, signature: String) {
            self.credentialId = credentialId
            self.authenticatorData = authenticatorData
            self.clientDataJSON = clientDataJSON
            self.signature = signature
        }
    }
    public let challenge: String
    public let assertion: Assertion
    public init(challenge: String, assertion: Assertion) {
        self.challenge = challenge
        self.assertion = assertion
    }
}

/// `POST /api/recovery/by-username/<u>/fetch` body: the passphrase gate, plus the passkey when the
/// record holds its key.
public struct RecoveryGatedFetchBody: Encodable, Equatable, Sendable {
    public let fetchToken: String
    public let issuedAt: Int64
    public let passkey: RecoveryPasskeyAssertion?
    public init(fetchToken: String, issuedAt: Int64, passkey: RecoveryPasskeyAssertion?) {
        self.fetchToken = fetchToken
        self.issuedAt = issuedAt
        self.passkey = passkey
    }
}

/// The sentences for `.com`'s passkey refusals (`code` in the error body), the same on every client.
public enum RecoveryPasskeyCopy {
    public static func message(forCode code: String) -> String? {
        switch code {
        case "passkey-required": return String(localized: "This recovery needs your passkey. Try again and choose your Flagship passkey.")
        case "passkey-challenge": return String(localized: "The passkey check expired. Try again.")
        case "passkey-invalid": return String(localized: "That passkey isn't the one your account recovery uses.")
        case "passkey-unavailable": return String(localized: "Passkey recovery isn't available right now. Try again later.")
        default: return nil
        }
    }

    /// The `code` of a `.com` error body, if it is one of the passkey refusals.
    public static func code(inBody data: Data) -> String? {
        struct Body: Decodable { let code: String? }
        guard let code = (try? JSONDecoder().decode(Body.self, from: data))?.code,
              message(forCode: code) != nil else { return nil }
        return code
    }

    public static func message(forBody data: Data) -> String? {
        code(inBody: data).flatMap(message(forCode:))
    }

    /// A refused challenge request that only means "this deployment has no passkey check".
    public static func isUnavailable(_ error: Error) -> Bool {
        guard case let ScreensClientError.http(status, message) = error, status == 503 else { return false }
        return code(inBody: Data(message.utf8)) == "passkey-unavailable"
    }

    public static let passphraseHint = String(localized: "Longer is stronger and there is no upper limit: a whole sentence you will remember works well")
    public static let passphraseTooShort = String(localized: "Use at least 8 characters.")
}
