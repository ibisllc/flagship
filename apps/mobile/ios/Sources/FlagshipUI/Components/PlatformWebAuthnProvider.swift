import Foundation
import AuthenticationServices
import CryptoKit
import FlagshipAPI

#if canImport(UIKit)
import UIKit
#endif

/// Production WebAuthnProvider built on AuthenticationServices.
///
/// `register` / `assertAny` / `prfAssert` drive
/// `ASAuthorizationPlatformPublicKeyCredentialProvider` against the APEX
/// relying party `flagshipserver.com` — the same rpId the Android
/// `PasskeyRecoveryManager` uses, the same value in the app's
/// `webcredentials:flagshipserver.com` entitlement, and the apex the
/// served AASA lists (`8G8RHBU9BN.com.flagshipserver.app`). The rpId MUST
/// stay the apex; an mismatch makes every passkey silently un-findable on
/// the next device.
///
/// The WebAuthn PRF extension (CTAP2 `hmac-secret`) supplies the 32-byte
/// secret that wraps the recovery UMK. PRF input is the passphrase-derived
/// salt (Task #4), threaded into `prf.eval.first` so the wrap key is bound
/// to the user's passphrase exactly as `recovery.js` does. The 32-byte PRF
/// output surfaces as a `CryptoKit.SymmetricKey` (`output.first`) — note it
/// is a `SymmetricKey`, NOT raw `Data`; we serialize it to `Data` for the
/// wrap. The PRF API is iOS 18.0+.
///
/// On the Simulator the authenticator cannot mint a real passkey or PRF
/// output, so the `#if targetEnvironment(simulator)` path keeps the
/// deterministic HKDF stand-in (keyed off `identifierForVendor` +
/// `prfSalt`) so CI / `PlatformWebAuthnTests` still round-trips a stable
/// secret end-to-end. The real ceremony is the device-only `#else` path.
/// Production callers must check `prfAvailable` before treating a derived
/// secret as truly hardware-bound.
@MainActor
public final class PlatformWebAuthnProvider: NSObject, WebAuthnProvider {
    private let relyingPartyId: String
    private let displayName: String
    /// Stable account handle used as the WebAuthn `userID` + credential
    /// name. When nil, a per-install handle is derived from
    /// `identifierForVendor`. The recovery ciphertext is keyed by *username*
    /// server-side (the Worker fetches by username, not by `userID`), so a
    /// per-install `userID` is sufficient and standard.
    private let username: String?
    public private(set) var prfAvailable: Bool = false

    public init(
        relyingPartyId: String = Endpoints.controlHost,
        displayName: String = "Flagship",
        username: String? = nil
    ) {
        self.relyingPartyId = relyingPartyId
        self.displayName = displayName
        self.username = username
    }

    public enum WebAuthnError: Error, LocalizedError {
        /// The authenticator completed but returned no PRF output — the
        /// credential cannot drive the recovery wrap key. Fail closed; do
        /// NOT silently substitute a non-hardware secret on device.
        case prfUnsupported
        /// `ASAuthorization` returned a credential of an unexpected type.
        case unexpectedCredential
        /// A non-hex credentialId reached `prfAssert` (the wire form is
        /// `^[0-9a-fA-F]{16,512}$`, hex of the raw credential-ID bytes).
        case invalidCredentialId

        public var errorDescription: String? {
            switch self {
            case .prfUnsupported:
                return "This authenticator did not return a PRF (hmac-secret) output."
            case .unexpectedCredential:
                return "Unexpected credential type returned by AuthenticationServices."
            case .invalidCredentialId:
                return "Credential identifier is not valid hex."
            }
        }
    }

