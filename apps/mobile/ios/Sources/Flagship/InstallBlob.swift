import Foundation
import CryptoKit

/// Phone-issued InstallBlob — the on-wire shape mirroring
/// apps/web/public/webapp/lib/buildDraft.js `canonicalInstallBlob`.
/// Both sides derive their signature input from `canonicalBytes()` so
/// the wire-format bytes are guaranteed identical.
///
/// The blob authorizes a freshly-booted server to register itself with
/// `.com` and serve traffic. It contains:
///   - the canonical FQDN `<serverName>.<username>.flagship.services`
///   - the IRK pubkey of the phone (the account-owner key)
///   - a delegated Ed25519 pubkey the server may use for its own ops
///   - the AuthCode + the user's IRK signature over it
///   - the RCK Ed25519 pubkey routing-control key
/// + a separate IRK signature over the canonical bytes (blobSignature).
public struct InstallBlob: Equatable, Sendable {
    public static let canonicalTag = "flagship/install-blob/v1"

    public var version: Int
    public var serverDomain: String
    public var username: String
    public var serverName: String
    public var phoneDelegatedPubKey: Data    // 32 bytes Ed25519
    public var registrationUrl: String
    public var authCode: AuthCode
    public var authCodeUserSignature: Data   // 64 bytes Ed25519
    public var issuedAt: Int64
    public var expiresAt: Int64
    public var installerGitRef: String
    public var rckPubKey: Data               // 32 bytes Ed25519

    public init(
        version: Int = 1,
        serverDomain: String,
        username: String,
        serverName: String,
        phoneDelegatedPubKey: Data,
        registrationUrl: String = "https://flagship.services/api/server/register",
        authCode: AuthCode,
        authCodeUserSignature: Data,
        issuedAt: Int64,
        expiresAt: Int64,
        installerGitRef: String = "main",
        rckPubKey: Data
    ) {
        self.version = version
        self.serverDomain = serverDomain
        self.username = username
        self.serverName = serverName
        self.phoneDelegatedPubKey = phoneDelegatedPubKey
        self.registrationUrl = registrationUrl
        self.authCode = authCode
        self.authCodeUserSignature = authCodeUserSignature
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.installerGitRef = installerGitRef
        self.rckPubKey = rckPubKey
    }

    /// Canonical bytes — pipe-separated, with `flagship/install-blob/v1`
    /// tag prefix. MUST match the JS `canonicalInstallBlob` byte-for-byte.
    public func canonicalBytes() -> Data {
        let parts: [String] = [
            InstallBlob.canonicalTag,
            String(version),
            serverDomain,
            username,
            serverName,
            HexUtil.encode(phoneDelegatedPubKey),
            registrationUrl,
            authCode.serial,
            HexUtil.encode(authCode.userPubKey),
            HexUtil.encode(authCodeUserSignature),
            String(issuedAt),
            String(expiresAt),
            installerGitRef,
            HexUtil.encode(rckPubKey),
        ]
        return Data(parts.joined(separator: "|").utf8)
    }
}

public struct AuthCode: Equatable, Sendable {
    public static let canonicalTag = "flagship/auth-code/v1"

    public var version: Int
    public var serial: String
    public var username: String
    public var serverName: String
    public var serverDomain: String
    public var delegatedPubKey: Data   // Ed25519
    public var userPubKey: Data        // Ed25519 (IRK)
    public var issuedAt: Int64
    public var expiresAt: Int64

    public init(
        version: Int = 1,
        serial: String,
        username: String,
        serverName: String,
        serverDomain: String,
        delegatedPubKey: Data,
        userPubKey: Data,
        issuedAt: Int64,
        expiresAt: Int64
    ) {
        self.version = version; self.serial = serial; self.username = username
        self.serverName = serverName; self.serverDomain = serverDomain
        self.delegatedPubKey = delegatedPubKey; self.userPubKey = userPubKey
        self.issuedAt = issuedAt; self.expiresAt = expiresAt
    }

    public func canonicalBytes() -> Data {
        let parts: [String] = [
            AuthCode.canonicalTag,
            String(version),
            serial,
            username,
            serverName,
            serverDomain,
            HexUtil.encode(delegatedPubKey),
            HexUtil.encode(userPubKey),
            String(issuedAt),
            String(expiresAt),
        ]
        return Data(parts.joined(separator: "|").utf8)
    }
}

public enum UsernameClaim {
    public static let canonicalTag = "flagship/claim-username/v1"
    public static func canonicalBytes(username: String, irkPubHex: String, issuedAt: Int64) -> Data {
        Data([canonicalTag, username, irkPubHex, String(issuedAt)].joined(separator: "|").utf8)
    }
}

public enum RckRegister {
    public static let canonicalTag = "flagship/rck-register/v1"
    public static func canonicalBytes(username: String, subdomain: String, rckPubHex: String, issuedAt: Int64) -> Data {
        Data([canonicalTag, username, subdomain, rckPubHex, String(issuedAt)].joined(separator: "|").utf8)
    }
}

/// Revoke a previously issued auth-code so a freshly-booted box that
/// presents that serial gets rejected by `.com`. User-facing this is
/// the "Cancel order" action on a pending pod. The protocol-level
/// tag matches packages/protocol/src/auth.ts `TAG_AUTH_CODE_REVOKE`.
public enum AuthCodeRevoke {
    public static let canonicalTag = "flagship/auth-code-revoke/v1"
    public static func canonicalBytes(serial: String, username: String, issuedAt: Int64) -> Data {
        Data([canonicalTag, serial, username, String(issuedAt)].joined(separator: "|").utf8)
    }
}

