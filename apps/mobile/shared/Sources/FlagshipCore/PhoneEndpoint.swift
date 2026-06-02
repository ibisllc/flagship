import Foundation
import CryptoKit

/// Phone-as-unlock-endpoint RELAY model — the phone's half of the
/// boot-secret handshake (docs/security-phone-as-unlock-endpoint.md).
///
/// `.com` is a blind store-and-forward mailbox: the booting box posts an
/// STK-signed `SecretRequest`, `.com` wakes the phone via push, the phone
/// fetches the pending requests (proving ownership with an IRK-signed
/// `DeviceEndpointClaim` mailbox-auth credential), re-verifies the box's
/// request against the directory-resolved STK + the user's visual confirm,
/// and posts a reply — a `SealedSecretResponse` (sealed FOR the box's STK)
/// for `unlock-key`, or an IRK-signed `RootEntitlement` carrier for
/// `entitlement`. `.com` only ever holds ciphertext + public-signed blobs.
///
/// Every canonical-bytes layout here MUST match `@flagship/protocol`'s
/// `phoneEndpoint.ts` byte-for-byte (the iOS-Mock-matches-Worker-wire
/// invariant) — `.com` (esbuild), the daemon, and the Android mirror all
/// consume the same bytes.

// MARK: - 1. DeviceEndpointClaim (IRK-signed mailbox-auth)

/// Repurposed as the phone's mailbox-auth credential (there is no hosted
/// endpoint). The phone signs this with the user's IRK; `.com` verifies it
/// against the account's registered IRK so it serves the mailbox ONLY to
/// the user's own identity key.
public struct DeviceEndpointClaim: Equatable, Sendable {
    public static let canonicalTag = "flagship/device-endpoint-claim/v1"

    public var username: String
    public var endpointLabel: String
    public var phoneIrkPub: Data    // 32 bytes Ed25519 — the account IRK
    public var issuedAt: Int64
    public var expiresAt: Int64
    public var nonce: Data          // 32 bytes — per-claim uniqueness

    public init(
        username: String,
        endpointLabel: String,
        phoneIrkPub: Data,
        issuedAt: Int64,
        expiresAt: Int64,
        nonce: Data
    ) {
        self.username = username
        self.endpointLabel = endpointLabel
        self.phoneIrkPub = phoneIrkPub
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.nonce = nonce
    }

    /// Canonical bytes — MUST match `canonicalDeviceEndpointClaim` in
    /// phoneEndpoint.ts byte-for-byte. The fieldGuard there rejects '|'
    /// and control chars in `username` / `endpointLabel` at sign time; we
    /// throw the equivalent so a bad field never canonicalizes ambiguously.
    public func canonicalBytes() throws -> Data {
        try PhoneEndpointFieldGuard.check("username", username)
        try PhoneEndpointFieldGuard.check("endpointLabel", endpointLabel)
        let parts: [String] = [
            DeviceEndpointClaim.canonicalTag,
            username,
            endpointLabel,
            HexUtil.encode(phoneIrkPub),
            String(issuedAt),
            String(expiresAt),
            HexUtil.encode(nonce),
        ]
        return Data(parts.joined(separator: "|").utf8)
    }

    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }

    public static func verify(
        _ claim: DeviceEndpointClaim,
        signature: Data,
        irkPub: Curve25519.Signing.PublicKey
    ) -> Bool {
        guard let bytes = try? claim.canonicalBytes() else { return false }
        return irkPub.isValidSignature(signature, for: bytes)
    }
}

// MARK: - 2. SecretRequest (STK-signed — the box's request, re-verified)

public enum SecretPurpose: String, Equatable, Sendable, Codable {
    case unlockKey = "unlock-key"
    case entitlement = "entitlement"
}

/// The booting box's STK-signed request. The phone RE-VERIFIES this against
/// the box's STK independently resolved from the directory — `.com` is not
/// a trust anchor.
public struct SecretRequest: Equatable, Sendable {
    public static let canonicalTag = "flagship/secret-request/v1"

    public var serverDomain: String
    public var stkPub: Data         // 32 bytes Ed25519
    public var purpose: SecretPurpose
    public var nonce: Data          // 32 bytes
    public var issuedAt: Int64

