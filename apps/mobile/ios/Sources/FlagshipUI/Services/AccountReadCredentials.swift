import Foundation
import CryptoKit
import Flagship
import FlagshipAPI
import FlagshipCore

/// Builds account read-token mint requests (docs/account-read-token.md) from
/// key material already at hand, and never prompts: the device's stored
/// account key, or the UMK this unlocked session already holds (the device
/// key derived from it, then the IRK). A key derived from the UMK is kept on
/// the device (device-local, outside biometrics, like a joined device's), so
/// later mints need no unlock. With neither, it returns nothing and the read
/// waits for the next unlock.
public struct AccountReadCredentials: Sendable {
    public var storedDeviceKey: @Sendable (_ accountId: String, _ deviceId: String) -> Curve25519.Signing.PrivateKey?
    public var sessionUMK: @Sendable () -> Data?
    public var sessionIRK: @Sendable () -> Curve25519.Signing.PrivateKey?
    public var storeDeviceKey: @Sendable (_ key: Curve25519.Signing.PrivateKey, _ accountId: String, _ deviceId: String) -> Void
    public var now: @Sendable () -> Int64

    public init(
        storedDeviceKey: @escaping @Sendable (String, String) -> Curve25519.Signing.PrivateKey?,
        sessionUMK: @escaping @Sendable () -> Data?,
        sessionIRK: @escaping @Sendable () -> Curve25519.Signing.PrivateKey?,
        storeDeviceKey: @escaping @Sendable (Curve25519.Signing.PrivateKey, String, String) -> Void = { _, _, _ in },
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.storedDeviceKey = storedDeviceKey
        self.sessionUMK = sessionUMK
        self.sessionIRK = sessionIRK
        self.storeDeviceKey = storeDeviceKey
        self.now = now
    }

    public static let keystore = AccountReadCredentials(
        storedDeviceKey: { Keystore.storedAccountDeviceSigningKey(accountId: $0, deviceId: $1) },
        sessionUMK: { Keystore.sessionUMKIfCached() },
        sessionIRK: { Keystore.sessionIRKIfCached() },
        storeDeviceKey: { try? Keystore.storeAccountDeviceSigningKey($0, accountId: $1, deviceId: $2) }
    )

    /// Keep this device's account key at hand once the session unwrapped the
    /// UMK, so the next mint signs without it. No-op when one is stored.
    public func keepDeviceKey(umk: Data, username: String, deviceId: String) {
        let u = username.lowercased()
        guard !u.isEmpty, !deviceId.isEmpty, storedDeviceKey(u, deviceId) == nil,
              let key = try? AccountMetadata.deriveAccountDeviceKey(umk: umk, accountId: u, deviceId: deviceId)
        else { return }
        storeDeviceKey(key, u, deviceId)
    }

    /// Mint requests for `username`, device first. `deviceId` is this
    /// device's account device id ("" when it has none, e.g. a recovered
    /// phone).
    public func credentials(username: String, deviceId: String) -> [AccountReadTokenCredential] {
        let u = username.lowercased()
        var out: [AccountReadTokenCredential] = []
        if !deviceId.isEmpty, let key = deviceKey(u, deviceId), let auth = try? deviceAuthorization(u, deviceId, key) {
            out.append(.device(auth))
        }
        if let irk = sessionIRK(), let envelope = try? irkEnvelope(u, irk) {
            out.append(.irk(envelope))
        }
        return out
    }

    private func deviceKey(_ u: String, _ deviceId: String) -> Curve25519.Signing.PrivateKey? {
        if let stored = storedDeviceKey(u, deviceId) { return stored }
        guard let umk = sessionUMK(),
              let key = try? AccountMetadata.deriveAccountDeviceKey(umk: umk, accountId: u, deviceId: deviceId)
        else { return nil }
        storeDeviceKey(key, u, deviceId)
        return key
    }

    private func deviceAuthorization(
        _ u: String, _ deviceId: String, _ key: Curve25519.Signing.PrivateKey
    ) throws -> AccountDirectoryAuthorization {
        let signerPub = HexUtil.encode(key.publicKey.rawRepresentation)
        let requestId = try AccountMetadata.generateDeviceId()
        let issuedAt = now()
        let signature = try key.signature(for: AccountMetadata.canonicalDirectoryRequest(
            accountId: u, deviceId: deviceId, signerPubHex: signerPub,
            method: "POST", path: AccountReadTokenCredential.path(username: u),
            requestId: requestId, issuedAt: issuedAt
        ))
        return AccountDirectoryAuthorization(
            deviceId: deviceId, signerPubHex: signerPub, requestId: requestId,
            issuedAt: issuedAt, signatureHex: HexUtil.encode(Data(signature))
        )
    }

    private func irkEnvelope(_ u: String, _ irk: Curve25519.Signing.PrivateKey) throws -> MailboxAuthEnvelope {
        let issuedAt = now()
        var nonce = Data(count: 32)
        let status = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { throw AccountMetadataError.randomFailure }
        let claim = DeviceEndpointClaim(
            username: u,
            endpointLabel: AccountReadTokenCredential.irkEndpointLabel,
            phoneIrkPub: irk.publicKey.rawRepresentation,
            issuedAt: issuedAt,
            expiresAt: issuedAt + 120_000,
            nonce: nonce
        )
        let sig = try claim.sign(with: irk)
        return MailboxAuthEnvelope(
            auth: .init(
                username: claim.username,
                endpointLabel: claim.endpointLabel,
                phoneIrkPub: HexUtil.encode(claim.phoneIrkPub),
                issuedAt: claim.issuedAt,
                expiresAt: claim.expiresAt,
                nonce: HexUtil.encode(claim.nonce)
            ),
            authSignature: HexUtil.encode(sig)
        )
    }
}
