import Foundation

/// What `.com` needs to check the recovery passkey itself (SEC-REPAIR-001). Wire parity with
/// packages/control-plane/src/passkeyAssertion.ts; pinned by
/// packages/protocol/test-vectors/recovery-passkey/vectors.json.
///
/// Enrolment: send `ASAuthorizationPlatformPublicKeyCredentialRegistration.rawAttestationObject`
/// as `passkeyAttestationObject` beside the signed record. Recovery: `POST
/// /api/recovery/by-username/<u>/challenge`, pass `challengeBytes(challenge)` as the assertion
/// request's challenge in the same request that evaluates the PRF, then send
/// `passkey: fetchPasskeyField(...)` with the `/fetch` body.
public enum RecoveryPasskey {
    public static func base64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func attestationField(_ rawAttestationObject: Data) -> String { base64url(rawAttestationObject) }

    public static func challengeBytes(_ challenge: String) -> Data? {
        var s = challenge.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        return Data(base64Encoded: s)
    }

    /// From `ASAuthorizationPlatformPublicKeyCredentialAssertion`: credentialID, rawAuthenticatorData,
    /// rawClientDataJSON, signature.
    public static func fetchPasskeyField(challenge: String, credentialId: Data, authenticatorData: Data,
                                         clientDataJSON: Data, signature: Data) -> [String: Any] {
        [
            "challenge": challenge,
            "assertion": [
                "credentialId": base64url(credentialId),
                "authenticatorData": base64url(authenticatorData),
                "clientDataJSON": base64url(clientDataJSON),
                "signature": base64url(signature),
            ],
        ]
    }
}
