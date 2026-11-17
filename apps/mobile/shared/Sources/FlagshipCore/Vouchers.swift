import CryptoKit
import Foundation

/// The $1 voucher: one RFC 9474 RSABSSA-SHA384-PSS-Randomized blind signature over a random nonce. Swift twin of
/// packages/protocol/src/voucher.ts (and the client half of blindRsa.ts), pinned by test-vectors/vouchers/.
///
///   key       {keyId, nHex, eHex}: nHex the modulus big-endian padded to whole bytes, eHex minimal whole bytes
///   keyId     first 16 hex of SHA-256("flagship/voucher-key/v1|" + nHex + "|" + eHex)
///   message   "flagship/voucher/v1|" (UTF-8) followed by the 32-byte nonce
///   prepared  prefix (32 random bytes) followed by the message
///   voucher   {k, p (hex prefix), n (hex nonce), s (standard base64 PSS signature over `prepared`)}
///   nullifier SHA-256 hex of "flagship/voucher-nullifier/v1|" + k + "|" + n
public struct Voucher: Equatable, Hashable, Sendable, Codable {
    public var k: String
    public var p: String
    public var n: String
    public var s: String
    public init(k: String, p: String, n: String, s: String) { self.k = k; self.p = p; self.n = n; self.s = s }
    public var json: JSONValue { ["k": .string(k), "p": .string(p), "n": .string(n), "s": .string(s)] }
}

public struct VoucherPublicKey: Equatable, Sendable, Codable {
    public var keyId: String
    public var nHex: String
    public var eHex: String
    public init(keyId: String, nHex: String, eHex: String) { self.keyId = keyId; self.nHex = nHex; self.eHex = eHex }
}

/// A blinded request this device keeps until the issuer's signature comes back. `inv` is secret.
public struct PendingVoucher: Equatable, Sendable, Codable {
    public var k: String
    public var p: String
    public var n: String
    public var inv: String
    public init(k: String, p: String, n: String, inv: String) { self.k = k; self.p = p; self.n = n; self.inv = inv }
}

public enum Vouchers {
    public static let tag = "flagship/voucher/v1"
    public static let keyTag = "flagship/voucher-key/v1"
    public static let nullifierTag = "flagship/voucher-nullifier/v1"
    public static let minModulusBits = 2048
    static let hLen = 48
    static let sLen = 48

    struct RsaKey { let n: VoucherBigUInt; let e: VoucherBigUInt; let kLen: Int }

    public static func keyId(nHex: String, eHex: String) -> String {
        String(CanonicalJson.sha256Hex("\(keyTag)|\(nHex)|\(eHex)").prefix(16))
    }

    static func isKeyId(_ s: String) -> Bool { s.utf8.count == 16 && CanonicalJson.isLowerHex(s) }

    /// The RSA numbers of a served key, or nil when its id doesn't match them or it is too small.
    static func rsa(_ k: VoucherPublicKey) -> RsaKey? {
        guard isKeyId(k.keyId), CanonicalJson.isLowerHex(k.nHex), CanonicalJson.isLowerHex(k.eHex), !k.eHex.isEmpty,
              keyId(nHex: k.nHex, eHex: k.eHex) == k.keyId,
              let n = VoucherBigUInt(hex: k.nHex), let e = VoucherBigUInt(hex: k.eHex) else { return nil }
        let kLen = (n.bitLength + 7) / 8
        guard n.bitLength >= minModulusBits, k.nHex.utf8.count == kLen * 2 else { return nil }
        guard e.bitLength >= 2, e.limbs[0] & 1 == 1, !(e < VoucherBigUInt(3)) else { return nil }
        return RsaKey(n: n, e: e, kLen: kLen)
    }

    public static func isUsableKey(_ k: VoucherPublicKey) -> Bool { rsa(k) != nil }

    public static func message(nonce: [UInt8]) -> [UInt8] { Array("\(tag)|".utf8) + nonce }