    public init(
        serverDomain: String,
        stkPub: Data,
        purpose: SecretPurpose,
        nonce: Data,
        issuedAt: Int64
    ) {
        self.serverDomain = serverDomain
        self.stkPub = stkPub
        self.purpose = purpose
        self.nonce = nonce
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try PhoneEndpointFieldGuard.check("serverDomain", serverDomain)
        let parts: [String] = [
            SecretRequest.canonicalTag,
            serverDomain,
            HexUtil.encode(stkPub),
            purpose.rawValue,
            HexUtil.encode(nonce),
            String(issuedAt),
        ]
        return Data(parts.joined(separator: "|").utf8)
    }

    /// Re-verify the box's request against the supplied STK. The caller
    /// MUST pass the STK as independently resolved from the directory (the
    /// `pods[].identityPubKey` for this `serverDomain`), NOT the `stkPub`
    /// echoed by `.com` — so a lying relay can't get the phone to seal for
    /// a box it controls.
    public static func verify(
        _ request: SecretRequest,
        signature: Data,
        stkPub: Curve25519.Signing.PublicKey
    ) -> Bool {
        guard let bytes = try? request.canonicalBytes() else { return false }
        return stkPub.isValidSignature(signature, for: bytes)
    }
}

// MARK: - 3. SealedSecretResponse (sealed FOR the box's STK)

/// The phone's reply for an `unlock-key` request. The secret is sealed for
/// the box's STK (Ed25519→X25519 birational map → `crypto_box_seal`-style),
/// bound to the request's (nonce, purpose) via a length-prefixed context
/// header prepended before sealing. There is NO plaintext field on the wire
/// — the plaintext lives only inside `sealed`.
public struct SealedSecretResponse: Equatable, Sendable {
    static let contextTag = "flagship/secret-response/v1"

    public var serverDomain: String
    public var requestNonceHex: String
    public var purpose: SecretPurpose
    public var sealed: Data
    public var issuedAt: Int64

    public init(
        serverDomain: String,
        requestNonceHex: String,
        purpose: SecretPurpose,
        sealed: Data,
        issuedAt: Int64
    ) {
        self.serverDomain = serverDomain
        self.requestNonceHex = requestNonceHex
        self.purpose = purpose
        self.sealed = sealed
        self.issuedAt = issuedAt
    }

    /// The context bytes prepended to the secret before sealing. Binds the
    /// sealed payload to the request's (nonce, purpose). MUST match
    /// `secretResponseContext` in phoneEndpoint.ts.
    static func context(nonce: Data, purpose: SecretPurpose) -> Data {
        Data([contextTag, HexUtil.encode(nonce), purpose.rawValue]
            .joined(separator: "|").utf8)
    }

    /// Phone-side: seal `secret` for the box's STK, bound to the request's
    /// (nonce, purpose). The caller has already re-verified the request's
    /// STK against the directory + the user's visual confirm. `now` is
    /// injectable so tests can pin `issuedAt`.
    public static func build(
        secret: Data,
        request: SecretRequest,
        now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) throws -> SealedSecretResponse {
        let ctx = context(nonce: request.nonce, purpose: request.purpose)
        // [ctxLen:4 BE][ctx][secret] — length-prefixed so the box can split.
        var payload = Data(count: 4)
        let len = UInt32(ctx.count)
        payload[0] = UInt8((len >> 24) & 0xff)
        payload[1] = UInt8((len >> 16) & 0xff)
        payload[2] = UInt8((len >> 8) & 0xff)
        payload[3] = UInt8(len & 0xff)
        payload.append(ctx)
        payload.append(secret)
        let sealed = try SecretSeal.sealForEd25519Recipient(
            plaintext: payload,
            recipientEd25519Pub: request.stkPub
        )
        return SealedSecretResponse(
            serverDomain: request.serverDomain,
            requestNonceHex: HexUtil.encode(request.nonce),
            purpose: request.purpose,
            sealed: sealed,
            issuedAt: now()
        )
    }
}

// MARK: - 4. RootEntitlement (IRK-signed — entitlement reply carrier)

/// The phone-signed admission credential for the `entitlement` handshake.
/// The IRK signs (username, podPubKey=stkPub, podCanonical=serverDomain).
/// MUST match `canonicalRootEntitlement` in auth.ts byte-for-byte.
public struct RootEntitlement: Equatable, Sendable {
    public static let canonicalTag = "flagship/root-entitlement/v1"

    public var username: String
    public var podPubKey: Data      // 32 bytes — the box STK
    public var podCanonical: String
    public var issuedAt: Int64

