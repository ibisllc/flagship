import Foundation
import CryptoKit
import CFlagshipPQ

/// Architecture v2 hybrid suites, the Swift twin of packages/protocol/src/pqHybrid.ts (and the
/// Rust `flagship-crypto` crate). DRAFT, pending Q01 external cryptographic review.
/// Spec: docs/architecture-v2/pq-suites.md. Shared vectors: test-vectors/pq-hybrid/.
///
/// ML-DSA-65 and ML-KEM-768 come from the vendored mldsa-native / mlkem-native C builds
/// (CFlagshipPQ), on every OS version: CryptoKit's PQ types need iOS 26 and the floor is 18.
/// CryptoKit provides Ed25519, X25519, HKDF-SHA512, SHA-512 and AES-GCM.
public enum PqHybrid {
    public static let suiteHybridSealV1: UInt16 = 0x0001
    public static let suiteHybridSigEd25519MlDsa65V1: UInt16 = 0x0002
    public static let tagHybridSealV1 = "flagship/hybrid-seal/v1"
    public static let tagHybridSigEd25519MlDsa65V1 = "flagship/hybrid-sig/ed25519-mldsa65/v1"
    public static let tagEnvelopeV2 = "flagship/envelope/v2"
    static let tagKeyId = "flagship/pq-key-id/v1"

    public static let envelopeMaxHeaderLen = 1024
    public static let envelopeMaxBodyLen = 1_048_576 + 4096
    public static let sealPublicKeyLen = 1216
    public static let sealSecretKeyLen = 32
    public static let sealEncLen = 1120
    public static let sealTagLen = 16
    public static let sealRandomnessLen = 64
    public static let sealMaxPlaintextLen = 1_048_576
    public static let sealMaxContextFields = 16
    public static let sealMaxContextFieldLen = 1024
    public static let sigPublicKeyLen = 1984
    public static let sigSecretKeyLen = 64
    public static let sigLen = 3373
    public static let sigMaxPayloadLen = 1_048_576
    static let maxSafeInteger: UInt64 = (1 << 53) - 1

    static let mlKemPkLen = 1184
    static let mlKemCtLen = 1088
    static let mlDsaPkLen = 1952
    static let mlDsaSigLen = 3309

    static func suiteTag(_ suite: UInt16) -> String? {
        switch suite {
        case suiteHybridSealV1: return tagHybridSealV1
        case suiteHybridSigEd25519MlDsa65V1: return tagHybridSigEd25519MlDsa65V1
        default: return nil
        }
    }
}

/// A refusal; `code` matches the TS and Rust ports and the vectors' `expect`.
public struct PqHybridError: Error, Equatable, CustomStringConvertible {
    public let code: String
    public init(_ code: String) { self.code = code }
    public var description: String { code }
}

typealias PqBytes = [UInt8]

@inline(__always) private func fail(_ code: String) -> PqHybridError { PqHybridError(code) }

enum PqBin {
    static func utf8(_ s: String) -> PqBytes { Array(s.utf8) }
    static func u16be(_ n: Int) -> PqBytes { [UInt8((n >> 8) & 0xff), UInt8(n & 0xff)] }
    static func u32be(_ n: Int) -> PqBytes { [UInt8((n >> 24) & 0xff), UInt8((n >> 16) & 0xff), UInt8((n >> 8) & 0xff), UInt8(n & 0xff)] }
    static func u64be(_ n: UInt64) -> PqBytes { (0..<8).map { UInt8((n >> (8 * (7 - UInt64($0)))) & 0xff) } }
    static func lp8(_ b: PqBytes) -> PqBytes { [UInt8(b.count & 0xff)] + b }
    static func readU64(_ b: ArraySlice<UInt8>) -> UInt64 { b.reduce(0) { ($0 << 8) | UInt64($1) } }
    static func equal(_ a: PqBytes, _ b: PqBytes) -> Bool {
        guard a.count == b.count else { return false }
        var d: UInt8 = 0
        for i in 0..<a.count { d |= a[i] ^ b[i] }
        return d == 0
    }
    static func random(_ n: Int) -> PqBytes {
        var out = PqBytes(repeating: 0, count: n)
        let rc = SecRandomCopyBytes(kSecRandomDefault, n, &out)
        precondition(rc == errSecSuccess, "SecRandomCopyBytes failed")
        return out
    }
    static func zero(_ b: inout PqBytes) { for i in b.indices { b[i] = 0 } }
    static func hex(_ b: PqBytes) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8](); out.reserveCapacity(b.count * 2)
        for x in b { out.append(digits[Int(x >> 4)]); out.append(digits[Int(x & 15)]) }
        return String(decoding: out, as: UTF8.self)
    }
    /// Lowercase, even-length hex only (the ports' `HEX`), else nil.
    static func unhex(_ s: String) -> PqBytes? {
        let u = Array(s.utf8)
        guard u.count % 2 == 0 else { return nil }
        func v(_ c: UInt8) -> UInt8? {
            switch c {
            case 0x30...0x39: return c - 0x30
            case 0x61...0x66: return c - 0x61 + 10
            default: return nil
            }
        }
        var out = PqBytes(); out.reserveCapacity(u.count / 2)
        var i = 0
        while i < u.count {
            guard let h = v(u[i]), let l = v(u[i + 1]) else { return nil }
            out.append(h << 4 | l); i += 2
        }
        return out
    }
    static func isLowerHex(_ s: String) -> Bool { unhex(s) != nil }
}