    static func prepared(p: String, n: String) -> [UInt8]? {
        guard let prefix = try? CanonicalJson.hexToBytes(p), let nonce = try? CanonicalJson.hexToBytes(n), prefix.count == 32, nonce.count == 32 else { return nil }
        return prefix + message(nonce: nonce)
    }

    public static func nullifier(k: String, n: String) -> String { CanonicalJson.sha256Hex("\(nullifierTag)|\(k)|\(n)") }
    public static func nullifier(_ v: Voucher) -> String { nullifier(k: v.k, n: v.n) }

    /// Strict shape of an untrusted voucher (no signature check).
    public static func parse(_ v: JSONValue?) -> Voucher? {
        guard let o = v?.object, Set(o.keys) == ["k", "p", "n", "s"], let k = o["k"]?.string, isKeyId(k),
              CanonicalJson.isLowerHex(o["p"], bytes: 32), CanonicalJson.isLowerHex(o["n"], bytes: 32),
              let s = o["s"]?.string, CanonicalJson.b64Decode(s) != nil else { return nil }
        return Voucher(k: k, p: o["p"]!.string!, n: o["n"]!.string!, s: s)
    }

    // MARK: EMSA-PSS (SHA-384, MGF1-SHA-384, 48-byte salt)

    static func sha384(_ b: [UInt8]) -> [UInt8] { Array(SHA384.hash(data: b)) }

    static func mgf1(_ seed: [UInt8], _ len: Int) -> [UInt8] {
        var out: [UInt8] = []
        var c: UInt32 = 0
        while out.count < len {
            out += sha384(seed + [UInt8(c >> 24 & 255), UInt8(c >> 16 & 255), UInt8(c >> 8 & 255), UInt8(c & 255)])
            c += 1
        }
        return Array(out.prefix(len))
    }

    static func pssEncode(_ msg: [UInt8], emBits: Int, salt: [UInt8]) -> [UInt8]? {
        let emLen = (emBits + 7) / 8
        guard emLen >= hLen + sLen + 2 else { return nil }
        let h = sha384([UInt8](repeating: 0, count: 8) + sha384(msg) + salt)
        var db = [UInt8](repeating: 0, count: emLen - hLen - 1)
        db[emLen - sLen - hLen - 2] = 0x01
        for (i, b) in salt.enumerated() { db[emLen - sLen - hLen - 1 + i] = b }
        let mask = mgf1(h, db.count)
        for i in 0..<db.count { db[i] ^= mask[i] }
        db[0] &= UInt8(0xff >> (8 * emLen - emBits))
        return db + h + [0xbc]
    }

    static func pssVerifyEncoded(_ msg: [UInt8], _ em: [UInt8], emBits: Int) -> Bool {
        let emLen = (emBits + 7) / 8
        guard em.count == emLen, emLen >= hLen + sLen + 2, em[emLen - 1] == 0xbc else { return false }
        let maskedDb = Array(em[0..<(emLen - hLen - 1)])
        let h = Array(em[(emLen - hLen - 1)..<(emLen - 1)])
        let topMask = UInt8(0xff >> (8 * emLen - emBits))
        guard maskedDb[0] & ~topMask == 0 else { return false }
        let mask = mgf1(h, maskedDb.count)
        var db = [UInt8](repeating: 0, count: maskedDb.count)
        for i in 0..<db.count { db[i] = maskedDb[i] ^ mask[i] }
        db[0] &= topMask
        let psLen = emLen - hLen - sLen - 2
        for i in 0..<psLen where db[i] != 0 { return false }
        guard db[psLen] == 0x01 else { return false }
        let salt = Array(db.suffix(sLen))
        let h2 = sha384([UInt8](repeating: 0, count: 8) + sha384(msg) + salt)
        var diff: UInt8 = 0
        for i in 0..<h.count { diff |= h[i] ^ h2[i] }
        return diff == 0
    }

    static func pssVerify(_ key: RsaKey, msg: [UInt8], sig: [UInt8]) -> Bool {
        guard sig.count == key.kLen else { return false }
        let s = VoucherBigUInt(bytes: sig)
        guard s < key.n else { return false }
        let m = s.modPow(key.e, key.n)
        let emBits = key.n.bitLength - 1
        guard let em = m.bytes(count: (emBits + 7) / 8) else { return false }
        return pssVerifyEncoded(msg, em, emBits: emBits)
    }