    public init(username: String, podPubKey: Data, podCanonical: String, issuedAt: Int64) {
        self.username = username
        self.podPubKey = podPubKey
        self.podCanonical = podCanonical
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() -> Data {
        Data([
            RootEntitlement.canonicalTag,
            username,
            HexUtil.encode(podPubKey),
            podCanonical,
            String(issuedAt),
        ].joined(separator: "|").utf8)
    }

    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }

    public static func verify(
        _ cert: RootEntitlement,
        signature: Data,
        irkPub: Curve25519.Signing.PublicKey
    ) -> Bool {
        irkPub.isValidSignature(signature, for: cert.canonicalBytes())
    }
}

/// The on-disk EntitlementBundle carrier the daemon reads
/// (`packages/server-daemon/src/entitlementBundleStore.ts`
/// `EntitlementBundleFile`). We emit the ROOT-ONLY form: the phone signs a
/// `RootEntitlement` with the user IRK and serializes it as this JSON; the
/// daemon parses it identically (hex byte fields, no serviceEntitlement).
/// The `entitlement` `secret-response` carries the hex-encoding of these
/// JSON bytes in its `sealed` field (it is signed-but-public, not secret —
/// invariant I1 holds: `.com` sees only a public-signed blob).
public enum EntitlementBundleCarrier {
    /// Serialize a root-only bundle to the daemon's exact on-disk JSON.
    /// Field names + ordering + hex casing mirror `serializeEntitlementBundle`.
    public static func serialize(
        rootEntitlement: RootEntitlement,
        rootEntitlementSig: Data
    ) -> Data {
        // Build the JSON by hand so the key order + null fields exactly
        // match the daemon's `EntitlementBundleFile`. JSONSerialization
        // does not guarantee key order, and the daemon parses by KEY so
        // order is cosmetic, but we keep it deterministic for tests.
        let root: [String: Any] = [
            "username": rootEntitlement.username,
            "podPubKey": HexUtil.encode(rootEntitlement.podPubKey),
            "podCanonical": rootEntitlement.podCanonical,
            "issuedAt": rootEntitlement.issuedAt,
        ]
        let file: [String: Any] = [
            "rootEntitlement": root,
            "rootEntitlementSig": HexUtil.encode(rootEntitlementSig),
            "serviceEntitlement": NSNull(),
            "serviceEntitlementSig": NSNull(),
        ]
        // JSONSerialization with no .prettyPrinted matches the daemon's
        // parser (it reads by key, not by exact text). sortedKeys gives a
        // stable byte output for the test mirror.
        let data = (try? JSONSerialization.data(
            withJSONObject: file,
            options: [.sortedKeys]
        )) ?? Data()
        return data
    }
}

// MARK: - 5. AutoUnlockLeaseV2 (box-sealed lease — "auto" self-unlock)

/// The phone deposits this (IRK-signed) so an `auto`-mode server can
/// self-unlock on future reboots with no phone present: the LUKS key is
/// sealed FOR the box's STK (I1 — no plaintext at `.com`), pinned by the IRK
/// signature (I2). Canonical bytes MUST match `canonicalAutoUnlockLeaseV2`
/// in phoneEndpoint.ts.
public struct AutoUnlockLeaseV2: Equatable, Sendable {
    public static let canonicalTag = "flagship/auto-unlock-lease/v2"

    public var serverDomain: String
    public var stkPub: Data        // 32 bytes — the pinned box STK
    public var leaseId: String     // 16+ hex chars (the revoke handle)
    public var sealedKey: Data     // the LUKS key sealed for stkPub
    public var issuedAt: Int64
    public var expiresAt: Int64
    /// nil ⇒ unbounded until expiresAt (encoded as -1 in canonical bytes).
    public var maxUses: Int?

    public init(
        serverDomain: String, stkPub: Data, leaseId: String, sealedKey: Data,
        issuedAt: Int64, expiresAt: Int64, maxUses: Int? = nil
    ) {
        self.serverDomain = serverDomain
        self.stkPub = stkPub
        self.leaseId = leaseId
        self.sealedKey = sealedKey
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.maxUses = maxUses
    }