// MARK: - Purpose tags (§2.2)

extension PqHybrid {
    /// Purpose-tag grammar; `allowLegacyPb` admits the v1 `pb/...` tags.
    public static func validatePurposeTag(_ tag: String, allowLegacyPb: Bool = false) -> Bool {
        guard !tag.isEmpty, tag.utf16.count <= 128 else { return false }
        let parts = tag.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        let ns = parts[0]
        guard ns == "flagship" || (allowLegacyPb && ns == "pb") else { return false }
        let segments = parts.count - 2
        guard segments >= 1, segments <= 6 else { return false }
        for seg in parts[1..<(parts.count - 1)] {
            let b = Array(seg.utf8)
            guard !b.isEmpty, b.count <= 48, b.count == seg.unicodeScalars.count else { return false }
            func alnum(_ c: UInt8) -> Bool { (0x61...0x7a).contains(c) || (0x30...0x39).contains(c) }
            guard alnum(b[0]), b.allSatisfy({ alnum($0) || $0 == 0x2d }) else { return false }
        }
        let v = Array(parts[parts.count - 1].utf8)
        guard v.count >= 2, v.count <= 5, v[0] == 0x76, (0x31...0x39).contains(v[1]),
              v.dropFirst(2).allSatisfy({ (0x30...0x39).contains($0) }) else { return false }
        return true
    }
}

// MARK: - v2 envelope header (§3)

public struct EnvelopeHeaderV2: Equatable {
    public var purpose: String
    public var suite: UInt16
    public var senderKeyId: [UInt8]
    public var recipientKeyId: [UInt8]?
    public var installationId: [UInt8]?
    public var authorityGeneration: UInt64?
    public var sessionNonce: [UInt8]?
    public var policyDigest: [UInt8]?
    public var issuedAt: UInt64
    public var expiresAt: UInt64?
    public var bodyLen: Int

    public init(purpose: String, suite: UInt16, senderKeyId: [UInt8], recipientKeyId: [UInt8]? = nil,
                installationId: [UInt8]? = nil, authorityGeneration: UInt64? = nil, sessionNonce: [UInt8]? = nil,
                policyDigest: [UInt8]? = nil, issuedAt: UInt64, expiresAt: UInt64? = nil, bodyLen: Int) {
        self.purpose = purpose; self.suite = suite; self.senderKeyId = senderKeyId
        self.recipientKeyId = recipientKeyId; self.installationId = installationId
        self.authorityGeneration = authorityGeneration; self.sessionNonce = sessionNonce
        self.policyDigest = policyDigest; self.issuedAt = issuedAt; self.expiresAt = expiresAt; self.bodyLen = bodyLen
    }
}

private enum T {
    static let purpose: UInt8 = 0x01, suite: UInt8 = 0x02, sender: UInt8 = 0x03, recipient: UInt8 = 0x04
    static let installation: UInt8 = 0x05, generation: UInt8 = 0x06, session: UInt8 = 0x07, policy: UInt8 = 0x08
    static let issued: UInt8 = 0x09, expires: UInt8 = 0x0a, bodyLen: UInt8 = 0x0b
    static let fixedLen: [UInt8: Int] = [suite: 2, sender: 32, recipient: 32, installation: 16, generation: 8,
                                          session: 32, policy: 64, issued: 8, expires: 8, bodyLen: 4]
}

