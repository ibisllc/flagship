import Foundation
import CryptoKit

/// Swift mirror of `@flagship/protocol`'s `serviceInvite.ts` + the AID /
/// household-key derivations in `keys.ts` — the `flagship/service-invite/v1`
/// tag family for the UMK-anchored, first-bind, bearer-link service-access
/// gating model (docs/service-access-gating.md).
///
/// Identity is the STABLE **AID** (`deriveAccountId`), NOT the versioned IRK.
/// The author's IRK SIGNS create + revoke (active orders by the current device
/// key); the friend is IDENTIFIED by — and signs redeem + visits with — their
/// AID. The webapp (`lib/serviceInvite.js`) + Android (`ServiceInvite.kt`)
/// mirror the SAME canonical bytes; the cross-platform pinned vectors in
/// `packages/protocol/tests/fixtures/serviceAccessGating.vectors.json` (asserted
/// by `ServiceInviteVectorTests`) lock every byte in.
///
/// Crypto MUST stay byte-identical to the TS implementation:
///   AID seed     = HKDF-SHA256(ikm = UMK seed, salt = empty,
///                              info = "flagship/account-id/v1", 32) → Ed25519
///   householdKey = HKDF-SHA256(ikm = UMK seed, salt = empty,
///                              info = "flagship/household-key/v1", 32)
///   bundle       = AES-256-GCM(householdKey, 12-B nonce,
///                              aad = "flagship/service-invite/bundle/v1|<inviteId>")
///                  wire = nonce || ciphertext || tag (hex)
public enum ServiceInvite {
    // Canonical-bytes tags — MUST match @flagship/protocol.
    public static let tagCreate = "flagship/service-invite/create/v1"
    public static let tagRedeem = "flagship/service-invite/redeem/v1"
    public static let tagRevoke = "flagship/service-invite/revoke/v1"
    public static let tagInviteId = "flagship/service-invite/id/v1"
    public static let tagBundle = "flagship/service-invite/bundle/v1"
    public static let tagAccessMode = "flagship/service-access-mode/v1"
    public static let tagVisit = "flagship/service-visit/v1"

    // ── Key derivation (mirror keys.ts: empty-salt HKDF-SHA256) ──────────

    /// Stable Account Identity Key SEED (32 B) — `HKDF(umkSeed, info =
    /// "flagship/account-id/v1")`. Survives the IRK's rotations (re-pair /
    /// wipe-restart derive a fresh IRK from the same UMK); resets only on a
    /// brand-new account. This is the identity bound in allow-lists + invites.
    public static func deriveAccountIdSeed(umkSeed: Data) -> Data? {
        guard umkSeed.count == 32 else { return nil }
        return hkdfSha256(ikm: umkSeed, info: Data("flagship/account-id/v1".utf8))
    }

    /// The stable AID Ed25519 PRIVATE key (the friend's redeem/visit signer;
    /// the author's recorded identity). Derived from the UMK seed.
    public static func deriveAccountId(umkSeed: Data) -> Curve25519.Signing.PrivateKey? {
        guard let seed = deriveAccountIdSeed(umkSeed: umkSeed) else { return nil }
        return try? Curve25519.Signing.PrivateKey(rawRepresentation: seed)
    }

    /// The stable AID Ed25519 PUBLIC key (32 B) — the allow-list / invite key.
    public static func deriveAccountIdPub(umkSeed: Data) -> Data? {
        deriveAccountId(umkSeed: umkSeed)?.publicKey.rawRepresentation
    }

    /// The household symmetric AEAD key (32 B) — `HKDF(umkSeed, info =
    /// "flagship/household-key/v1")`. Every device of the account (all share
    /// the UMK) + the author's boxes derive the SAME key, so the sealed
    /// `{name, photo?}` bundle opens on a sibling device / box; .com never
    /// holds the UMK → stores ciphertext only and cannot read it.
    public static func deriveHouseholdKey(umkSeed: Data) -> Data? {
        guard umkSeed.count == 32 else { return nil }
        return hkdfSha256(ikm: umkSeed, info: Data("flagship/household-key/v1".utf8))
    }