    public func canonicalBytes() throws -> Data {
        try PhoneEndpointFieldGuard.check("serverDomain", serverDomain)
        try PhoneEndpointFieldGuard.check("leaseId", leaseId)
        let parts: [String] = [
            AutoUnlockLeaseV2.canonicalTag,
            serverDomain,
            HexUtil.encode(stkPub),
            leaseId,
            HexUtil.encode(sealedKey),
            String(issuedAt),
            String(expiresAt),
            String(maxUses ?? -1),
        ]
        return Data(parts.joined(separator: "|").utf8)
    }

    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }

    /// Build a lease by sealing `luksKey` for the box STK pubkey (so the type
    /// never holds a plaintext key — I1). The caller signs it with the IRK.
    public static func build(
        serverDomain: String, stkPub: Data, leaseId: String, luksKey: Data,
        issuedAt: Int64, expiresAt: Int64, maxUses: Int? = nil
    ) throws -> AutoUnlockLeaseV2 {
        let sealed = try SecretSeal.sealForEd25519Recipient(plaintext: luksKey, recipientEd25519Pub: stkPub)
        return AutoUnlockLeaseV2(
            serverDomain: serverDomain, stkPub: stkPub, leaseId: leaseId,
            sealedKey: sealed, issuedAt: issuedAt, expiresAt: expiresAt, maxUses: maxUses
        )
    }

    /// A random 32-hex-char lease id.
    public static func randomLeaseId() -> String {
        var b = Data(count: 16)
        _ = b.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        return HexUtil.encode(b)
    }
}

/// IRK-signed kill switch — revoking a lease before a reboot downgrades an
/// `auto` server back to phone-gated. Matches `canonicalLeaseRevocation`.
public struct LeaseRevocation: Equatable, Sendable {
    public static let canonicalTag = "flagship/auto-unlock-lease-revoke/v1"

    public var serverDomain: String
    public var leaseId: String
    public var issuedAt: Int64

    public init(serverDomain: String, leaseId: String, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.leaseId = leaseId
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try PhoneEndpointFieldGuard.check("serverDomain", serverDomain)
        try PhoneEndpointFieldGuard.check("leaseId", leaseId)
        return Data([
            LeaseRevocation.canonicalTag, serverDomain, leaseId, String(issuedAt),
        ].joined(separator: "|").utf8)
    }

    public func sign(with irk: Curve25519.Signing.PrivateKey) throws -> Data {
        try irk.signature(for: canonicalBytes())
    }
}

// MARK: - Sealing crypto (Ed25519 recipient → crypto_box_seal)

/// `crypto_box_seal`-equivalent for an Ed25519 recipient pubkey, matching
/// `sealForEd25519Recipient` / `sealForRecipient` in
/// `packages/protocol/src/encryption.ts`:
///
///   1. Convert the recipient's Ed25519 pubkey to its X25519 (Montgomery)
///      pubkey via the standard birational map `u = (1+y)/(1-y)`.
///   2. Mint an ephemeral X25519 keypair; ECDH against the recipient.
///   3. key = HKDF-SHA256(shared, salt = ephPub, info = "flagship.seal.v1").
///   4. AES-256-GCM(key, nonce=12 random) over the plaintext.
///   5. Wire = [ephPub:32][nonce:12][ct+tag].
///
/// The phone only SEALS (the box opens with its STK private key), so we
/// never need the private-key Montgomery map here.
public enum SecretSeal {
    public static let tag = "flagship.seal.v1"

    public enum SealError: Error, Equatable {
        case badRecipientKey
    }

    public static func sealForEd25519Recipient(
        plaintext: Data,
        recipientEd25519Pub: Data
    ) throws -> Data {
        guard recipientEd25519Pub.count == 32 else { throw SealError.badRecipientKey }
        let x25519Pub = try Curve25519Map.edwardsPubToMontgomery(recipientEd25519Pub)
        return try sealForRecipient(plaintext: plaintext, recipientX25519Pub: x25519Pub)
    }