extension PqHybrid {
    static func validateHeader(_ h: EnvelopeHeaderV2) throws {
        let p = PqBin.utf8(h.purpose)
        if p.isEmpty || p.count > 128 { throw fail("header-field-length") }
        if !validatePurposeTag(h.purpose) { throw fail("header-bad-value") }
        let fixed: [([UInt8]?, Int)] = [(h.senderKeyId, 32), (h.recipientKeyId, 32), (h.installationId, 16),
                                        (h.sessionNonce, 32), (h.policyDigest, 64)]
        for (v, n) in fixed where v != nil && v!.count != n { throw fail("header-field-length") }
        if suiteTag(h.suite) == nil { throw fail("header-bad-value") }
        for v in [h.issuedAt, h.expiresAt, h.authorityGeneration] where v != nil && v! > maxSafeInteger {
            throw fail("header-bad-value")
        }
        if let e = h.expiresAt, e <= h.issuedAt { throw fail("header-bad-value") }
        if h.bodyLen < 0 || h.bodyLen > envelopeMaxBodyLen { throw fail("header-bad-value") }
        if h.suite == suiteHybridSealV1 && h.recipientKeyId == nil { throw fail("header-missing-field") }
    }

    public static func encodeEnvelopeHeader(_ h: EnvelopeHeaderV2) throws -> [UInt8] {
        try validateHeader(h)
        var tlv = PqBytes()
        func put(_ ty: UInt8, _ v: PqBytes) { tlv.append(ty); tlv += PqBin.u16be(v.count); tlv += v }
        put(T.purpose, PqBin.utf8(h.purpose))
        put(T.suite, PqBin.u16be(Int(h.suite)))
        put(T.sender, h.senderKeyId)
        if let r = h.recipientKeyId { put(T.recipient, r) }
        if let i = h.installationId { put(T.installation, i) }
        if let g = h.authorityGeneration { put(T.generation, PqBin.u64be(g)) }
        if let s = h.sessionNonce { put(T.session, s) }
        if let p = h.policyDigest { put(T.policy, p) }
        put(T.issued, PqBin.u64be(h.issuedAt))
        if let e = h.expiresAt { put(T.expires, PqBin.u64be(e)) }
        put(T.bodyLen, PqBin.u32be(h.bodyLen))
        let out = PqBin.lp8(PqBin.utf8(tagEnvelopeV2)) + PqBin.u16be(tlv.count) + tlv
        if out.count > envelopeMaxHeaderLen { throw fail("header-too-large") }
        return out
    }

    /// Decodes a header at the start of `bytes`; check order as in §3.3.
    public static func decodeEnvelopeHeader(_ bytes: [UInt8]) throws -> (header: EnvelopeHeaderV2, length: Int) {
        let magic = PqBin.lp8(PqBin.utf8(tagEnvelopeV2))
        if bytes.count < magic.count { throw fail("header-truncated") }
        if Array(bytes[0..<magic.count]) != magic { throw fail("header-bad-magic") }
        if bytes.count < magic.count + 2 { throw fail("header-truncated") }
        let tlvLen = Int(bytes[magic.count]) << 8 | Int(bytes[magic.count + 1])
        let total = magic.count + 2 + tlvLen
        if total > envelopeMaxHeaderLen { throw fail("header-too-large") }
        if bytes.count < total { throw fail("header-truncated") }
        let tlv = Array(bytes[(magic.count + 2)..<total])

        var f: [UInt8: PqBytes] = [:]
        var purpose: String?
        var prev: UInt8 = 0
        var o = 0
        while o < tlv.count {
            if o + 3 > tlv.count { throw fail("header-truncated") }
            let ty = tlv[o]
            let len = Int(tlv[o + 1]) << 8 | Int(tlv[o + 2])
            o += 3
            if o + len > tlv.count { throw fail("header-truncated") }
            let value = Array(tlv[o..<(o + len)])
            o += len
            if ty < T.purpose || ty > T.bodyLen { throw fail("header-unknown-field") }
            if ty == prev { throw fail("header-duplicate-field") }
            if ty < prev { throw fail("header-field-order") }
            prev = ty
            if ty == T.purpose {
                if len == 0 || len > 128 { throw fail("header-field-length") }
                guard let s = String(validating: value, as: UTF8.self) else { throw fail("header-bad-value") }
                purpose = s
            } else if len != T.fixedLen[ty] {
                throw fail("header-field-length")
            }
            if ty == T.suite && suiteTag(UInt16(value[0]) << 8 | UInt16(value[1])) == nil { throw fail("header-bad-value") }
            f[ty] = value
        }
        guard let purpose else { throw fail("header-missing-field") }
        guard let suiteB = f[T.suite], let sender = f[T.sender], let issued = f[T.issued], let bodyLenB = f[T.bodyLen] else {
            throw fail("header-missing-field")
        }
        var header = EnvelopeHeaderV2(
            purpose: purpose, suite: UInt16(suiteB[0]) << 8 | UInt16(suiteB[1]), senderKeyId: sender,
            issuedAt: PqBin.readU64(issued[...]), bodyLen: Int(PqBin.readU64(bodyLenB[...])))
        header.recipientKeyId = f[T.recipient]
        header.installationId = f[T.installation]
        if let g = f[T.generation] { header.authorityGeneration = PqBin.readU64(g[...]) }
        header.sessionNonce = f[T.session]
        header.policyDigest = f[T.policy]
        if let e = f[T.expires] { header.expiresAt = PqBin.readU64(e[...]) }
        try validateHeader(header)
        if try encodeEnvelopeHeader(header) != Array(bytes[0..<total]) { throw fail("header-bad-value") }
        return (header, total)
    }

