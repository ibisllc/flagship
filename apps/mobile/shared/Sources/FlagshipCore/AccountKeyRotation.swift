import Foundation
import CryptoKit

/// Account master-key rotation: Swift twin of `packages/protocol/src/accountKeyRotation.ts`.
///
/// The hop `flagship/account-key-rotation/v1` moves the account from key epoch N to N+1. Only the
/// pinned admin root authorises it, never an IRK; the new IRK and new AID sign the same bytes.
/// Kept devices receive the new UMK in `flagship/umk-rotation-delivery/v1`, sealed with X-Wing to
/// their receive key (`flagship/device-receive-key/v1`) or to their Ed25519 identity key. The
/// hybrid companion is `flagship/account-key-rotation/v2`. The follow-ups
/// `flagship/device-key-rotate/v1`, `flagship/cgk-rekey/v1`, `flagship/swk-rekey/v1` and
/// `flagship/luks-rekey-confirm/v1` are here for their canonical bytes and signatures.
///
/// Every port reads `packages/protocol/test-vectors/account-key-rotation/vectors.json`. CryptoKit's
/// Ed25519 signatures are randomized, so this port verifies the vectors' signatures and signs
/// round trip; the seals reproduce byte for byte.
public enum AccountKeyRotation {
    public static let tagRotation = "flagship/account-key-rotation/v1"
    public static let tagRotationV2 = "flagship/account-key-rotation/v2"
    public static let tagDelivery = "flagship/umk-rotation-delivery/v1"
    public static let tagDeviceKeyRotate = "flagship/device-key-rotate/v1"
    public static let tagDeviceReceiveKey = "flagship/device-receive-key/v1"
    public static let tagCgkRekey = "flagship/cgk-rekey/v1"
    public static let tagSwkRekey = "flagship/swk-rekey/v1"
    public static let tagLuksRekeyConfirm = "flagship/luks-rekey-confirm/v1"
    static let hybridSuite = SignatureSuite.hybrid.rawValue
    static let sealTag = "flagship.seal.v1"

    public enum IrkScheme: String, CaseIterable, Sendable {
        case web, ios, android
        var byte: UInt8 { switch self { case .web: 1; case .ios: 2; case .android: 3 } }
    }

    /// A refusal; `code` matches the other ports and the vectors.
    public struct Failure: Error, Equatable, CustomStringConvertible {
        public let code: String
        public init(_ code: String) { self.code = code }
        public var description: String { code }
    }

    /// Bad input at encode time (a caller bug, not a refusal).
    public struct InvalidField: Error, Equatable { public let field: String }

    public typealias Signer = ([UInt8]) throws -> [UInt8]

    // MARK: - Field checks

    static func need(_ ok: Bool, _ field: String) throws { if !ok { throw InvalidField(field: field) } }
    static func isHex(_ s: String, bytes n: Int) -> Bool { s.utf8.count == n * 2 && PqBin.isLowerHex(s) }
    static func hex32(_ s: String, _ f: String) throws -> String { try need(isHex(s, bytes: 32), f); return s }
    static func uint(_ n: Int64, _ f: String) throws -> String { try need(n >= 0 && n <= 9_007_199_254_740_991, f); return String(n) }
    static func deviceId(_ s: String) throws -> String { try need(isHex(s, bytes: 16), "deviceId"); return s }
    static func username(_ u: String) throws -> String {
        try need(!u.isEmpty && u.utf16.count <= 64 && u == u.lowercased()
                 && !u.utf8.contains(where: { $0 == 0x7c || $0 <= 0x1f || $0 == 0x7f }), "username")
        return u
    }
    static func domain(_ s: String) throws -> String {
        let b = Array(s.utf8)
        let ok = !b.isEmpty && b.count <= 253 && b.allSatisfy { ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2e || $0 == 0x2d }
            && b.first != 0x2e && b.first != 0x2d && b.last != 0x2e && b.last != 0x2d
        try need(ok, "serverDomain"); return s
    }
    static func sealedHex(_ s: String) throws -> String { try need(!s.isEmpty && PqBin.isLowerHex(s), "sealedHex"); return s }
    static func bytes(_ s: String) -> [UInt8] { PqBin.unhex(s) ?? [] }
    static func sha256Hex(_ b: [UInt8]) -> String { PqBin.hex(Array(SHA256.hash(data: b))) }
    static func join(_ parts: [String]) -> [UInt8] { Array(parts.joined(separator: "|").utf8) }