    /// The protocol IRK SEED (`HKDF(umkSeed, info = "flagship.irk.v1")`) — the
    /// v1 device key a @flagship/protocol-provisioned account is registered
    /// under. Used by the cross-platform vector test to reproduce the pinned
    /// author IRK; the live app signs create/revoke with its CURRENT versioned
    /// IRK (`Keystore.deriveIRK`), which .com/the box verify against the
    /// registered pub. Mirrors ServerKeys.kt `deriveProtocolIrkSeed`.
    public static func deriveProtocolIrkSeed(umkSeed: Data) -> Data? {
        guard umkSeed.count == 32 else { return nil }
        return hkdfSha256(ikm: umkSeed, info: Data("flagship.irk.v1".utf8))
    }

    // ── inviteId + secretHash ────────────────────────────────────────────

    /// `inviteId = sha256( tagInviteId | sha256(authorAID) | sha256(devicePub)
    /// | counter )` — deterministic, attributable to (account, device),
    /// monotonic. Returns lowercase hex (64 chars). Mirrors `serviceInviteId`.
    public static func inviteId(authorAidPub: Data, authorDevicePub: Data, counter: Int) -> String? {
        guard counter >= 0 else { return nil }
        let pre = [
            tagInviteId,
            HexUtil.encode(sha256(authorAidPub)),
            HexUtil.encode(sha256(authorDevicePub)),
            String(counter),
        ].joined(separator: "|")
        return HexUtil.encode(sha256(Data(pre.utf8)))
    }

    /// SHA-256 hex of a 32-byte capability secret — the form .com stores/indexes.
    public static func secretHash(secret: Data) -> String {
        HexUtil.encode(sha256(secret))
    }

    // ── The value-blind bundle ({ name, photo? }) ────────────────────────

    public struct Bundle: Equatable, Sendable {
        public var name: String
        public var photo: String?
        public init(name: String, photo: String? = nil) {
            self.name = name
            self.photo = photo
        }
    }

    private static func bundleAad(inviteId: String) -> Data {
        Data([tagBundle, inviteId].joined(separator: "|").utf8)
    }

    /// Serialize the bundle the SAME way @flagship/protocol does:
    /// `{"name":…}` or `{"name":…,"photo":…}` — name FIRST, photo only when
    /// present — so the sealed JSON is byte-identical for a given nonce.
    private static func bundleJSON(_ b: Bundle) -> Data {
        // Hand-build to pin key ORDER + escaping to JSON.stringify (no NUL/control
        // chars are expected in name/photo; JSONEncoder would reorder/escape
        // differently, so we encode each string with JSONEncoder individually
        // to get RFC-correct escaping, then assemble in fixed order).
        let nameJSON = jsonString(b.name)
        if let photo = b.photo {
            return Data("{\"name\":\(nameJSON),\"photo\":\(jsonString(photo))}".utf8)
        }
        return Data("{\"name\":\(nameJSON)}".utf8)
    }

    /// JSON-encode a single string EXACTLY as JSON.stringify would (so the
    /// sealed plaintext matches the JS/TS twin byte-for-byte).
    private static func jsonString(_ s: String) -> String {
        // JSONSerialization on a wrapper array yields JS-compatible escaping;
        // strip the array brackets to get the bare string literal.
        guard let data = try? JSONSerialization.data(withJSONObject: [s], options: []),
              var str = String(data: data, encoding: .utf8)
        else {
            // Should not happen for valid Swift strings.
            return "\"\(s)\""
        }
        // str is like ["..."]; drop the leading [ and trailing ].
        str.removeFirst()
        str.removeLast()
        return str
    }