    // MARK: - Hex helpers

#if targetEnvironment(simulator)
    /// UTF-8→hex encode a dev stand-in credentialID so it satisfies the
    /// Worker's `^[0-9a-fA-F]{16,512}$` on the wire. A real ASAuthorization
    /// rawId is already raw bytes; we hex-encode those the same way (see
    /// `hex(_:)`), so the wire field is hex either way.
    private static func hexCredentialId(_ raw: String) -> String {
        Data(raw.utf8).map { String(format: "%02x", $0) }.joined()
    }
#else
    /// Lowercase hex of raw bytes — the WIRE form the Worker requires.
    static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    /// Decode lowercase/uppercase hex → bytes. Returns nil for odd-length
    /// or non-hex input so `prfAssert` can fail closed on a malformed id.
    static func hexToData(_ hex: String) -> Data? {
        let chars = Array(hex)
        guard chars.count % 2 == 0 else { return nil }
        var out = Data(capacity: chars.count / 2)
        var i = 0
        while i < chars.count {
            guard
                let hi = chars[i].hexDigitValue,
                let lo = chars[i + 1].hexDigitValue
            else { return nil }
            out.append(UInt8(hi << 4 | lo))
            i += 2
        }
        return out
    }

    /// 32 cryptographically-secure random challenge bytes.
    private static func randomChallenge() -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes)
    }

    /// Stable opaque WebAuthn `userID`. Prefers SHA-256(username) when a
    /// username is known (matches the Android side); otherwise a hashed,
    /// per-install handle off `identifierForVendor`.
    private func stableUserID() async -> Data {
        if let username, !username.isEmpty {
            return Data(SHA256.hash(data: Data(username.utf8)))
        }
        let seed = await deviceIdSeed()
        return Data(SHA256.hash(data: Data("flagship-user|\(seed)".utf8)))
    }

    /// Human-readable credential name shown in the system sheet.
    private var credentialName: String {
        if let username, !username.isEmpty { return username }
        return displayName
    }
#endif
}

// MARK: - Simulator stand-in (deterministic; no real passkey / PRF)

#if targetEnvironment(simulator)
extension PlatformWebAuthnProvider {
    public func register(prfSalt: Data) async throws -> WebAuthnRegistration {
        // The Simulator has no authenticator, so we synthesize a stable
        // credentialID off the device's vendor identifier and emit it as
        // HEX (the Worker requires `^[0-9a-fA-F]{16,512}$`). A real
        // ASAuthorization rawId is raw bytes the caller hex-encodes the
        // same way (`RecoveryViewModel.credentialIdHex`), so the wire form
        // matches either way. `prfSalt` is accepted but unused here.
        prfAvailable = false
        let id = await deviceIdSeed()
        return WebAuthnRegistration(credentialId: Self.hexCredentialId("platform-\(id)"))
    }

    public func assertAny() async throws -> WebAuthnRegistration {
        prfAvailable = false
        let id = await deviceIdSeed()
        return WebAuthnRegistration(credentialId: Self.hexCredentialId("platform-\(id)"))
    }

    public func prfAssert(credentialId: String, prfSalt: Data) async throws -> Data {
        // Deterministic 32-byte secret keyed off the credentialID + the
        // passphrase-derived prfSalt + a device-bound (Keychain) salt. NOT
        // hardware-bound; the device `#else` path is the real PRF. Folding
        // `prfSalt` into `info` makes the output depend on the passphrase,
        // matching the real ceremony's salt-keyed behavior.
        prfAvailable = false
        let salt = await deviceBoundSalt()
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: Data(credentialId.utf8)),
            salt: salt,
            info: Data("flagship/platform-prf/v1|".utf8) + prfSalt,
            outputByteCount: 32
        )
        return key.withUnsafeBytes { Data($0) }
    }
}
#else

// MARK: - Device ceremony (real platform passkey + PRF extension)