    /// Decodes `header || body`; the body must be exactly `bodyLen` bytes.
    public static func decodeEnvelope(_ bytes: [UInt8]) throws -> (header: EnvelopeHeaderV2, headerBytes: [UInt8], body: [UInt8]) {
        let (header, length) = try decodeEnvelopeHeader(bytes)
        let body = Array(bytes[length...])
        if body.count != header.bodyLen { throw fail("body-length") }
        return (header, Array(bytes[0..<length]), body)
    }

    // MARK: Key ids (§2.3)

    public static func pqKeyId(suite: UInt16, publicKey: [UInt8]) -> [UInt8] {
        let input = PqBin.lp8(PqBin.utf8(tagKeyId)) + PqBin.u16be(Int(suite)) + PqBin.u16be(publicKey.count) + publicKey
        return Array(Array(SHA512.hash(data: input)).prefix(32))
    }
}

// MARK: - Primitives

enum PqPrim {
    static func sha3_256(_ data: PqBytes) -> PqBytes {
        var out = PqBytes(repeating: 0, count: 32)
        data.withUnsafeBufferPointer { fl_sha3_256(&out, $0.baseAddress, $0.count) }
        return out
    }

    static func shake256(_ data: PqBytes, _ n: Int) -> PqBytes {
        var out = PqBytes(repeating: 0, count: n)
        data.withUnsafeBufferPointer { fl_shake256(&out, n, $0.baseAddress, $0.count) }
        return out
    }

    /// X25519(k, u); nil when CryptoKit refuses or the result is all zero (a small-order u).
    static func x25519(_ k: PqBytes, _ u: PqBytes) -> PqBytes? {
        guard let sk = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: k),
              let pk = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: u),
              let ss = try? sk.sharedSecretFromKeyAgreement(with: pk) else { return nil }
        let out = ss.withUnsafeBytes { PqBytes($0) }
        return out.allSatisfy({ $0 == 0 }) ? nil : out
    }

    static func x25519Base(_ k: PqBytes) -> PqBytes? {
        guard let sk = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: k) else { return nil }
        return PqBytes(sk.publicKey.rawRepresentation)
    }

    static func edPoint(_ b: ArraySlice<UInt8>) -> Bool {
        guard b.count == 32 else { return false }
        return Array(b).withUnsafeBufferPointer { fl_ed25519_point_strict($0.baseAddress) } == 1
    }

    static func mldsaKeypair(_ seed: PqBytes) -> (pk: PqBytes, sk: PqBytes)? {
        guard seed.count == 32 else { return nil }
        var pk = PqBytes(repeating: 0, count: Int(FL_MLDSA65_PUBLICKEYBYTES))
        var sk = PqBytes(repeating: 0, count: Int(FL_MLDSA65_SECRETKEYBYTES))
        guard fl_mldsa65_keypair(&pk, &sk, seed) == 0 else { return nil }
        return (pk, sk)
    }

    static func mldsaSign(_ sk: PqBytes, _ m: PqBytes, ctx: PqBytes, rnd: PqBytes) -> PqBytes? {
        var sig = PqBytes(repeating: 0, count: Int(FL_MLDSA65_BYTES))
        let rc = m.withUnsafeBufferPointer { mp in
            ctx.withUnsafeBufferPointer { cp in
                fl_mldsa65_sign(&sig, mp.baseAddress, mp.count, cp.baseAddress, cp.count, rnd, sk)
            }
        }
        return rc == 0 ? sig : nil
    }

    static func mldsaVerify(_ pk: PqBytes, _ m: PqBytes, ctx: PqBytes, sig: PqBytes) -> Bool {
        guard pk.count == PqHybrid.mlDsaPkLen else { return false }
        return sig.withUnsafeBufferPointer { sp in
            m.withUnsafeBufferPointer { mp in
                ctx.withUnsafeBufferPointer { cp in
                    fl_mldsa65_verify(sp.baseAddress, sp.count, mp.baseAddress, mp.count, cp.baseAddress, cp.count, pk) == 0
                }
            }
        }
    }

    // X-Wing (draft-connolly-cfrg-xwing-kem-11).
    static let xwingLabel: PqBytes = [0x5c, 0x2e, 0x2f, 0x2f, 0x5e, 0x5c]

    static func xwingExpand(_ seed: PqBytes) -> (pkM: PqBytes, skM: PqBytes, skX: PqBytes)? {
        var expanded = shake256(seed, 96)
        defer { PqBin.zero(&expanded) }
        var pk = PqBytes(repeating: 0, count: Int(FL_MLKEM768_PUBLICKEYBYTES))
        var sk = PqBytes(repeating: 0, count: Int(FL_MLKEM768_SECRETKEYBYTES))
        let coins = Array(expanded[0..<64])
        guard fl_mlkem768_keypair_derand(&pk, &sk, coins) == 0 else { return nil }
        return (pk, sk, Array(expanded[64..<96]))
    }

    static func xwingPublicKey(_ seed: PqBytes) -> PqBytes? {
        guard let k = xwingExpand(seed), let pkX = x25519Base(k.skX) else { return nil }
        return k.pkM + pkX
    }

    static func xwingEncapsulate(_ pk: PqBytes, _ eseed: PqBytes) -> (ct: PqBytes, ss: PqBytes)? {
        let pkM = Array(pk[0..<PqHybrid.mlKemPkLen]), pkX = Array(pk[PqHybrid.mlKemPkLen...])
        var ctM = PqBytes(repeating: 0, count: Int(FL_MLKEM768_CIPHERTEXTBYTES))
        var ssM = PqBytes(repeating: 0, count: 32)
        defer { PqBin.zero(&ssM) }
        guard fl_mlkem768_enc_derand(&ctM, &ssM, pkM, Array(eseed[0..<32])) == 0 else { return nil }
        let ekX = Array(eseed[32..<64])
        guard let ctX = x25519Base(ekX), var ssX = x25519(ekX, pkX) else { return nil }
        defer { PqBin.zero(&ssX) }
        return (ctM + ctX, sha3_256(ssM + ssX + ctX + pkX + xwingLabel))
    }

    static func xwingDecapsulate(_ ct: PqBytes, _ seed: PqBytes) -> PqBytes? {
        guard var k = xwingExpand(seed), let pkX = x25519Base(k.skX) else { return nil }
        defer { PqBin.zero(&k.skM); PqBin.zero(&k.skX) }
        let ctM = Array(ct[0..<PqHybrid.mlKemCtLen]), ctX = Array(ct[PqHybrid.mlKemCtLen...])
        var ssM = PqBytes(repeating: 0, count: 32)
        defer { PqBin.zero(&ssM) }
        guard fl_mlkem768_dec(&ssM, ctM, k.skM) == 0, var ssX = x25519(k.skX, ctX) else { return nil }
        defer { PqBin.zero(&ssX) }
        return sha3_256(ssM + ssX + ctX + pkX + xwingLabel)
    }
}