    /// Seal `{ name, photo? }` under the household key, bound to `inviteId`.
    /// Returns lowercase hex of `nonce || ciphertext || tag`. Throws on a bad
    /// key. A bundle sealed here opens on the box / a sibling device (and the
    /// webapp / Android twins) and vice-versa.
    public static func sealBundle(_ bundle: Bundle, householdKey: Data, inviteId: String) throws -> String {
        guard householdKey.count == 32 else { throw ServiceInviteError.badKey }
        let key = SymmetricKey(data: householdKey)
        let nonce = try AES.GCM.Nonce(data: randomData(12))
        let sealed = try AES.GCM.seal(
            bundleJSON(bundle),
            using: key,
            nonce: nonce,
            authenticating: bundleAad(inviteId: inviteId)
        )
        // Wire = nonce || ciphertext || tag (matches @noble/ciphers' layout).
        var out = Data()
        out.append(Data(nonce))
        out.append(sealed.ciphertext)
        out.append(sealed.tag)
        return HexUtil.encode(out)
    }

    /// Open a bundle sealed by `sealBundle` (or its protocol/webapp/Android
    /// twin). Throws on a bad key / tampered ciphertext / wrong inviteId.
    public static func openBundle(_ sealedHex: String, householdKey: Data, inviteId: String) throws -> Bundle {
        guard householdKey.count == 32 else { throw ServiceInviteError.badKey }
        guard let buf = HexUtil.decode(sealedHex), buf.count >= 12 + 16 else {
            throw ServiceInviteError.malformed
        }
        let key = SymmetricKey(data: householdKey)
        let nonce = try AES.GCM.Nonce(data: buf.prefix(12))
        let rest = buf.suffix(from: buf.startIndex + 12)
        let tag = rest.suffix(16)
        let ciphertext = rest.prefix(rest.count - 16)
        let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
        let plain = try AES.GCM.open(box, using: key, authenticating: bundleAad(inviteId: inviteId))
        guard let obj = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
              let name = obj["name"] as? String
        else {
            throw ServiceInviteError.malformed
        }
        return Bundle(name: name, photo: obj["photo"] as? String)
    }

    // ── Canonical bytes (mirror @flagship/protocol exactly) ──────────────

    /// `tagCreate | inviteId | hex(authorAID) | serviceRef | secretHash | encryptedBundle | issuedAt`
    public static func canonicalCreate(
        inviteId: String,
        authorAID: Data,
        serviceRef: String,
        secretHash: String,
        encryptedBundle: String,
        issuedAt: Int64
    ) throws -> Data {
        try validateNoSepCtrl("inviteId", inviteId)
        try validateNoSepCtrl("serviceRef", serviceRef)
        try validateNoSepCtrl("secretHash", secretHash)
        try validateNoSepCtrl("encryptedBundle", encryptedBundle)
        return Data([
            tagCreate, inviteId, HexUtil.encode(authorAID), serviceRef, secretHash,
            encryptedBundle, String(issuedAt),
        ].joined(separator: "|").utf8)
    }

    /// `tagRedeem | secretHash | hex(visitorAID) | redeemedAt`
    public static func canonicalRedeem(secretHash: String, visitorAID: Data, redeemedAt: Int64) throws -> Data {
        try validateNoSepCtrl("secretHash", secretHash)
        return Data([tagRedeem, secretHash, HexUtil.encode(visitorAID), String(redeemedAt)].joined(separator: "|").utf8)
    }

    /// `tagRevoke | inviteId | issuedAt`
    public static func canonicalRevoke(inviteId: String, issuedAt: Int64) throws -> Data {
        try validateNoSepCtrl("inviteId", inviteId)
        return Data([tagRevoke, inviteId, String(issuedAt)].joined(separator: "|").utf8)
    }

