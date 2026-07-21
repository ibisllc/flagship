import Foundation
import CryptoKit

/// Phase 3b — vouched cross-device admit. Swift mirror of
/// `DeviceAdmit` / `signDeviceAdmit` / `verifyDeviceAdmit` in
/// packages/protocol/src/auth.ts.
///
/// A collaborator joins an account by scanning the admin's pairing QR.
/// Over the sealed QrRelay the incoming device sends its FRESH device
/// pubkey; the admin confirms the SAS and signs a `DeviceAdmit` that
/// binds that pubkey. The incoming device presents the envelope to
/// .com on register; .com verifies it under the account's CURRENT IRK
/// (the admin/vouching device holds that key) and admits the device
/// QUARANTINED (14-day non-admin peer window).
///
/// The envelope is the unforgeable vouch: only a holder of the
/// account's IRK private key can mint it, and it commits to the exact
/// `newDevicePubHex` so a captured admit can't be re-aimed at a
/// different device. The canonical bytes + the `|`-joined field order
/// MUST match the Worker byte-for-byte or the server verify fails.
public struct DeviceAdmit: Equatable, Sendable {
    public static let canonicalTag = "flagship/device-admit/v2"

    public let username: String
    public let deviceId: String
    /// The incoming device's freshly-minted pubkey, lowercased hex
    /// (32 bytes → 64 hex chars).
    public let newDevicePubHex: String
    public let issuedAt: Int64

    public init(username: String, deviceId: String, newDevicePubHex: String, issuedAt: Int64) {
        self.username = username
        self.deviceId = deviceId
        self.newDevicePubHex = newDevicePubHex
        self.issuedAt = issuedAt
    }

    /// `flagship/device-admit/v2|<username>|<deviceId>|<newDevicePubHex>|<issuedAt>`.
    public func canonicalBytes() -> Data {
        Data(
            [Self.canonicalTag, username, deviceId, newDevicePubHex, String(issuedAt)]
                .joined(separator: "|").utf8
        )
    }

    /// Sign with the account's CURRENT IRK (the vouching admin device).
    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }

    /// Verify a signature under the account's IRK public key. Returns
    /// false (never throws) on a malformed signature so callers can
    /// branch on a Bool, mirroring the TS `verifyDeviceAdmit`.
    public func verify(signature: Data, irkPub: Data) -> Bool {
        guard let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: irkPub) else {
            return false
        }
        return pub.isValidSignature(signature, for: canonicalBytes())
    }
}