    /// 32 bytes, canonical, not of small order (strict: also torsion-free).
    public static func isAcceptableEd25519Key(_ pubHex: String) -> Bool {
        isHex(pubHex, bytes: 32) && PqPrim.edPoint(bytes(pubHex)[...])
    }

    static func verifyEd(_ sigHex: String, _ msg: [UInt8], _ pubHex: String) -> Bool {
        guard isHex(sigHex, bytes: 64), isAcceptableEd25519Key(pubHex) else { return false }
        return PqHybrid.ed25519VerifyStrict(signature: bytes(sigHex), message: msg, publicKey: bytes(pubHex))
    }

    /// A signer over a raw 32-byte Ed25519 seed (randomized CryptoKit signatures).
    public static func seedSigner(_ seed: [UInt8]) throws -> Signer {
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(seed))
        return { msg in Array(try key.signature(for: Data(msg))) }
    }

    static func pubHex(seed: [UInt8]) throws -> String {
        PqBin.hex(Array(try Curve25519.Signing.PrivateKey(rawRepresentation: Data(seed)).publicKey.rawRepresentation))
    }

    // MARK: - The hop

    public struct Rotation: Equatable, Sendable {
        public var username: String
        public var fromEpoch: Int64
        public var toEpoch: Int64
        public var oldIrkPubHex: String
        public var newIrkPubHex: String
        public var newIrkScheme: String
        public var oldAidPubHex: String
        public var newAidPubHex: String
        public var adminRootPubHex: String
        public var removedDeviceIds: [String]
        public var keptDevicesDigestHex: String
        public var recoveryRecordDigestHex: String?
        public var nonceHex: String
        public var issuedAt: Int64

        public init(username: String, fromEpoch: Int64, toEpoch: Int64, oldIrkPubHex: String, newIrkPubHex: String,
                    newIrkScheme: String, oldAidPubHex: String, newAidPubHex: String, adminRootPubHex: String,
                    removedDeviceIds: [String], keptDevicesDigestHex: String, recoveryRecordDigestHex: String?,
                    nonceHex: String, issuedAt: Int64) {
            self.username = username; self.fromEpoch = fromEpoch; self.toEpoch = toEpoch
            self.oldIrkPubHex = oldIrkPubHex; self.newIrkPubHex = newIrkPubHex; self.newIrkScheme = newIrkScheme
            self.oldAidPubHex = oldAidPubHex; self.newAidPubHex = newAidPubHex; self.adminRootPubHex = adminRootPubHex
            self.removedDeviceIds = removedDeviceIds; self.keptDevicesDigestHex = keptDevicesDigestHex
            self.recoveryRecordDigestHex = recoveryRecordDigestHex; self.nonceHex = nonceHex; self.issuedAt = issuedAt
        }
    }

    public struct Signatures: Equatable, Sendable {
        public var adminRootSignatureHex: String
        public var newIrkSignatureHex: String
        public var newAidSignatureHex: String
        public init(adminRootSignatureHex: String, newIrkSignatureHex: String, newAidSignatureHex: String) {
            self.adminRootSignatureHex = adminRootSignatureHex; self.newIrkSignatureHex = newIrkSignatureHex
            self.newAidSignatureHex = newAidSignatureHex
        }
    }

    /// What the verifier holds now. `aidPubHex` nil: the hop's old AID is not checked.
    public struct KeyState: Equatable, Sendable {
        public var username: String
        public var epoch: Int64
        public var irkPubHex: String
        public var aidPubHex: String?
        public var adminRootPubHex: String
        public init(username: String, epoch: Int64, irkPubHex: String, aidPubHex: String?, adminRootPubHex: String) {
            self.username = username; self.epoch = epoch; self.irkPubHex = irkPubHex
            self.aidPubHex = aidPubHex; self.adminRootPubHex = adminRootPubHex
        }
    }

    static func rotationFields(_ r: Rotation) throws -> [String] {
        try need(IrkScheme(rawValue: r.newIrkScheme) != nil, "newIrkScheme")
        let removed = try r.removedDeviceIds.map(deviceId).sorted()
        try need(Set(removed).count == removed.count, "removedDeviceIds")
        if let d = r.recoveryRecordDigestHex { try need(isHex(d, bytes: 32), "recoveryRecordDigestHex") }
        try need(isHex(r.nonceHex, bytes: 16), "nonceHex")
        return [
            try username(r.username), try uint(r.fromEpoch, "fromEpoch"), try uint(r.toEpoch, "toEpoch"),
            try hex32(r.oldIrkPubHex, "oldIrkPubHex"), try hex32(r.newIrkPubHex, "newIrkPubHex"), r.newIrkScheme,
            try hex32(r.oldAidPubHex, "oldAidPubHex"), try hex32(r.newAidPubHex, "newAidPubHex"),
            try hex32(r.adminRootPubHex, "adminRootPubHex"), removed.isEmpty ? "none" : removed.joined(separator: ","),
            try hex32(r.keptDevicesDigestHex, "keptDevicesDigestHex"), r.recoveryRecordDigestHex ?? "none",
            r.nonceHex, try uint(r.issuedAt, "issuedAt"),
        ]
    }

    public static func canonical(_ r: Rotation) throws -> [UInt8] { join([tagRotation] + (try rotationFields(r))) }

    public static func digestHex(_ r: Rotation) throws -> String { sha256Hex(try canonical(r)) }

    public static func sign(_ r: Rotation, adminRoot: Signer, newIrk: Signer, newAid: Signer) throws -> Signatures {
        let msg = try canonical(r)
        return Signatures(adminRootSignatureHex: PqBin.hex(try adminRoot(msg)), newIrkSignatureHex: PqBin.hex(try newIrk(msg)),
                          newAidSignatureHex: PqBin.hex(try newAid(msg)))
    }

    /// One hop against the verifier's own state; throws `Failure`.
    public static func verify(_ r: Rotation, signatures s: Signatures, state st: KeyState) throws {
        let user = st.username.lowercased(), irk = st.irkPubHex.lowercased()
        let aid = st.aidPubHex?.lowercased(), root = st.adminRootPubHex.lowercased()
        guard let msg = try? canonical(r) else { throw Failure("malformed") }
        if r.username != user { throw Failure("wrong-account") }
        if r.adminRootPubHex == irk || r.adminRootPubHex == r.oldIrkPubHex || r.adminRootPubHex == r.oldAidPubHex { throw Failure("signed-by-irk") }
        if r.adminRootPubHex != root { throw Failure("wrong-admin-root") }
        if r.fromEpoch < st.epoch { throw Failure("stale-epoch") }
        if r.fromEpoch > st.epoch { throw Failure("epoch-gap") }
        if r.toEpoch != r.fromEpoch + 1 { throw Failure("bad-epoch-step") }
        if r.oldIrkPubHex != irk { throw Failure("wrong-old-irk") }
        if let aid, !aid.isEmpty, r.oldAidPubHex != aid { throw Failure("wrong-old-aid") }
        if !isAcceptableEd25519Key(r.newIrkPubHex) || !isAcceptableEd25519Key(r.newAidPubHex) { throw Failure("weak-key") }
        let keys = [r.oldIrkPubHex, r.newIrkPubHex, r.oldAidPubHex, r.newAidPubHex, r.adminRootPubHex]
        if Set(keys).count != keys.count { throw Failure("key-not-new") }
        if !verifyEd(s.adminRootSignatureHex, msg, r.adminRootPubHex) { throw Failure("bad-admin-signature") }
        if !verifyEd(s.newIrkSignatureHex, msg, r.newIrkPubHex) { throw Failure("bad-new-irk-signature") }
        if !verifyEd(s.newAidSignatureHex, msg, r.newAidPubHex) { throw Failure("bad-new-aid-signature") }
    }

    // MARK: - Hybrid companion

    public static func canonicalV2(_ r: Rotation, newIrkKeyIdHex: String) throws -> [UInt8] {
        try need(isHex(newIrkKeyIdHex, bytes: 32), "newIrkKeyIdHex")
        return join([tagRotationV2] + (try rotationFields(r)) + [newIrkKeyIdHex])
    }

    /// The companion: `adminRootSign` is the admin root's hybrid signer (purpose, payload) → signature.
    public static func signPq(_ r: Rotation, newIrkBinding: PqKeyBindingWire,
                              adminRootSign: (_ purpose: String, _ payload: [UInt8]) throws -> [UInt8]) throws -> [String: Any] {
        let kid = PqAuthorityRecords.bindingKeyIdHex(ed25519PubHex: newIrkBinding.ed25519PubHex, mldsaPubHex: newIrkBinding.mldsaPubHex)
        let sig = try adminRootSign(tagRotationV2, try canonicalV2(r, newIrkKeyIdHex: kid))
        return ["signature": ["suite": hybridSuite, "signature": PqBin.hex(sig)], "newIrkBinding": newIrkBinding.jsonObject]
    }

    /// Verifies the companion (`pq` as JSON) under the verifier's own binding for the admin root and
    /// returns the new IRK's verified binding. Throws `PqTrustError`.
    public static func verifyPq(_ r: Rotation, pq: Any?, adminRootBinding: VerifiedPqKeyBinding?,
                                policy: PolicyState, now: Int64) throws -> VerifiedPqKeyBinding {
        guard let o = pq as? [String: Any] else { throw PqTrustError("strict-requires-hybrid") }
        guard let e = o["signature"] as? [String: Any], let suite = e["suite"] as? String, let sig = e["signature"] as? String
        else { throw PqTrustError("bad-signature") }
        if suite != hybridSuite { throw PqTrustError(suite == SignatureSuite.ed25519.rawValue ? "strict-requires-hybrid" : "unknown-suite") }
        let binding = try PqTrust.verifyPqKeyBinding(o["newIrkBinding"], PqBindingExpectation(
            role: PqBindingRole.accountIrk.rawValue, subjectId: r.username, ed25519PubHex: r.newIrkPubHex, now: now))
        guard let msg = try? canonicalV2(r, newIrkKeyIdHex: binding.keyIdHex) else { throw PqTrustError("bad-signature") }
        _ = try PqTrust.verifyCriticalSignature(message: msg, expectedPurpose: tagRotationV2,
                                                envelope: SignatureEnvelope(suite: hybridSuite, signature: sig),
                                                signerEd25519PubHex: r.adminRootPubHex, binding: adminRootBinding, policy: policy)
        return binding
    }

    // MARK: - Kept devices, derived keys

    public struct KeptDevice: Equatable, Sendable {
        public var deviceId: String
        public var devicePubHex: String
        public init(deviceId: String, devicePubHex: String) { self.deviceId = deviceId; self.devicePubHex = devicePubHex }
    }

    public static func keptDevicesLines(_ devices: [KeptDevice]) throws -> String {
        try need(!devices.isEmpty, "kept devices")
        let sorted = try devices.map { (try deviceId($0.deviceId), try hex32($0.devicePubHex, "devicePubHex")) }.sorted { $0.0 < $1.0 }
        try need(Set(sorted.map(\.0)).count == sorted.count, "kept devices")
        return sorted.map { "\($0.0):\($0.1)\n" }.joined()
    }

    public static func keptDevicesDigestHex(_ devices: [KeptDevice]) throws -> String {
        sha256Hex(Array(try keptDevicesLines(devices).utf8))
    }

    public static func verifyKept(_ r: Rotation, kept: [KeptDevice], selfDevice: KeptDevice) throws {
        guard let digest = try? keptDevicesDigestHex(kept) else { throw Failure("malformed") }
        if digest != r.keptDevicesDigestHex { throw Failure("kept-digest-mismatch") }
        if !kept.contains(selfDevice) { throw Failure("not-kept") }
    }

    static func hkdf(_ ikm: [UInt8], salt: String, info: String) -> [UInt8] {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: Data(salt.utf8), info: Data(info.utf8),
                               outputByteCount: 32).withUnsafeBytes { Array($0) }
    }

    /// True when the device key is `HKDF(umk, flagship/account-device-key/v1|acct|id)`.
    public static func deviceKeyIsUmkDerived(umk: [UInt8], accountName: String, deviceId id: String, devicePubHex: String) -> Bool {
        guard umk.count == 32, isHex(id, bytes: 16), isHex(devicePubHex, bytes: 32) else { return false }
        let seed = hkdf(umk, salt: "", info: "flagship/account-device-key/v1|\(accountName.lowercased())|\(id)")
        return (try? pubHex(seed: seed)) == devicePubHex
    }

    public static func irkSeed(umk: [UInt8], scheme: IrkScheme, version: Int = 1) -> [UInt8] {
        switch scheme {
        case .web: return hkdf(umk, salt: "", info: "flagship.irk.v\(version)")
        case .ios: return hkdf(umk, salt: "", info: "flagship/irk/v\(version)")
        case .android: return hkdf(umk, salt: "flagship/irk/v\(version)", info: "ed25519-seed")
        }
    }

    public static func aidSeed(umk: [UInt8]) -> [UInt8] { hkdf(umk, salt: "", info: "flagship/account-id/v1") }

    /// After opening: the UMK must yield the hop's new IRK (its scheme, v1) and new AID.
    public static func checkRotatedUmk(_ r: Rotation, _ p: Plaintext) throws {
        guard p.irkScheme.rawValue == r.newIrkScheme,
              (try? pubHex(seed: irkSeed(umk: p.umk, scheme: p.irkScheme))) == r.newIrkPubHex,
              (try? pubHex(seed: aidSeed(umk: p.umk))) == r.newAidPubHex
        else { throw Failure("umk-mismatch") }
    }

    // MARK: - The delivery

    public struct Plaintext: Equatable, Sendable {
        public var umk: [UInt8]
        public var irkScheme: IrkScheme
        public var adminRootSeed: [UInt8]?
        public init(umk: [UInt8], irkScheme: IrkScheme, adminRootSeed: [UInt8]? = nil) {
            self.umk = umk; self.irkScheme = irkScheme; self.adminRootSeed = adminRootSeed
        }
    }

    /// `umk(32) | irkScheme(1) | flags(1) | [adminRootSeed(32)]`.
    public static func encodePlaintext(_ p: Plaintext) throws -> [UInt8] {
        try need(p.umk.count == 32, "umk")
        if let r = p.adminRootSeed { try need(r.count == 32, "adminRootSeed") }
        return p.umk + [p.irkScheme.byte, p.adminRootSeed == nil ? 0 : 1] + (p.adminRootSeed ?? [])
    }

    public static func decodePlaintext(_ b: [UInt8]) throws -> Plaintext {
        guard b.count == 34 || b.count == 66, let scheme = IrkScheme.allCases.first(where: { $0.byte == b[32] }),
              b[33] & ~UInt8(1) == 0, (b[33] == 1) == (b.count == 66)
        else { throw Failure("bad-plaintext") }
        return Plaintext(umk: Array(b[0..<32]), irkScheme: scheme, adminRootSeed: b.count == 66 ? Array(b[34..<66]) : nil)
    }

    public struct Delivery: Equatable, Sendable {
        public var username: String
        public var toEpoch: Int64
        public var deviceId: String
        public var devicePubHex: String
        public var rotationDigestHex: String
        public var sealedDigestHex: String
        public var issuedAt: Int64
        public init(username: String, toEpoch: Int64, deviceId: String, devicePubHex: String, rotationDigestHex: String,
                    sealedDigestHex: String, issuedAt: Int64) {
            self.username = username; self.toEpoch = toEpoch; self.deviceId = deviceId; self.devicePubHex = devicePubHex
            self.rotationDigestHex = rotationDigestHex; self.sealedDigestHex = sealedDigestHex; self.issuedAt = issuedAt
        }
    }

    public static func canonical(_ d: Delivery) throws -> [UInt8] {
        join([tagDelivery, try username(d.username), try uint(d.toEpoch, "toEpoch"), try deviceId(d.deviceId),
              try hex32(d.devicePubHex, "devicePubHex"), try hex32(d.rotationDigestHex, "rotationDigestHex"),
              try hex32(d.sealedDigestHex, "sealedDigestHex"), try uint(d.issuedAt, "issuedAt")])
    }

    public enum SealKind: String, Sendable { case xwing, ed25519 }

    public static func deliveryContext(username u: String, toEpoch: Int64, deviceId id: String) throws -> [[UInt8]] {
        [Array(try username(u).utf8), Array(try uint(toEpoch, "toEpoch").utf8), Array(try deviceId(id).utf8)]
    }

    public static func senderKeyId(adminRootPubHex: String) throws -> [UInt8] {
        Array(SHA256.hash(data: bytes(try hex32(adminRootPubHex, "adminRootPubHex"))))
    }

    /// X-Wing to the receive key. `randomness` (64 bytes) is for vectors only.
    public static func sealXWing(_ r: Rotation, deviceId id: String, plaintext: [UInt8], receiveKey: [UInt8],
                                 issuedAt: Int64, randomness: [UInt8]? = nil) throws -> [UInt8] {
        let opts = HybridSealOptions(purpose: tagDelivery, senderKeyId: try senderKeyId(adminRootPubHex: r.adminRootPubHex),
                                     issuedAt: UInt64(issuedAt))
        let ctx = try deliveryContext(username: r.username, toEpoch: r.toEpoch, deviceId: id)
        if let randomness {
            return try PqHybrid.hybridSealWithRandomness(recipientPublicKey: receiveKey, options: opts, context: ctx,
                                                         plaintext: plaintext, eseed: randomness)
        }
        return try PqHybrid.hybridSeal(recipientPublicKey: receiveKey, options: opts, context: ctx, plaintext: plaintext)
    }

    /// The classical fallback to the device's Ed25519 identity key (`SecretSeal`'s layout); the
    /// ephemeral secret and nonce are for vectors only.
    public static func sealEd25519(plaintext: [UInt8], devicePub: [UInt8], ephPriv: [UInt8]? = nil, nonce: [UInt8]? = nil) throws -> [UInt8] {
        guard let ephPriv, let nonce else {
            return Array(try SecretSeal.sealForEd25519Recipient(plaintext: Data(plaintext), recipientEd25519Pub: Data(devicePub)))
        }
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: try Curve25519Map.edwardsPubToMontgomery(Data(devicePub)))
        let eph = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(ephPriv))
        let ephPub = eph.publicKey.rawRepresentation
        let key = try eph.sharedSecretFromKeyAgreement(with: peer)
            .hkdfDerivedSymmetricKey(using: SHA256.self, salt: ephPub, sharedInfo: Data(sealTag.utf8), outputByteCount: 32)
        let box = try AES.GCM.seal(Data(plaintext), using: key, nonce: try AES.GCM.Nonce(data: Data(nonce)))
        return Array(ephPub) + nonce + Array(box.ciphertext) + Array(box.tag)
    }

    public static func buildDelivery(_ r: Rotation, deviceId id: String, devicePubHex: String, sealed: [UInt8], issuedAt: Int64,
                                     adminRoot: Signer) throws -> (delivery: Delivery, signatureHex: String) {
        let d = Delivery(username: r.username, toEpoch: r.toEpoch, deviceId: id, devicePubHex: devicePubHex,
                         rotationDigestHex: try digestHex(r), sealedDigestHex: sha256Hex(sealed), issuedAt: issuedAt)
        return (d, PqBin.hex(try adminRoot(try canonical(d))))
    }

    /// A kept device opens its delivery (the caller verified the hop under its own pin). `secret`
    /// is the X-Wing receive-key seed or the Ed25519 identity seed. Throws `Failure`.
    public static func open(_ r: Rotation, delivery d: Delivery, signatureHex: String, sealed: [UInt8], kind: SealKind,
                            selfDevice: KeptDevice, secret: [UInt8]) throws -> Plaintext {
        guard let msg = try? canonical(d) else { throw Failure("malformed") }
        if !verifyEd(signatureHex, msg, r.adminRootPubHex) { throw Failure("bad-signature") }
        if d.username != r.username || d.toEpoch != r.toEpoch { throw Failure("rotation-mismatch") }
        if d.rotationDigestHex != (try? digestHex(r)) { throw Failure("rotation-mismatch") }
        if d.deviceId != selfDevice.deviceId || d.devicePubHex != selfDevice.devicePubHex { throw Failure("wrong-recipient") }
        if d.sealedDigestHex != sha256Hex(sealed) { throw Failure("sealed-mismatch") }
        let plain: [UInt8]
        do {
            switch kind {
            case .xwing:
                let opened = try PqHybrid.hybridOpen(recipientSecretKey: secret, expectedPurpose: tagDelivery,
                                                     context: try deliveryContext(username: r.username, toEpoch: r.toEpoch, deviceId: d.deviceId),
                                                     sealed: sealed)
                guard opened.header.issuedAt == UInt64(d.issuedAt),
                      opened.header.senderKeyId == (try senderKeyId(adminRootPubHex: r.adminRootPubHex)) else { throw Failure("open-failed") }
                plain = opened.plaintext
            case .ed25519:
                guard (try? pubHex(seed: secret)) == d.devicePubHex else { throw Failure("open-failed") }
                plain = Array(try SecretSeal.openWithEd25519Seed(blob: Data(sealed), recipientEd25519Seed: Data(secret)))
            }
        } catch {
            throw Failure("open-failed")
        }
        let p = try decodePlaintext(plain)
        try checkRotatedUmk(r, p)
        return p
    }

    // MARK: - Device key rotate / receive key

    public static func canonicalDeviceKeyRotate(username u: String, deviceId id: String, oldDevicePubHex: String,
                                                newDevicePubHex: String, issuedAt: Int64) throws -> [UInt8] {
        join([tagDeviceKeyRotate, try username(u), try deviceId(id), try hex32(oldDevicePubHex, "oldDevicePubHex"),
              try hex32(newDevicePubHex, "newDevicePubHex"), try uint(issuedAt, "issuedAt")])
    }

    /// Both signatures, the new key different from the old and from the admin root.
    public static func verifyDeviceKeyRotate(username u: String, deviceId id: String, oldDevicePubHex: String, newDevicePubHex: String,
                                             issuedAt: Int64, newKeySignatureHex: String, adminRootSignatureHex: String,
                                             adminRootPubHex: String) -> Bool {
        guard let msg = try? canonicalDeviceKeyRotate(username: u, deviceId: id, oldDevicePubHex: oldDevicePubHex,
                                                      newDevicePubHex: newDevicePubHex, issuedAt: issuedAt),
              newDevicePubHex != oldDevicePubHex, newDevicePubHex != adminRootPubHex else { return false }
        return verifyEd(newKeySignatureHex, msg, newDevicePubHex) && verifyEd(adminRootSignatureHex, msg, adminRootPubHex)
    }

    public static func canonicalDeviceReceiveKey(username u: String, deviceId id: String, devicePubHex: String,
                                                 xwingPubHex: String, issuedAt: Int64) throws -> [UInt8] {
        guard let pk = PqBin.unhex(xwingPubHex), !pk.isEmpty else { throw InvalidField(field: "xwingPubHex") }
        try PqHybrid.parseHybridSealPublicKey(pk)
        return join([tagDeviceReceiveKey, try username(u), try deviceId(id), try hex32(devicePubHex, "devicePubHex"),
                     xwingPubHex, try uint(issuedAt, "issuedAt")])
    }

    public static func verifyDeviceReceiveKey(username u: String, deviceId id: String, devicePubHex: String,
                                              xwingPubHex: String, issuedAt: Int64, signatureHex: String) -> Bool {
        guard let msg = try? canonicalDeviceReceiveKey(username: u, deviceId: id, devicePubHex: devicePubHex,
                                                       xwingPubHex: xwingPubHex, issuedAt: issuedAt) else { return false }
        return verifyEd(signatureHex, msg, devicePubHex)
    }

    // MARK: - Per-server follow-ups

    public static func canonicalCgkRekey(serverDomain: String, toEpoch: Int64, sealedHex s: String, issuedAt: Int64) throws -> [UInt8] {
        join([tagCgkRekey, try domain(serverDomain), try uint(toEpoch, "toEpoch"), try sealedHex(s), try uint(issuedAt, "issuedAt")])
    }

    public static func canonicalSwkRekey(serverDomain: String, toEpoch: Int64, oldSwkCommitHex: String, sealedHex s: String,
                                         issuedAt: Int64) throws -> [UInt8] {
        join([tagSwkRekey, try domain(serverDomain), try uint(toEpoch, "toEpoch"), try hex32(oldSwkCommitHex, "oldSwkCommitHex"),
              try sealedHex(s), try uint(issuedAt, "issuedAt")])
    }

    public static func canonicalLuksRekeyConfirm(serverDomain: String, toEpoch: Int64, sealedKeyDigestHex: String,
                                                 issuedAt: Int64) throws -> [UInt8] {
        join([tagLuksRekeyConfirm, try domain(serverDomain), try uint(toEpoch, "toEpoch"),
              try hex32(sealedKeyDigestHex, "sealedKeyDigestHex"), try uint(issuedAt, "issuedAt")])
    }

    /// CGK and SWK re-keys are signed by the admin root, the LUKS confirmation by the new IRK.
    public static func verifyRekey(_ build: () throws -> [UInt8], signatureHex: String, signerPubHex: String) -> Bool {
        guard let msg = try? build() else { return false }
        return verifyEd(signatureHex, msg, signerPubHex)
    }
}