extension PlatformWebAuthnProvider {
    /// Create a passkey for `flagshipserver.com` with the PRF extension's
    /// `eval.first` set to `prfSalt`. Returns the registration carrying the
    /// hex of the raw credential-ID bytes. We request PRF on registration so
    /// the credential is provisioned with `hmac-secret`; whether the *secret*
    /// surfaces here is recorded in `prfAvailable`, but we do NOT hard-fail
    /// if the registration ceremony omits it — some authenticators only
    /// return PRF on assertion, and the load-bearing secret is always read
    /// later via `prfAssert` (which fails closed if PRF is truly absent).
    public func register(prfSalt: Data) async throws -> WebAuthnRegistration {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
            relyingPartyIdentifier: relyingPartyId
        )
        let userID = await stableUserID()
        let request = provider.createCredentialRegistrationRequest(
            challenge: Self.randomChallenge(),
            name: credentialName,
            userID: userID
        )
        if #available(iOS 18.0, *) {
            request.prf = .inputValues(.init(saltInput1: prfSalt))
        }

        let authorization = try await perform(request)
        guard
            let credential = authorization.credential
                as? ASAuthorizationPlatformPublicKeyCredentialRegistration
        else {
            throw WebAuthnError.unexpectedCredential
        }

        if #available(iOS 18.0, *) {
            // `output.first` is a CryptoKit.SymmetricKey? — presence here is
            // a support signal only; the secret is read in `prfAssert`.
            prfAvailable = credential.prf?.first != nil
        } else {
            prfAvailable = false
        }

        let credentialIdHex = Self.hex(credential.credentialID)
        return WebAuthnRegistration(credentialId: credentialIdHex)
    }

    /// Authenticate with any existing passkey for this relying party (no
    /// `allowedCredentials` filter). Used by the legacy takeover flow to
    /// discover the credentialID. Returns the hex of the raw credential-ID
    /// bytes.
    public func assertAny() async throws -> WebAuthnRegistration {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
            relyingPartyIdentifier: relyingPartyId
        )
        let request = provider.createCredentialAssertionRequest(
            challenge: Self.randomChallenge()
        )

        let authorization = try await perform(
            request, options: .preferImmediatelyAvailableCredentials
        )
        guard
            let credential = authorization.credential
                as? ASAuthorizationPlatformPublicKeyCredentialAssertion
        else {
            throw WebAuthnError.unexpectedCredential
        }
        return WebAuthnRegistration(credentialId: Self.hex(credential.credentialID))
    }

    /// Assert against a specific credential with the PRF extension's
    /// `eval.first` set to `prfSalt`, and return the 32-byte PRF output. The
    /// authenticator keys its `hmac-secret` output by the salt, so the same
    /// passphrase yields the same secret across devices. Fails closed
    /// (`prfUnsupported`) if no PRF output is returned.
    public func prfAssert(credentialId: String, prfSalt: Data) async throws -> Data {
        guard let credentialIDBytes = Self.hexToData(credentialId) else {
            throw WebAuthnError.invalidCredentialId
        }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
            relyingPartyIdentifier: relyingPartyId
        )
        let request = provider.createCredentialAssertionRequest(
            challenge: Self.randomChallenge()
        )
        request.allowedCredentials = [
            ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: credentialIDBytes)
        ]
        if #available(iOS 18.0, *) {
            request.prf = .inputValues(.init(saltInput1: prfSalt))
        } else {
            throw WebAuthnError.prfUnsupported
        }

        // Use the passkey already on this device. Recovery runs ON the target
        // device, so the cross-device QR ("sign in with a nearby device") is
        // nonsensical here — restrict to immediately-available local
        // credentials and fail cleanly (caller offers the backup-file path)
        // rather than presenting it.
        let authorization = try await perform(
            request, options: .preferImmediatelyAvailableCredentials
        )
        guard
            let credential = authorization.credential
                as? ASAuthorizationPlatformPublicKeyCredentialAssertion
        else {
            throw WebAuthnError.unexpectedCredential
        }
        // `credential.prf` is optional; its `.first` is a non-optional
        // CryptoKit.SymmetricKey when PRF is present. Both the `.prf`
        // property and the type are iOS 18+, so read them inside an
        // availability block.
        if #available(iOS 18.0, *), let output = credential.prf {
            prfAvailable = true
            // Serialize the 32-byte PRF SymmetricKey to Data.
            return output.first.withUnsafeBytes { Data($0) }
        }
        prfAvailable = false
        throw WebAuthnError.prfUnsupported
    }

    /// Bridge a single `ASAuthorizationController` run to async/await.
    ///
    /// `options` lets assertions pass `.preferImmediatelyAvailableCredentials`,
    /// which restricts the flow to a passkey that's already on THIS device
    /// (the user's iCloud-Keychain passkey) — Face ID, never the cross-device
    /// "scan a QR with a nearby device" hybrid transport. Registration leaves
    /// it empty (it always mints a new credential).
    private func perform(
        _ request: ASAuthorizationRequest,
        options: ASAuthorizationController.RequestOptions = []
    ) async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { continuation in
            let controller = ASAuthorizationController(authorizationRequests: [request])
            let bridge = AuthControllerBridge(continuation: continuation)
            controller.delegate = bridge
            controller.presentationContextProvider = bridge
            // The controller holds delegate/presentationContextProvider
            // weakly; retain the bridge until the continuation resumes.
            bridge.retainSelf = bridge
            controller.performRequests(options: options)
        }
    }
}