    public static func sealForRecipient(
        plaintext: Data,
        recipientX25519Pub: Data
    ) throws -> Data {
        guard recipientX25519Pub.count == 32 else { throw SealError.badRecipientKey }
        let ephPriv = Curve25519.KeyAgreement.PrivateKey()
        let ephPub = ephPriv.publicKey.rawRepresentation
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: recipientX25519Pub)
        let shared = try ephPriv.sharedSecretFromKeyAgreement(with: peer)
        let key = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: ephPub,
            sharedInfo: Data(tag.utf8),
            outputByteCount: 32
        )
        let sealedBox = try AES.GCM.seal(plaintext, using: key)
        // CryptoKit's `combined` is nonce(12) || ct || tag(16); our wire
        // layout is ephPub(32) || nonce(12) || ct+tag, so `combined`
        // already gives nonce || ct+tag — prefix the ephemeral pubkey.
        guard let combined = sealedBox.combined else { throw SealError.badRecipientKey }
        var out = Data()
        out.append(ephPub)
        out.append(combined)
        return out
    }

    /// Phone-side OPEN of a blob sealed against an Ed25519 recipient
    /// pubkey (e.g. the LUKS key sealed at install time against the phone's
    /// delegated / BAK / IRK Ed25519 pubkey — `sealForRecipient` in
    /// `encryption.ts`). The 32-byte Ed25519 SEED is mapped to its X25519
    /// (Curve25519) scalar via the standard birational map
    /// (`crypto_sign_ed25519_sk_to_curve25519`) before opening — exactly
    /// the move `openSealedFromEd25519Recipient` makes box-side. This is
    /// how the phone reuses its existing key material to recover the LUKS
    /// key: whichever phone Ed25519 key the installer sealed against, the
    /// phone opens it by mapping that key's seed.
    public static func openWithEd25519Seed(
        blob: Data,
        recipientEd25519Seed: Data
    ) throws -> Data {
        guard recipientEd25519Seed.count == 32 else { throw SealError.badRecipientKey }
        let x25519Priv = Curve25519Map.edwardsSeedToMontgomery(recipientEd25519Seed)
        return try openWithX25519(blob: blob, recipientX25519Priv: x25519Priv)
    }

    /// Box-side counterpart (used by tests to prove the round-trip against
    /// a known X25519 private key — the production box opens with its STK
    /// Ed25519 seed, which CryptoKit can't map; that side is the daemon's).
    public static func openWithX25519(
        blob: Data,
        recipientX25519Priv: Data
    ) throws -> Data {
        guard blob.count >= 44 else { throw SealError.badRecipientKey }
        let ephPub = blob.subdata(in: 0..<32)
        let combined = blob.subdata(in: 32..<blob.count) // nonce || ct+tag
        let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: recipientX25519Priv)
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: ephPub)
        let shared = try priv.sharedSecretFromKeyAgreement(with: peer)
        let key = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: ephPub,
            sharedInfo: Data(tag.utf8),
            outputByteCount: 32
        )
        let box = try AES.GCM.SealedBox(combined: combined)
        return try AES.GCM.open(box, using: key)
    }
}

// MARK: - Field guard (mirror of phoneEndpoint.ts fieldGuard)

enum PhoneEndpointFieldGuard {
    enum GuardError: Error, Equatable { case separator(String); case control(String) }

    /// Reject '|' and control chars in a caller-controlled string field so
    /// it can never canonicalize ambiguously. Mirrors phoneEndpoint.ts.
    static func check(_ name: String, _ value: String) throws {
        for scalar in value.unicodeScalars {
            let c = scalar.value
            if c == 0x7c { throw GuardError.separator(name) }
            if c <= 0x1f || c == 0x7f { throw GuardError.control(name) }
        }
    }
}

// MARK: - Ed25519 → X25519 (Montgomery) public-key map

/// Standard Curve25519 birational map for PUBLIC keys:
/// `u = (1 + y) / (1 - y) mod p`, `p = 2^255 - 19`, where `y` is the low
/// 255 bits (little-endian) of the Ed25519 compressed point. Matches
/// noble-curves' `toMontgomery` (`Fp.div(1n + y, 1n - y)`).
public enum Curve25519Map {
    public enum MapError: Error, Equatable { case badInput; case notInvertible }

    public static func edwardsPubToMontgomery(_ edPub: Data) throws -> Data {
        guard edPub.count == 32 else { throw MapError.badInput }
        // Decode y: the 32-byte little-endian value with the top (sign) bit
        // cleared — we only need y for the map, not the x-coordinate.
        var yBytes = [UInt8](edPub)
        yBytes[31] &= 0x7f
        let y = FieldElement(littleEndian: yBytes)
        let one = FieldElement.one
        let num = y.add(one)                 // 1 + y
        let den = one.sub(y)                 // 1 - y
        let denInv = try den.inverse()       // (1 - y)^-1
        let u = num.mul(denInv)
        return Data(u.toLittleEndianBytes())
    }

