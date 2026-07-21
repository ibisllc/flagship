import Foundation
import CryptoKit

/// Swift mirror of the sealed directory/profile-key delivery in
/// `packages/protocol/src/directoryKeyDelivery.ts` (+ the
/// `AccountDirectoryKeyGrant` envelope in `accountMetadata.ts`).
///
/// A RESTRICTED device never holds the account UMK, so it cannot derive the
/// account-profile key or the device-directory key and thus can list the
/// private directory but decrypt no names. An ADMIN device seals the permitted
/// 32-byte key to this device's registered Ed25519 identity pubkey via
/// `SecretSeal` (the same primitive pinned by the four cross-platform seal
/// KATs) and publishes an admin-root-signed grant. THIS type verifies the
/// admin-root signature + the account/device binding (+ expiry) BEFORE
/// unsealing with the device's own Ed25519 seed, then hands the key to
/// `AccountMetadata.decrypt`.
///
/// The canonical bytes + `|`-joined field order MUST match
/// `canonicalAccountDirectoryKeyGrant` byte-for-byte, and the OPEN direction is
/// pinned by the shared `test-vectors/directory-key-delivery.json`.
public struct AccountDirectoryKeyGrant: Equatable, Sendable {
    public static let canonicalTag = "flagship/account-directory-key-grant/v1"

    public enum KeyKind: String, Sendable, Equatable {
        case accountProfile = "account-profile"
        case deviceDirectory = "device-directory"
    }

    public enum GrantError: Error, Equatable {
        case emptyAccountId
        case separatorInAccountId
        case badRecipientDeviceId
        case badSignerPub
        case badSealedKey
        case expiryNotAfterIssue
    }

    public let accountId: String
    /// 16-byte device id, lowercase hex (32 chars).
    public let recipientDeviceId: String
    public let keyKind: KeyKind
    /// The directory key sealed to the recipient device (SecretSeal output),
    /// lowercase hex. `[eph:32][nonce:12][ct+tag]`.
    public let sealedKeyHex: String
    public let issuedAt: Int64
    public let expiresAt: Int64
    /// The account admin-root pubkey, lowercase hex (64 chars).
    public let signerPubHex: String

    public init(
        accountId: String,
        recipientDeviceId: String,
        keyKind: KeyKind,
        sealedKeyHex: String,
        issuedAt: Int64,
        expiresAt: Int64,
        signerPubHex: String
    ) {
        self.accountId = accountId
        self.recipientDeviceId = recipientDeviceId
        self.keyKind = keyKind
        self.sealedKeyHex = sealedKeyHex
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.signerPubHex = signerPubHex
    }

    private static let deviceIdPattern = try! NSRegularExpression(pattern: "^[0-9a-f]{32}$")
    private static let hex64Pattern = try! NSRegularExpression(pattern: "^[0-9a-f]{64}$")
    private static let hexPattern = try! NSRegularExpression(pattern: "^[0-9a-f]+$")

    private static func matches(_ pattern: NSRegularExpression, _ s: String) -> Bool {
        pattern.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    public func validate() throws {
        if accountId.isEmpty { throw GrantError.emptyAccountId }
        if accountId.contains("|") { throw GrantError.separatorInAccountId }
        if !Self.matches(Self.deviceIdPattern, recipientDeviceId) { throw GrantError.badRecipientDeviceId }
        if sealedKeyHex.count < 2 || !Self.matches(Self.hexPattern, sealedKeyHex) { throw GrantError.badSealedKey }
        if !Self.matches(Self.hex64Pattern, signerPubHex) { throw GrantError.badSignerPub }
        if expiresAt <= issuedAt { throw GrantError.expiryNotAfterIssue }
    }

    /// `flagship/account-directory-key-grant/v1|accountId|recipientDeviceId|keyKind|sealedKeyHex|issuedAt|expiresAt|signerPubHex`.
    public func canonicalBytes() throws -> Data {
        try validate()
        return Data([
            Self.canonicalTag,
            accountId.lowercased(),
            recipientDeviceId,
            keyKind.rawValue,
            sealedKeyHex,
            String(issuedAt),
            String(expiresAt),
            signerPubHex,
        ].joined(separator: "|").utf8)
    }

    /// Verify the admin-root signature. Returns false (never throws) on any
    /// malformed input, mirroring `verifyAccountDirectoryKeyGrant`.
    public func verify(signature: Data, adminRootPub: Data) -> Bool {
        guard
            let bytes = try? canonicalBytes(),
            let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: adminRootPub)
        else { return false }
        return pub.isValidSignature(signature, for: bytes)
    }
}

/// RECIPIENT-side open: verify the admin-root signature + the account/device
/// binding (+ expiry when `now` is supplied), THEN unseal the delivered key
/// with the device's Ed25519 identity seed. Returns the 32-byte key, or `nil`
/// on ANY defect (bad signature, wrong recipient, wrong account, tampered
/// ciphertext, expired). NEVER throws — fails closed.
public enum AccountDirectoryKeyDelivery {
    public static func open(
        grant: AccountDirectoryKeyGrant,
        signature: Data,
        adminRootPub: Data,
        expectedAccountId: String,
        expectedRecipientDeviceId: String,
        recipientDeviceSeed: Data,
        now: Int64? = nil
    ) -> Data? {
        guard grant.accountId.lowercased() == expectedAccountId.lowercased() else { return nil }
        guard grant.recipientDeviceId == expectedRecipientDeviceId.lowercased() else { return nil }
        if let now, now < grant.issuedAt || now >= grant.expiresAt { return nil }
        guard grant.verify(signature: signature, adminRootPub: adminRootPub) else { return nil }
        guard let blob = HexUtil.decode(grant.sealedKeyHex) else { return nil }
        guard let key = try? SecretSeal.openWithEd25519Seed(
            blob: blob,
            recipientEd25519Seed: recipientDeviceSeed
        ), key.count == 32 else { return nil }
        return key
    }
}