// MARK: - flagship/hybrid-seal/v1 (§4)

public struct HybridSealOptions {
    public var purpose: String
    public var senderKeyId: [UInt8]
    public var issuedAt: UInt64
    public var expiresAt: UInt64?
    public var installationId: [UInt8]?
    public var authorityGeneration: UInt64?
    public var sessionNonce: [UInt8]?
    public var policyDigest: [UInt8]?

    public init(purpose: String, senderKeyId: [UInt8], issuedAt: UInt64, expiresAt: UInt64? = nil,
                installationId: [UInt8]? = nil, authorityGeneration: UInt64? = nil,
                sessionNonce: [UInt8]? = nil, policyDigest: [UInt8]? = nil) {
        self.purpose = purpose; self.senderKeyId = senderKeyId; self.issuedAt = issuedAt; self.expiresAt = expiresAt
        self.installationId = installationId; self.authorityGeneration = authorityGeneration
        self.sessionNonce = sessionNonce; self.policyDigest = policyDigest
    }
}

extension PqHybrid {
    private static let x25519Probe = PqBytes(repeating: 0x5a, count: 32)

    // FIPS 203 §7.2 modulus check: every 12-bit coefficient of t̂ is below q.
    static func mlKemModulusOk(_ ek: ArraySlice<UInt8>) -> Bool {
        let e = Array(ek)
        var i = 0
        while i < 1152 {
            let b0 = Int(e[i]), b1 = Int(e[i + 1]), b2 = Int(e[i + 2])
            if (b0 | ((b1 & 0x0f) << 8)) >= 3329 { return false }
            if ((b1 >> 4) | (b2 << 4)) >= 3329 { return false }
            i += 3
        }
        return true
    }