    /// `tagAccessMode | serverId | serviceRef | mode | issuedAt`
    public static func canonicalSetAccessMode(
        serverId: String,
        serviceRef: String,
        mode: String,
        issuedAt: Int64
    ) throws -> Data {
        try validateNoSepCtrl("serverId", serverId)
        try validateNoSepCtrl("serviceRef", serviceRef)
        guard mode == "open" || mode == "restricted" else { throw ServiceInviteError.badMode }
        return Data([tagAccessMode, serverId, serviceRef, mode, String(issuedAt)].joined(separator: "|").utf8)
    }

    /// `tagVisit | serverId | serviceRef | hex(visitorAID) | issuedAt`
    public static func canonicalVisit(
        serverId: String,
        serviceRef: String,
        visitorAID: Data,
        issuedAt: Int64
    ) throws -> Data {
        try validateNoSepCtrl("serverId", serverId)
        try validateNoSepCtrl("serviceRef", serviceRef)
        return Data([tagVisit, serverId, serviceRef, HexUtil.encode(visitorAID), String(issuedAt)].joined(separator: "|").utf8)
    }

    // ── Sign / verify helpers ────────────────────────────────────────────

    public static func sign(_ bytes: Data, with key: Curve25519.Signing.PrivateKey) throws -> Data {
        try key.signature(for: bytes)
    }

    public static func verify(_ sig: Data, _ bytes: Data, pub: Data) -> Bool {
        guard let pk = try? Curve25519.Signing.PublicKey(rawRepresentation: pub) else { return false }
        return pk.isValidSignature(sig, for: bytes)
    }

    /// Build the `x-flagship-visit` header value a restricted-service request
    /// carries: base64(JSON({ proof, sig })). AID-signed. The box checks the
    /// sig + that the AID is allow-listed, with a short replay window.
    public static func visitHeaderValue(
        serverId: String,
        serviceRef: String,
        visitorAID: Data,
        issuedAt: Int64,
        aid: Curve25519.Signing.PrivateKey
    ) throws -> String {
        let bytes = try canonicalVisit(serverId: serverId, serviceRef: serviceRef, visitorAID: visitorAID, issuedAt: issuedAt)
        let sig = try aid.signature(for: bytes)
        // proof object: serverId, serviceRef, visitorAID(hex), issuedAt — key
        // order isn't load-bearing (the box re-parses by name), but match the JS.
        let proof: [String: Any] = [
            "serverId": serverId,
            "serviceRef": serviceRef,
            "visitorAID": HexUtil.encode(visitorAID),
            "issuedAt": issuedAt,
        ]
        let payload: [String: Any] = ["proof": proof, "sig": HexUtil.encode(sig)]
        let json = try JSONSerialization.data(withJSONObject: payload, options: [])
        return json.base64EncodedString()
    }

    // ── internals ─────────────────────────────────────────────────────────

    /// Reject '|' (the canonical separator) and control chars (0x00–0x1F, 0x7F)
    /// in any user-controlled string field — mirrors `validateNoSepCtrl`.
    static func validateNoSepCtrl(_ name: String, _ value: String) throws {
        for scalar in value.unicodeScalars {
            let c = scalar.value
            if c == 0x7c { throw ServiceInviteError.field("\(name): separator '|'") }
            if c <= 0x1f || c == 0x7f { throw ServiceInviteError.field("\(name): control char") }
        }
    }

    private static func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }

    private static func randomData(_ n: Int) -> Data {
        var d = Data(count: n)
        d.withUnsafeMutableBytes { _ = SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
        return d
    }

    /// RFC 5869 HKDF-SHA256 with an EMPTY salt — byte-identical to the TS
    /// protocol's `new Uint8Array(0)` (and to ServerKeys.swift / .kt).
    private static func hkdfSha256(ikm: Data, info: Data, outputByteCount: Int = 32) -> Data {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm),
            salt: Data(),
            info: info,
            outputByteCount: outputByteCount
        )
        return key.withUnsafeBytes { Data($0) }
    }
}

public enum ServiceInviteError: Error, Equatable {
    case badKey
    case malformed
    case badMode
    case field(String)
}