/// Delegate + presentation-anchor adapter that resumes the continuation
/// exactly once and then releases its own strong self-reference so the
/// `ASAuthorizationController` machinery can deallocate.
private final class AuthControllerBridge: NSObject,
    ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding
{
    private var continuation: CheckedContinuation<ASAuthorization, Error>?
    /// Strong self-reference dropped on completion (controller refs us weakly).
    var retainSelf: AuthControllerBridge?

    init(continuation: CheckedContinuation<ASAuthorization, Error>) {
        self.continuation = continuation
    }

    private func finish(_ result: Result<ASAuthorization, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        switch result {
        case .success(let authorization):
            continuation.resume(returning: authorization)
        case .failure(let error):
            continuation.resume(throwing: error)
        }
        retainSelf = nil
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        finish(.success(authorization))
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        finish(.failure(error))
    }

    func presentationAnchor(
        for controller: ASAuthorizationController
    ) -> ASPresentationAnchor {
        #if canImport(UIKit)
        let scenes = UIApplication.shared.connectedScenes
        let keyWindow = scenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
        return keyWindow
            ?? scenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }
                .first
            ?? ASPresentationAnchor()
        #else
        return ASPresentationAnchor()
        #endif
    }
}
#endif

// MARK: - Device-stable helpers (shared by both paths)

extension PlatformWebAuthnProvider {
    private func deviceIdSeed() async -> String {
        #if canImport(UIKit)
        // identifierForVendor is per-app+vendor; stable for the install.
        // Hashed to avoid embedding the raw UUID.
        if let uuid = await MainActor.run(body: { UIDevice.current.identifierForVendor })?.uuidString {
            return SHA256.hash(data: Data(uuid.utf8))
                .prefix(8)
                .map { String(format: "%02x", $0) }
                .joined()
        }
        #endif
        return "ephemeral-\(UUID().uuidString.prefix(8).lowercased())"
    }

#if targetEnvironment(simulator)
    private func deviceBoundSalt() async -> Data {
        // Random salt persisted in Keychain so the dev-stand-in PRF output
        // is the same across launches but unique per install.
        let key = "com.flagship.webauthn.salt"
        if let raw = readSalt(key: key) { return raw }
        if let raw = Self.inMemorySaltCache[key] { return raw }
        let fresh = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        writeSalt(key: key, data: fresh)
        Self.inMemorySaltCache[key] = fresh
        return fresh
    }

    /// Process-local fallback for test bundles / contexts where the
    /// Keychain refuses writes (`errSecMissingEntitlement`). Mirrors
    /// `Flagship/Keystore.swift` so the dev-stand-in PRF output is stable
    /// across calls within a process.
    private nonisolated(unsafe) static var inMemorySaltCache: [String: Data] = [:]

    private func readSalt(key: String) -> Data? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        return status == errSecSuccess ? (result as? Data) : nil
    }

    private func writeSalt(key: String, data: Data) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
#endif
}