    static func random(_ n: Int) -> [UInt8] {
        var b = [UInt8](repeating: 0, count: n)
        if SecRandomCopyBytes(kSecRandomDefault, n, &b) != errSecSuccess { b = (0..<n).map { _ in UInt8.random(in: 0...255) } }
        return b
    }

    public struct VoucherError: Error, Equatable { public let reason: String }

    /// One voucher request under `key`: a fresh nonce and prefix, blinded. Send `blinded`; keep `pending`.
    /// The options are for test vectors only.
    public static func newRequest(key: VoucherPublicKey, nonce: [UInt8]? = nil, prefix: [UInt8]? = nil, salt: [UInt8]? = nil,
                                  rHex: String? = nil) throws -> (pending: PendingVoucher, blinded: String) {
        guard let pk = rsa(key) else { throw VoucherError(reason: "bad key") }
        let nonce = nonce ?? random(32), prefix = prefix ?? random(32), salt = salt ?? random(sLen)
        guard nonce.count == 32, prefix.count == 32, salt.count == sLen else { throw VoucherError(reason: "bad input") }
        let prepared = prefix + message(nonce: nonce)
        guard let em = pssEncode(prepared, emBits: pk.n.bitLength - 1, salt: salt) else { throw VoucherError(reason: "modulus too small") }
        let m = VoucherBigUInt(bytes: em)
        guard VoucherBigUInt.gcd(m, pk.n) == .one else { throw VoucherError(reason: "invalid input") }
        var r: VoucherBigUInt
        if let rHex, let given = VoucherBigUInt(hex: rHex) {
            r = given
        } else {
            repeat { r = VoucherBigUInt(bytes: random(pk.kLen)) % pk.n } while r < VoucherBigUInt(2) || VoucherBigUInt.gcd(r, pk.n) != .one
        }
        guard let inv = r.modInverse(pk.n) else { throw VoucherError(reason: "invalid input") }
        let z = (m * r.modPow(pk.e, pk.n)) % pk.n
        guard let zb = z.bytes(count: pk.kLen) else { throw VoucherError(reason: "invalid input") }
        return (PendingVoucher(k: key.keyId, p: CanonicalJson.hex(prefix), n: CanonicalJson.hex(nonce), inv: inv.evenHex),
                CanonicalJson.b64Encode(zb))
    }

    /// Unblind the issuer's answer; throws when it doesn't verify.
    public static func finalize(key: VoucherPublicKey, pending: PendingVoucher, blindSig: String) throws -> Voucher {
        guard let pk = rsa(key), pending.k == key.keyId else { throw VoucherError(reason: "bad key") }
        guard let bs = CanonicalJson.b64Decode(blindSig), bs.count == pk.kLen else { throw VoucherError(reason: "bad blind signature") }
        guard let prepared = prepared(p: pending.p, n: pending.n), let inv = VoucherBigUInt(hex: pending.inv) else { throw VoucherError(reason: "bad pending") }
        let s = (VoucherBigUInt(bytes: bs) * inv) % pk.n
        guard let sig = s.bytes(count: pk.kLen), pssVerify(pk, msg: prepared, sig: sig) else {
            throw VoucherError(reason: "the signer's blind signature doesn't verify")
        }
        return Voucher(k: pending.k, p: pending.p, n: pending.n, s: CanonicalJson.b64Encode(sig))
    }

    public static func verify(key: VoucherPublicKey, voucher v: Voucher) -> Bool {
        guard let pk = rsa(key), v.k == key.keyId, let sig = CanonicalJson.b64Decode(v.s), let prepared = prepared(p: v.p, n: v.n) else { return false }
        return pssVerify(pk, msg: prepared, sig: sig)
    }

    public static func preparedHex(_ v: Voucher) -> String? { prepared(p: v.p, n: v.n).map(CanonicalJson.hex) }
}