    /// Validates an X-Wing encapsulation key (length, ML-KEM modulus, X25519 not small order).
    @discardableResult
    public static func parseHybridSealPublicKey(_ pk: [UInt8]) throws -> [UInt8] {
        if pk.count != sealPublicKeyLen { throw fail("bad-public-key") }
        if !mlKemModulusOk(pk[0..<mlKemPkLen]) { throw fail("bad-public-key") }
        if PqPrim.x25519(x25519Probe, Array(pk[mlKemPkLen...])) == nil { throw fail("bad-public-key") }
        return pk
    }

    public static func hybridSealKeygen(seed: [UInt8]) throws -> (publicKey: [UInt8], secretKey: [UInt8]) {
        if seed.count != sealSecretKeyLen { throw fail("bad-secret-key") }
        guard let pk = PqPrim.xwingPublicKey(seed) else { throw fail("bad-secret-key") }
        return (try parseHybridSealPublicKey(pk), seed)
    }

    static func checkSealInputs(_ purpose: String, _ context: [[UInt8]]) throws {
        if !validatePurposeTag(purpose) { throw fail("bad-purpose") }
        if context.count > sealMaxContextFields || context.contains(where: { $0.count > sealMaxContextFieldLen }) {
            throw fail("context-too-large")
        }
    }

    /// The HKDF `info` (§4.3). Exported for the vectors.
    public static func hybridSealKdfInfo(headerBytes: [UInt8], header: EnvelopeHeaderV2, context: [[UInt8]], enc: [UInt8]) -> [UInt8] {
        var ctx: PqBytes = [UInt8(context.count & 0xff)]
        for c in context { ctx += PqBin.u16be(c.count) + c }
        return PqBin.lp8(PqBin.utf8(tagHybridSealV1)) + PqBin.u16be(Int(suiteHybridSealV1))
            + PqBin.lp8(PqBin.utf8(header.purpose)) + header.senderKeyId
            + (header.recipientKeyId ?? PqBytes(repeating: 0, count: 32))
            + PqBin.u32be(headerBytes.count) + headerBytes + ctx + enc
    }

    static func deriveSealKeys(_ ss: PqBytes, _ info: PqBytes) -> (key: SymmetricKey, nonce: AES.GCM.Nonce) {
        let okm = HKDF<SHA512>.deriveKey(inputKeyMaterial: SymmetricKey(data: ss), salt: PqBin.utf8(tagHybridSealV1),
                                         info: info, outputByteCount: 44)
        let bytes = okm.withUnsafeBytes { PqBytes($0) }
        return (SymmetricKey(data: bytes[0..<32]), try! AES.GCM.Nonce(data: bytes[32..<44]))
    }

    /// Seal with caller-supplied encapsulation randomness (ML-KEM coins, then the X25519
    /// ephemeral secret). For vectors only: reusing `eseed` reuses the AES key and nonce.
    public static func hybridSealWithRandomness(recipientPublicKey: [UInt8], options opts: HybridSealOptions,
                                                context: [[UInt8]], plaintext: [UInt8], eseed: [UInt8]) throws -> [UInt8] {
        let pk = try parseHybridSealPublicKey(recipientPublicKey)
        try checkSealInputs(opts.purpose, context)
        if plaintext.count > sealMaxPlaintextLen { throw fail("plaintext-too-large") }
        if eseed.count != sealRandomnessLen { throw fail("randomness") }
        let header = EnvelopeHeaderV2(
            purpose: opts.purpose, suite: suiteHybridSealV1, senderKeyId: opts.senderKeyId,
            recipientKeyId: pqKeyId(suite: suiteHybridSealV1, publicKey: pk), installationId: opts.installationId,
            authorityGeneration: opts.authorityGeneration, sessionNonce: opts.sessionNonce, policyDigest: opts.policyDigest,
            issuedAt: opts.issuedAt, expiresAt: opts.expiresAt, bodyLen: sealEncLen + plaintext.count + sealTagLen)
        let headerBytes = try encodeEnvelopeHeader(header)
        guard var kem = PqPrim.xwingEncapsulate(pk, eseed) else { throw fail("bad-public-key") }
        defer { PqBin.zero(&kem.ss) }
        let (key, nonce) = deriveSealKeys(kem.ss, hybridSealKdfInfo(headerBytes: headerBytes, header: header, context: context, enc: kem.ct))
        let box = try AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: headerBytes + kem.ct)
        return headerBytes + kem.ct + PqBytes(box.ciphertext) + PqBytes(box.tag)
    }

    public static func hybridSeal(recipientPublicKey: [UInt8], options: HybridSealOptions,
                                  context: [[UInt8]], plaintext: [UInt8]) throws -> [UInt8] {
        var eseed = PqBin.random(sealRandomnessLen)
        defer { PqBin.zero(&eseed) }
        return try hybridSealWithRandomness(recipientPublicKey: recipientPublicKey, options: options,
                                            context: context, plaintext: plaintext, eseed: eseed)
    }

    /// Opens a seal; every failure past the header checks is `decrypt-failed`.
    public static func hybridOpen(recipientSecretKey: [UInt8], expectedPurpose: String,
                                  context: [[UInt8]], sealed: [UInt8]) throws -> (header: EnvelopeHeaderV2, plaintext: [UInt8]) {
        try checkSealInputs(expectedPurpose, context)
        let (publicKey, _) = try hybridSealKeygen(seed: recipientSecretKey)
        let (header, headerBytes, body) = try decodeEnvelope(sealed)
        if header.suite != suiteHybridSealV1 { throw fail("suite-mismatch") }
        if header.purpose != expectedPurpose { throw fail("purpose-mismatch") }
        let myId = pqKeyId(suite: suiteHybridSealV1, publicKey: publicKey)
        guard let rid = header.recipientKeyId, PqBin.equal(rid, myId) else { throw fail("recipient-mismatch") }
        if body.count < sealEncLen + sealTagLen { throw fail("body-length") }
        if body.count - sealEncLen - sealTagLen > sealMaxPlaintextLen { throw fail("plaintext-too-large") }
        let enc = Array(body[0..<sealEncLen])
        guard var ss = PqPrim.xwingDecapsulate(enc, recipientSecretKey) else { throw fail("decrypt-failed") }
        defer { PqBin.zero(&ss) }
        let (key, nonce) = deriveSealKeys(ss, hybridSealKdfInfo(headerBytes: headerBytes, header: header, context: context, enc: enc))
        let ct = body[sealEncLen..<(body.count - sealTagLen)], tag = body[(body.count - sealTagLen)...]
        do {
            let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ct, tag: tag)
            let plaintext = try AES.GCM.open(box, using: key, authenticating: headerBytes + enc)
            return (header, PqBytes(plaintext))
        } catch {
            throw fail("decrypt-failed")
        }
    }
}

