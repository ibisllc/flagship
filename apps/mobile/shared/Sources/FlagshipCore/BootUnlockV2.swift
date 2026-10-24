import CryptoKit
import Foundation

/// Boot unlock v2, the phone side (packages/protocol/src/bootUnlockV2.ts,
/// docs/architecture-v2/pq-suites.md §19): verify a box's v2 boot material under the STK's
/// verified hybrid binding, verify a v2 request under the boot key's hybrid key, and seal the
/// disk key to the request's per-boot reply key (or a v3 lease to the box's lease key) with
/// `flagship/hybrid-seal/v1`, signed with the owner's hybrid key. Codes match the TS port and
/// test-vectors/boot-unlock-v2/vectors.json.
public enum BootUnlockV2 {
    public static let tagBootKeyBindingV3 = "flagship/boot-key-binding/v3"
    public static let tagSecretRequestV2 = "flagship/secret-request/v2"
    public static let tagBootReplyV2 = "flagship/boot-reply/v2"
    public static let tagAutoUnlockLeaseV3 = "flagship/auto-unlock-lease/v3"

    public struct Failure: Error, Equatable, CustomStringConvertible {
        public let code: String
        public var description: String { code }
    }

    static func fail(_ code: String) -> Failure { Failure(code: code) }

    /// What a verified box's v2 material gives the phone.
    public struct Material: Equatable, Sendable {
        public let serverDomain: String
        public let bootPubHex: String
        public let bootHybridPublicKey: [UInt8]
        public let leaseKemPublicKey: [UInt8]
        public let custody: String
        public let issuedAt: Int64
    }

    static func isHex(_ s: String, bytes: Int) -> Bool {
        s.utf8.count == bytes * 2 && s.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }

    static func domainOk(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard let f = u.first, u.count <= 253, (0x61...0x7a).contains(f) || (0x30...0x39).contains(f) else { return false }
        return u.allSatisfy { (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2e || $0 == 0x2d }
    }

    public static func hybridKeyIdHex(_ pk: [UInt8]) -> String { PqBin.hex(PqHybrid.pqKeyId(suite: PqHybrid.suiteHybridSigEd25519MlDsa65V1, publicKey: pk)) }
    public static func kemKeyIdHex(_ pk: [UInt8]) -> String { PqBin.hex(PqHybrid.pqKeyId(suite: PqHybrid.suiteHybridSealV1, publicKey: pk)) }

    /// `flagship/boot-key-binding/v3|<domain>|<bootPub>|<bootHybridKeyId>|<leaseKemKeyId>|<custody>|<issuedAt>`.
    public static func canonicalBootKeyBindingV3(serverDomain: String, bootPubHex: String, bootMldsaPubHex: String,
                                                 leaseKemPubHex: String, custody: String, issuedAt: Int64) throws -> [UInt8] {
        guard let hk = PqBin.unhex(bootPubHex + bootMldsaPubHex), let kem = PqBin.unhex(leaseKemPubHex) else { throw fail("v2-malformed") }
        return PqBin.utf8([tagBootKeyBindingV3, serverDomain, bootPubHex, hybridKeyIdHex(hk), kemKeyIdHex(kem), custody, String(issuedAt)].joined(separator: "|"))
    }

    /// Verifies the `pq` object `.com` serves beside the boot-key binding. `bootPubHex` is the boot
    /// key the phone verified through its pinned STK; `stkBinding` the STK's verified binding.
    public static func verifyMaterial(_ wire: Any?, serverDomain: String, bootPubHex: String,
                                      stkBinding: VerifiedPqKeyBinding, now: Int64,
                                      pinnedBootMldsaPubHex: String? = nil) throws -> Material {
        guard let o = wire as? [String: Any],
              Set(o.keys) == ["bootBinding", "bootMldsaPubHex", "bootPubHex", "custody", "issuedAt", "leaseKemPubHex", "serverDomain", "stkSignature", "v"],
              (o["v"] as? NSNumber)?.intValue == 1,
              let domain = o["serverDomain"] as? String, domainOk(domain),
              let boot = o["bootPubHex"] as? String, isHex(boot, bytes: 32),
              let mldsa = o["bootMldsaPubHex"] as? String, isHex(mldsa, bytes: 1952),
              let kemHex = o["leaseKemPubHex"] as? String, isHex(kemHex, bytes: 1216),
              let custody = o["custody"] as? String, custody == "software" || custody == "tpm",
              let at = (o["issuedAt"] as? NSNumber)?.int64Value, at >= 0,
              let sigHex = o["stkSignature"] as? String, isHex(sigHex, bytes: PqHybrid.sigLen)
        else { throw fail("v2-malformed") }
        if domain != serverDomain.lowercased() || boot != bootPubHex.lowercased() { throw fail("material-boot-key") }
        if stkBinding.role != "box-stk" || stkBinding.subjectId != domain { throw fail("material-signature") }
        let bootBinding: VerifiedPqKeyBinding
        do {
            bootBinding = try PqTrust.verifyPqKeyBinding(o["bootBinding"], PqBindingExpectation(
                role: "boot-key", subjectId: domain, ed25519PubHex: boot, mldsaPubHex: pinnedBootMldsaPubHex ?? mldsa, now: now))
        } catch { throw fail("material-binding") }
        if bootBinding.mldsaPubHex != mldsa { throw fail("material-binding") }
        let kem = PqBin.unhex(kemHex)!
        do { try PqHybrid.parseHybridSealPublicKey(kem) } catch { throw fail("v2-malformed") }
        let statement = try canonicalBootKeyBindingV3(serverDomain: domain, bootPubHex: boot, bootMldsaPubHex: mldsa,
                                                      leaseKemPubHex: kemHex, custody: custody, issuedAt: at)
        do {
            try PqHybrid.hybridVerify(publicKey: stkBinding.hybridPublicKey, purpose: tagBootKeyBindingV3, payload: statement, signature: PqBin.unhex(sigHex)!)
        } catch { throw fail("material-signature") }
        return Material(serverDomain: domain, bootPubHex: boot, bootHybridPublicKey: bootBinding.hybridPublicKey,
                        leaseKemPublicKey: kem, custody: custody, issuedAt: at)
    }

    /// Verifies a v2 request's `pq` extension; returns the per-boot reply key.
    public static func verifyRequest(serverDomain: String, bootPubHex: String, purpose: String, nonceHex: String,
                                     issuedAt: Int64, pq: Any?, material: Material) throws -> [UInt8] {
        guard let p = pq as? [String: Any], Set(p.keys) == ["replyKemPubHex", "signature", "v"],
              (p["v"] as? NSNumber)?.intValue == 2,
              let kemHex = (p["replyKemPubHex"] as? String)?.lowercased(), isHex(kemHex, bytes: 1216),
              let sigHex = (p["signature"] as? String)?.lowercased(), isHex(sigHex, bytes: PqHybrid.sigLen)
        else { throw fail("v2-malformed") }
        if serverDomain.lowercased() != material.serverDomain || bootPubHex.lowercased() != material.bootPubHex { throw fail("other-server") }
        let nonce = nonceHex.lowercased()
        guard purpose == "unlock-key", isHex(nonce, bytes: 32) else { throw fail("v2-malformed") }
        let kem = PqBin.unhex(kemHex)!
        do { try PqHybrid.parseHybridSealPublicKey(kem) } catch { throw fail("v2-malformed") }
        let statement = PqBin.utf8([tagSecretRequestV2, material.serverDomain, material.bootPubHex, "unlock-key", nonce, kemKeyIdHex(kem), String(issuedAt)].joined(separator: "|"))
        do {
            try PqHybrid.hybridVerify(publicKey: material.bootHybridPublicKey, purpose: tagSecretRequestV2, payload: statement, signature: PqBin.unhex(sigHex)!)
        } catch { throw fail("request-signature") }
        return kem
    }

    /// A hybrid signer for the owner key: purpose and payload in, 3373 bytes out.
    public typealias OwnerSigner = (_ purpose: String, _ payload: [UInt8]) throws -> [UInt8]

    static func pack(_ key: [UInt8], _ sig: [UInt8]) throws -> [UInt8] {
        guard !key.isEmpty, key.count <= 1024 else { throw fail("v2-malformed") }
        guard sig.count == PqHybrid.sigLen else { throw fail("owner-signature") }
        return PqBin.u16be(key.count) + key + sig
    }

    static func sha512Hex(_ b: [UInt8]) -> String { PqBin.hex(Array(SHA512.hash(data: b))) }

    /// The phone's reply: the disk key sealed to `replyKemPub`, signed by the owner.
    public static func buildReply(serverDomain: String, bootPubHex: String, nonceHex: String, replyKemPub: [UInt8],
                                  diskKey: [UInt8], ownerHybridPublicKey: [UInt8], issuedAt: Int64,
                                  sign: OwnerSigner, randomness: [UInt8]? = nil) throws -> [UInt8] {
        let d = serverDomain.lowercased(), b = bootPubHex.lowercased(), n = nonceHex.lowercased()
        guard domainOk(d), isHex(b, bytes: 32), isHex(n, bytes: 32), replyKemPub.count == 1216 else { throw fail("v2-malformed") }
        let statement = PqBin.utf8([tagBootReplyV2, d, b, "unlock-key", n, kemKeyIdHex(replyKemPub), sha512Hex(diskKey), String(issuedAt)].joined(separator: "|"))
        var plaintext = try pack(diskKey, try sign(tagBootReplyV2, statement))
        defer { PqBin.zero(&plaintext) }
        let opts = HybridSealOptions(purpose: tagBootReplyV2,
                                     senderKeyId: PqHybrid.pqKeyId(suite: PqHybrid.suiteHybridSigEd25519MlDsa65V1, publicKey: ownerHybridPublicKey),
                                     issuedAt: UInt64(issuedAt), sessionNonce: PqBin.unhex(n)!)
        let context: [[UInt8]] = [PqBin.utf8(d), PqBin.unhex(b)!, PqBin.utf8("unlock-key"), PqBin.unhex(n)!]
        if let r = randomness {
            return try PqHybrid.hybridSealWithRandomness(recipientPublicKey: replyKemPub, options: opts, context: context, plaintext: plaintext, eseed: r)
        }
        return try PqHybrid.hybridSeal(recipientPublicKey: replyKemPub, options: opts, context: context, plaintext: plaintext)
    }

    /// A v3 lease's `sealedKey` (the outer v2 lease JSON carries it unchanged).
    public static func sealLease(serverDomain: String, bootPubHex: String, leaseId: String, issuedAt: Int64, expiresAt: Int64,
                                 maxUses: Int? = nil, leaseKemPublicKey: [UInt8], diskKey: [UInt8],
                                 ownerHybridPublicKey: [UInt8], sign: OwnerSigner, randomness: [UInt8]? = nil) throws -> [UInt8] {
        let d = serverDomain.lowercased(), b = bootPubHex.lowercased(), l = leaseId.lowercased()
        guard domainOk(d), isHex(b, bytes: 32), l.utf8.count >= 16, l.utf8.count <= 128, l.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }),
              expiresAt > issuedAt, issuedAt >= 0 else { throw fail("v2-malformed") }
        let statement = PqBin.utf8([tagAutoUnlockLeaseV3, d, b, kemKeyIdHex(leaseKemPublicKey), l, sha512Hex(diskKey),
                                    String(issuedAt), String(expiresAt), String(maxUses ?? -1)].joined(separator: "|"))
        var plaintext = try pack(diskKey, try sign(tagAutoUnlockLeaseV3, statement))
        defer { PqBin.zero(&plaintext) }
        let opts = HybridSealOptions(purpose: tagAutoUnlockLeaseV3,
                                     senderKeyId: PqHybrid.pqKeyId(suite: PqHybrid.suiteHybridSigEd25519MlDsa65V1, publicKey: ownerHybridPublicKey),
                                     issuedAt: UInt64(issuedAt), expiresAt: UInt64(expiresAt))
        let context: [[UInt8]] = [PqBin.utf8(d), PqBin.unhex(b)!, PqBin.utf8(l)]
        if let r = randomness {
            return try PqHybrid.hybridSealWithRandomness(recipientPublicKey: leaseKemPublicKey, options: opts, context: context, plaintext: plaintext, eseed: r)
        }
        return try PqHybrid.hybridSeal(recipientPublicKey: leaseKemPublicKey, options: opts, context: context, plaintext: plaintext)
    }

    /// Which reply to send; throws `box-has-no-v2` or `phone-cannot-sign-hybrid` under strict.
    public static func chooseReplyVersion(strict: Bool, material: Bool, requestHasPq: Bool, canSignHybrid: Bool) throws -> Int {
        if material && requestHasPq && canSignHybrid { return 2 }
        if !strict { return 1 }
        if !material || !requestHasPq { throw fail("box-has-no-v2") }
        throw fail("phone-cannot-sign-hybrid")
    }

    /// Which lease to deposit: 3 when the box's material verified and this device signs hybrid.
    public static func chooseLeaseVersion(strict: Bool, material: Bool, canSignHybrid: Bool) throws -> Int {
        if material && canSignHybrid { return 3 }
        if !strict { return 2 }
        throw fail(material ? "phone-cannot-sign-hybrid" : "box-has-no-v2")
    }
}