/// B7 — Re-pair initiate envelope. Signed by the NEW IRK over a
/// claim that includes the OLD IRK pubkey (for .com's snapshot
/// match) + the NEW pubkey + a freshness timestamp. Mirrors
/// packages/protocol/src/auth.ts `TAG_RE_PAIR_INITIATE`.
public enum RePairInitiate {
    public static let canonicalTag = "flagship/re-pair-initiate/v1"
    public static func canonicalBytes(
        username: String,
        newIrkPubHex: String,
        oldIrkPubHex: String,
        issuedAt: Int64
    ) -> Data {
        Data([
            canonicalTag,
            username,
            newIrkPubHex.lowercased(),
            oldIrkPubHex.lowercased(),
            String(issuedAt),
        ].joined(separator: "|").utf8)
    }
}

/// V2 — App URL-stem rename envelope. Signed by the user's current
/// IRK. The internal `appId` is preserved across renames; only the
/// user-visible `newDisplayLabel` changes. Mirrors
/// packages/protocol/src/auth.ts `TAG_APP_RENAME`.
public enum AppRenameClaim {
    public static let canonicalTag = "flagship/app-rename/v1"
    public static func canonicalBytes(
        username: String,
        appId: String,
        newDisplayLabel: String,
        issuedAt: Int64
    ) -> Data {
        Data([
            canonicalTag,
            username,
            appId,
            newDisplayLabel.lowercased(),
            String(issuedAt),
        ].joined(separator: "|").utf8)
    }
}

/// #79A — attach an external (custom) domain to an app. Signed by the
/// user's current IRK. Mirrors @flagship/protocol
/// canonicalSetCustomDomain + the Android/webapp clients byte-for-byte
/// so Live == Mock on the wire (a drift here = "signed-by-IRK but .com
/// rejects the attach").
public enum SetCustomDomainClaim {
    public static let canonicalTag = "flagship/custom-domain/v1"
    public static func canonicalBytes(
        username: String,
        appId: String,
        fqdn: String,
        issuedAt: Int64
    ) -> Data {
        Data([
            canonicalTag,
            username,
            appId,
            fqdn.lowercased(),
            String(issuedAt),
        ].joined(separator: "|").utf8)
    }
}

/// V2 — voi.ci one-off short link envelope. Signed by IRK. Optional
/// `appId` binds the link to a specific app so a future rename can
/// cascade-delete it.
public enum VoiciShortenClaim {
    public static let canonicalTag = "flagship/voici-shorten/v1"
    public static func canonicalBytes(
        username: String,
        appId: String?,
        targetUrl: String,
        issuedAt: Int64
    ) -> Data {
        Data([
            canonicalTag,
            username,
            appId ?? "",
            targetUrl,
            String(issuedAt),
        ].joined(separator: "|").utf8)
    }
}

/// E2 — Wipe & restart envelope. Signed by the OLD IRK over the
/// new IRK + new credentialID + SHA-256 of the new wrapped UMK.
/// Mirrors packages/protocol/src/auth.ts `TAG_WIPE_RESTART`.
public enum WipeRestartClaim {
    public static let canonicalTag = "flagship/wipe-restart/v1"
    public static func canonicalBytes(
        username: String,
        oldIrkPubHex: String,
        newIrkPubHex: String,
        newCredentialIdHex: String,
        newWrappedUmkHashHex: String,
        issuedAt: Int64
    ) -> Data {
        Data([
            canonicalTag,
            username,
            oldIrkPubHex.lowercased(),
            newIrkPubHex.lowercased(),
            newCredentialIdHex.lowercased(),
            newWrappedUmkHashHex.lowercased(),
            String(issuedAt),
        ].joined(separator: "|").utf8)
    }
}

/// Push-token registration claim. Mirrors
/// packages/protocol/src/auth.ts `TAG_PUSH_TOKEN_REGISTER` so the Worker
/// can `verifyPushTokenRegister` over the exact same bytes the phone
/// signed. Platform is one of `apns`, `fcm`, `webpush`; `providerToken`
/// is opaque to .com (APNs hex token or FCM registration ID).
public enum PushTokenRegister {
    public static let canonicalTag = "flagship/push-token-register/v1"
    public static func canonicalBytes(
        username: String,
        platform: String,
        providerToken: String,
        pushX25519PubHex: String,
        label: String,
        issuedAt: Int64
    ) -> Data {
        // Field order must match the Worker's canonicalPushTokenRegister
        // in packages/protocol/src/auth.ts. The `label` field was added
        // pre-launch (no v2 bump needed); it slots between pushX25519Pub
        // and issuedAt on both sides.
        Data([
            canonicalTag, username, platform, providerToken, pushX25519PubHex, label, String(issuedAt)
        ].joined(separator: "|").utf8)
    }
}

/// Helper — every byte → 2 lowercase hex chars. Matches the JS side's
/// `bytesToHex`.
public enum HexUtil {
    public static func encode(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
    public static func decode(_ hex: String) -> Data? {
        guard hex.count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(hex.count / 2)
        var i = hex.startIndex
        while i < hex.endIndex {
            let next = hex.index(i, offsetBy: 2)
            guard let b = UInt8(hex[i..<next], radix: 16) else { return nil }
            bytes.append(b); i = next
        }
        return Data(bytes)
    }
}

/// Generates a 26-char hexlike serial — matches genSerial() in
/// create-server.js: a "01" prefix + 10 random bytes hexlified,
/// truncated to 26 chars.
public enum SerialGen {
    public static func random() -> String {
        let bytes = Data((0..<10).map { _ in UInt8.random(in: 0...255) })
        var s = "01"
        for b in bytes { s += String(format: "%02X", b) }
        return String(s.prefix(26))
    }
}