    /// Ed25519 SEED → X25519 (Montgomery) scalar:
    /// `clamp(SHA512(seed)[0..32])` — libsodium's
    /// `crypto_sign_ed25519_sk_to_curve25519`. Matches noble's
    /// `toMontgomerySecret` (hash → adjustScalarBytes).
    public static func edwardsSeedToMontgomery(_ seed: Data) -> Data {
        var hashed = [UInt8](SHA512.hash(data: seed).prefix(32))
        hashed[0] &= 248
        hashed[31] &= 127
        hashed[31] |= 64
        return Data(hashed)
    }
}

/// Minimal GF(2^255 - 19) field element backed by 256-bit big-endian
/// arithmetic over [UInt32] limbs. Only the operations the public-key
/// Montgomery map needs: add, sub, mul, and inverse (Fermat: x^(p-2)).
/// Deliberately simple (constant-time is not a goal here — the only secret
/// involved is the AEAD path in CryptoKit; the recipient pubkey + the map
/// are public).
struct FieldElement: Equatable {
    // 8 little-endian 32-bit limbs (limb[0] is least significant).
    private var limbs: [UInt32]   // length 8, value < p (not strictly reduced after add)

    private static let pLimbs: [UInt32] = [
        0xffffffed, 0xffffffff, 0xffffffff, 0xffffffff,
        0xffffffff, 0xffffffff, 0xffffffff, 0x7fffffff,
    ]

    static let zero = FieldElement(limbs: [0, 0, 0, 0, 0, 0, 0, 0])
    static let one = FieldElement(limbs: [1, 0, 0, 0, 0, 0, 0, 0])

    private init(limbs: [UInt32]) {
        precondition(limbs.count == 8)
        self.limbs = limbs
    }

    init(littleEndian bytes: [UInt8]) {
        precondition(bytes.count == 32)
        var l = [UInt32](repeating: 0, count: 8)
        for i in 0..<8 {
            l[i] = UInt32(bytes[i * 4])
                | (UInt32(bytes[i * 4 + 1]) << 8)
                | (UInt32(bytes[i * 4 + 2]) << 16)
                | (UInt32(bytes[i * 4 + 3]) << 24)
        }
        self = FieldElement(limbs: l).reduced()
    }

    func toLittleEndianBytes() -> [UInt8] {
        let r = reduced()
        var out = [UInt8](repeating: 0, count: 32)
        for i in 0..<8 {
            out[i * 4] = UInt8(r.limbs[i] & 0xff)
            out[i * 4 + 1] = UInt8((r.limbs[i] >> 8) & 0xff)
            out[i * 4 + 2] = UInt8((r.limbs[i] >> 16) & 0xff)
            out[i * 4 + 3] = UInt8((r.limbs[i] >> 24) & 0xff)
        }
        return out
    }

    // Compare two limb arrays: returns -1, 0, 1.
    private static func cmp(_ a: [UInt32], _ b: [UInt32]) -> Int {
        var i = 7
        while i >= 0 {
            if a[i] < b[i] { return -1 }
            if a[i] > b[i] { return 1 }
            i -= 1
        }
        return 0
    }

    private static func subRaw(_ a: [UInt32], _ b: [UInt32]) -> [UInt32] {
        var out = [UInt32](repeating: 0, count: 8)
        var borrow: UInt64 = 0
        for i in 0..<8 {
            let diff = UInt64(a[i]) &- UInt64(b[i]) &- borrow
            out[i] = UInt32(diff & 0xffffffff)
            borrow = (diff >> 63) & 1
        }
        return out
    }

    private static func addRaw(_ a: [UInt32], _ b: [UInt32]) -> ([UInt32], UInt64) {
        var out = [UInt32](repeating: 0, count: 8)
        var carry: UInt64 = 0
        for i in 0..<8 {
            let s = UInt64(a[i]) + UInt64(b[i]) + carry
            out[i] = UInt32(s & 0xffffffff)
            carry = s >> 32
        }
        return (out, carry)
    }

    func reduced() -> FieldElement {
        var v = limbs
        // Subtract p while v >= p (at most twice for our inputs).
        while FieldElement.cmp(v, FieldElement.pLimbs) >= 0 {
            v = FieldElement.subRaw(v, FieldElement.pLimbs)
        }
        return FieldElement(limbs: v)
    }

