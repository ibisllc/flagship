import Foundation
import CryptoKit

/// Builds the `Authorization` header for the dedicated boot worker
/// (boot.flagshipserver.com). Mirrors `apps/boot/src/gate.ts`
/// byte-for-byte: the phone is the OWNER principal (writes — deposit a
/// lease, revoke a lease, post a sealed response), signing with the
/// account IRK.
///
///   Authorization: Flagship-Boot-v1 <base64url(JSON of the envelope)>
///
/// The Ed25519 signature covers the canonical bytes
///   `flagship/boot-auth/v1|<role>|<serverDomain>|<METHOD>|<path>|<pubKeyHex>|<nonceHex>|<issuedAt>`
/// so a captured header can't be retargeted to a different role / server /
/// method / path. The boot worker re-derives these by field name (JSON key
/// order is irrelevant) and verifies the signature against the directory-
/// bound account IRK.
public enum BootAuth {
    public static let scheme = "Flagship-Boot-v1"
    public static let canonicalTag = "flagship/boot-auth/v1"

    /// Canonical bytes the signature covers. MUST match gate.ts
    /// `canonicalBootAuth` exactly.
    public static func canonicalBytes(
        role: String,
        serverDomain: String,
        method: String,
        path: String,
        pubKeyHex: String,
        nonceHex: String,
        issuedAt: Int64
    ) -> Data {
        Data([
            canonicalTag,
            role,
            serverDomain,
            method.uppercased(),
            path,
            pubKeyHex.lowercased(),
            nonceHex.lowercased(),
            String(issuedAt),
        ].joined(separator: "|").utf8)
    }

    private struct Envelope: Encodable {
        let role: String
        let serverDomain: String
        let method: String
        let path: String
        let pubKeyHex: String
        let nonceHex: String
        let issuedAt: Int64
        let signatureHex: String
    }

    public static func randomNonce() -> Data {
        var b = Data(count: 32)
        _ = b.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        return b
    }

    /// Build the owner-role `Authorization` header value, IRK-signed.
    /// `method` is uppercased; `path` is the exact request path (no query),
    /// including any domain/leaseId segment — it must equal what the worker
    /// router resolves, so a sig for one route can't replay against another.
    public static func ownerHeader(
        serverDomain: String,
        method: String,
        path: String,
        irk: Curve25519.Signing.PrivateKey,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        nonce: Data? = nil
    ) throws -> String {
        let n = nonce ?? randomNonce()
        let pubHex = HexUtil.encode(irk.publicKey.rawRepresentation)
        let nonceHex = HexUtil.encode(n)
        let canon = canonicalBytes(
            role: "owner",
            serverDomain: serverDomain,
            method: method,
            path: path,
            pubKeyHex: pubHex,
            nonceHex: nonceHex,
            issuedAt: now
        )
        let sig = try irk.signature(for: canon)
        let env = Envelope(
            role: "owner",
            serverDomain: serverDomain,
            method: method.uppercased(),
            path: path,
            pubKeyHex: pubHex,
            nonceHex: nonceHex,
            issuedAt: now,
            signatureHex: HexUtil.encode(sig)
        )
        let json = try JSONEncoder().encode(env)
        return "\(scheme) \(base64url(json))"
    }

    /// base64url without padding — matches gate.ts `b64urlDecode` (which
    /// re-pads on the way in).
    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