// MARK: - flagship/hybrid-sig/ed25519-mldsa65/v1 (§5)

extension PqHybrid {
    /// Strict-profile Ed25519 (§5.3): the key and R canonical, torsion-free, not the identity.
    public static func ed25519VerifyStrict(signature sig: [UInt8], message msg: [UInt8], publicKey pk: [UInt8]) -> Bool {
        sig.count == 64 && pk.count == 32 && PqPrim.edPoint(pk[...]) && edVerifyStrict(sig, msg, pk)
    }

    static func edVerifyStrict(_ sig: PqBytes, _ msg: PqBytes, _ pk: PqBytes) -> Bool {
        guard sig.count == 64, PqPrim.edPoint(sig[0..<32]),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: pk) else { return false }
        return key.isValidSignature(sig, for: msg)
    }

    @discardableResult
    public static func parseHybridSigPublicKey(_ pk: [UInt8]) throws -> [UInt8] {
        if pk.count != sigPublicKeyLen { throw fail("bad-public-key") }
        if !PqPrim.edPoint(pk[0..<32]) { throw fail("bad-public-key") }
        return pk
    }

    /// Secret key = Ed25519 seed (32) || ML-DSA-65 KeyGen_internal seed (32), independent.
    public static func hybridSigKeygen(edSeed: [UInt8], mldsaSeed: [UInt8]) throws -> (publicKey: [UInt8], secretKey: [UInt8]) {
        if edSeed.count != 32 || mldsaSeed.count != 32 { throw fail("bad-secret-key") }
        guard let ed = try? Curve25519.Signing.PrivateKey(rawRepresentation: edSeed),
              var ml = PqPrim.mldsaKeypair(mldsaSeed) else { throw fail("bad-secret-key") }
        PqBin.zero(&ml.sk)
        let publicKey = PqBytes(ed.publicKey.rawRepresentation) + ml.pk
        do { try parseHybridSigPublicKey(publicKey) } catch { throw fail("bad-secret-key") }
        return (publicKey, edSeed + mldsaSeed)
    }

    /// The signed message representative M' (§5.2).
    public static func hybridSigMessage(publicKey: [UInt8], purpose: String, payload: [UInt8]) throws -> [UInt8] {
        if !validatePurposeTag(purpose) { throw fail("bad-purpose") }
        if payload.count > sigMaxPayloadLen { throw fail("payload-too-large") }
        return PqBin.lp8(PqBin.utf8(tagHybridSigEd25519MlDsa65V1)) + PqBin.u16be(Int(suiteHybridSigEd25519MlDsa65V1))
            + publicKey + PqBin.lp8(PqBin.utf8(purpose)) + PqBin.u32be(payload.count) + payload
    }

    /// ML-DSA-65 over M' with the suite's context; `deterministic` uses rnd = 0^32 (vectors).
    static func mldsaSignMessage(mldsaSeed: PqBytes, m: PqBytes, deterministic: Bool) throws -> PqBytes {
        guard var ml = PqPrim.mldsaKeypair(mldsaSeed) else { throw fail("bad-secret-key") }
        defer { PqBin.zero(&ml.sk) }
        let rnd = deterministic ? PqBytes(repeating: 0, count: 32) : PqBin.random(32)
        guard let sig = PqPrim.mldsaSign(ml.sk, m, ctx: PqBin.utf8(tagHybridSigEd25519MlDsa65V1), rnd: rnd) else {
            throw fail("bad-secret-key")
        }
        return sig
    }

    /// Signs; `deterministic` makes the ML-DSA half deterministic. CryptoKit's Ed25519 half is
    /// hedged, so the bytes differ from the TS vectors there while still verifying.
    public static func hybridSign(secretKey: [UInt8], purpose: String, payload: [UInt8], deterministic: Bool = false) throws -> [UInt8] {
        if secretKey.count != sigSecretKeyLen { throw fail("bad-secret-key") }
        let edSeed = Array(secretKey[0..<32]), mldsaSeed = Array(secretKey[32..<64])
        let (publicKey, _) = try hybridSigKeygen(edSeed: edSeed, mldsaSeed: mldsaSeed)
        let m = try hybridSigMessage(publicKey: publicKey, purpose: purpose, payload: payload)
        let mlSig = try mldsaSignMessage(mldsaSeed: mldsaSeed, m: m, deterministic: deterministic)
        guard let ed = try? Curve25519.Signing.PrivateKey(rawRepresentation: edSeed),
              let edSig = try? ed.signature(for: m) else { throw fail("bad-secret-key") }
        return PqBytes(edSig) + mlSig
    }

    /// Throws unless BOTH components verify over M'.
    public static func hybridVerify(publicKey: [UInt8], purpose: String, payload: [UInt8], signature: [UInt8]) throws {
        try parseHybridSigPublicKey(publicKey)
        let m = try hybridSigMessage(publicKey: publicKey, purpose: purpose, payload: payload)
        if signature.count != sigLen { throw fail("bad-signature") }
        let edOk = edVerifyStrict(Array(signature[0..<64]), m, Array(publicKey[0..<32]))
        let mlOk = PqPrim.mldsaVerify(Array(publicKey[32...]), m, ctx: PqBin.utf8(tagHybridSigEd25519MlDsa65V1),
                                       sig: Array(signature[64...]))
        if !(edOk && mlOk) { throw fail("bad-signature") }
    }
}