    func add(_ other: FieldElement) -> FieldElement {
        let (sum, carry) = FieldElement.addRaw(limbs, other.limbs)
        var v = sum
        if carry != 0 || FieldElement.cmp(v, FieldElement.pLimbs) >= 0 {
            v = FieldElement.subRaw(v, FieldElement.pLimbs)
            if FieldElement.cmp(v, FieldElement.pLimbs) >= 0 {
                v = FieldElement.subRaw(v, FieldElement.pLimbs)
            }
        }
        return FieldElement(limbs: v)
    }

    func sub(_ other: FieldElement) -> FieldElement {
        let a = reduced().limbs
        let b = other.reduced().limbs
        if FieldElement.cmp(a, b) >= 0 {
            return FieldElement(limbs: FieldElement.subRaw(a, b))
        }
        // a < b → a + p - b
        let (sum, _) = FieldElement.addRaw(a, FieldElement.pLimbs)
        return FieldElement(limbs: FieldElement.subRaw(sum, b))
    }

    func mul(_ other: FieldElement) -> FieldElement {
        // Schoolbook 8x8 → 16 limbs, then reduce mod p via 2^255 ≡ 19.
        var product = [UInt64](repeating: 0, count: 16)
        for i in 0..<8 {
            var carry: UInt64 = 0
            let ai = UInt64(limbs[i])
            for j in 0..<8 {
                let cur = product[i + j] + ai * UInt64(other.limbs[j]) + carry
                product[i + j] = cur & 0xffffffff
                carry = cur >> 32
            }
            product[i + 8] += carry
        }
        return FieldElement.reduceWide(product)
    }

    // Reduce a 16-limb (512-bit) value mod p = 2^255 - 19.
    private static func reduceWide(_ wide: [UInt64]) -> FieldElement {
        // Split into low 256 bits (limbs 0..7) and high 256 bits (8..15).
        // 2^256 ≡ 38 (since 2^255 ≡ 19). Fold high*38 into low, twice to
        // settle the carry, then a final conditional subtraction of p.
        var lo = [UInt64](repeating: 0, count: 8)
        var hi = [UInt64](repeating: 0, count: 8)
        for i in 0..<8 { lo[i] = wide[i]; hi[i] = wide[i + 8] }

        func fold(_ low: [UInt64], _ high: [UInt64]) -> ([UInt64], UInt64) {
            var out = [UInt64](repeating: 0, count: 8)
            var carry: UInt64 = 0
            for i in 0..<8 {
                let cur = low[i] + high[i] * 38 + carry
                out[i] = cur & 0xffffffff
                carry = cur >> 32
            }
            return (out, carry)
        }

        var (acc, carry1) = fold(lo, hi)
        // carry1 spills past 2^256 → multiply by 38 and fold once more.
        var spill = [UInt64](repeating: 0, count: 8)
        spill[0] = carry1 * 38
        var carry2: UInt64 = 0
        for i in 0..<8 {
            let cur = acc[i] + spill[i] + carry2
            acc[i] = cur & 0xffffffff
            carry2 = cur >> 32
        }
        // One more tiny fold for any residual carry.
        if carry2 != 0 {
            var c = carry2 * 38
            var i = 0
            while c != 0 && i < 8 {
                let cur = acc[i] + (c & 0xffffffff)
                acc[i] = cur & 0xffffffff
                c = (c >> 32) + (cur >> 32)
                i += 1
            }
        }
        var limbs = [UInt32](repeating: 0, count: 8)
        for i in 0..<8 { limbs[i] = UInt32(acc[i] & 0xffffffff) }
        return FieldElement(limbs: limbs).reduced()
    }

    /// Multiplicative inverse via Fermat's little theorem: x^(p-2) mod p.
    /// p - 2 = 2^255 - 21. Square-and-multiply over the big-endian bits.
    func inverse() throws -> FieldElement {
        let r = reduced()
        if r == FieldElement.zero { throw Curve25519Map.MapError.notInvertible }
        // exponent = p - 2
        let exp = FieldElement.subRaw(FieldElement.pLimbs, [2, 0, 0, 0, 0, 0, 0, 0])
        var result = FieldElement.one
        var base = r
        // Iterate bits LSB→MSB.
        for limb in 0..<8 {
            var bits = exp[limb]
            for _ in 0..<32 {
                if bits & 1 == 1 { result = result.mul(base) }
                base = base.mul(base)
                bits >>= 1
            }
        }
        return result.reduced()
    }
}