// MARK: - Signers whose halves live apart

extension PqHybrid {
    /// The ML-DSA-65 public key for a 32-byte KeyGen_internal seed.
    public static func mldsa65PublicKey(seed: [UInt8]) throws -> [UInt8] {
        guard var kp = PqPrim.mldsaKeypair(seed) else { throw fail("bad-secret-key") }
        PqBin.zero(&kp.sk)
        return kp.pk
    }

    /// Hedged ML-DSA-65 over `message` with `context`, from a software seed.
    public static func mldsa65Sign(seed: [UInt8], message: [UInt8], context: [UInt8]) throws -> [UInt8] {
        guard var kp = PqPrim.mldsaKeypair(seed) else { throw fail("bad-secret-key") }
        defer { PqBin.zero(&kp.sk) }
        guard let sig = PqPrim.mldsaSign(kp.sk, message, ctx: context, rnd: PqBin.random(32)) else { throw fail("bad-secret-key") }
        return sig
    }

    public static func randomSeed() -> [UInt8] { PqBin.random(32) }

    /// The hybrid signature when the two halves are held apart (an Ed25519 identity key and an
    /// ML-DSA key in the Secure Enclave or a wrapped seed): both sign the same M' (§5.2), and
    /// the result is checked before it is returned.
    public static func hybridSign(edPublicKey: [UInt8], mldsaPublicKey: [UInt8], purpose: String, payload: [UInt8],
                                  edSign: ([UInt8]) throws -> [UInt8],
                                  mldsaSign: (_ message: [UInt8], _ context: [UInt8]) throws -> [UInt8]) throws -> [UInt8] {
        let pk = edPublicKey + mldsaPublicKey
        try parseHybridSigPublicKey(pk)
        let m = try hybridSigMessage(publicKey: pk, purpose: purpose, payload: payload)
        let sig = try edSign(m) + mldsaSign(m, PqBin.utf8(tagHybridSigEd25519MlDsa65V1))
        try hybridVerify(publicKey: pk, purpose: purpose, payload: payload, signature: sig)
        return sig
    }
}
