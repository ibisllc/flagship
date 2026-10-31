import Foundation
import CryptoKit
import FlagshipAPI

/// The owner's single dead-man setting (docs/architecture-v2/serving-wiring.md section 4,
/// issuance-and-lease-records.md section 5). Byte-identical to
/// `packages/protocol/src/servingAuthority.ts` for the records an app signs, pinned by
/// `packages/protocol/test-vectors/serving-authority/vectors.json`:
///
///   flagship/serving-policy/v1|<account>|<box>|<regGen>|<policyGen>|<grace>|<onLapse>|<scopeSha256>|<issuedAt>
///   flagship/renewal-key-delegation/v1|<account>|p256|<renewalPub>|<deviceId>|<issuedAt>
///   flagship/serving-lease/v1|<account>|<box>|<regGen>|<policyGen>|<leaseId>|<issuedAt>|<notAfter>
///
/// The admin root signs the policy and each device's renewal-key delegation (Ed25519). An admin
/// device signs a lease each time the app opens, with its hardware renewal key: ECDSA P-256 over
/// SHA-256 of the canonical bytes, sent as compact low-S `r‖s`.
extension ServingPolicy {
    public func canonicalBytes() throws -> Data {
        try ServingAuthority.account(account)
        try ServingAuthority.hex("box", box, ServingAuthority.isHex64)
        try ServingAuthority.int("regGen", regGen, min: 1)
        try ServingAuthority.int("policyGen", policyGen, min: 1)
        guard let g = graceValue else { throw ServingRecordError.invalid("grace must be 7d, 30d or indefinite") }
        guard let o = onLapseValue else { throw ServingRecordError.invalid("onLapse must be stop-apps or lock-server") }
        if o == .lockServer && g == .indefinite { throw ServingRecordError.invalid("locking needs a time limit") }
        try ServingAuthority.hex("scopeSha256", scopeSha256, ServingAuthority.isHex64)
        try ServingAuthority.int("issuedAt", issuedAt, min: 0)
        return ServingAuthority.join([Self.tag, account, box, String(regGen), String(policyGen), grace, onLapse, scopeSha256, String(issuedAt)])
    }
}

extension RenewalKeyDelegation {
    public func canonicalBytes() throws -> Data {
        try ServingAuthority.account(account)
        guard alg == "p256" else { throw ServingRecordError.invalid("alg must be p256") }
        try ServingAuthority.hex("renewalPub", renewalPub, ServingAuthority.isP256Pub)
        try ServingAuthority.hex("deviceId", deviceId, ServingAuthority.isHex64)
        try ServingAuthority.int("issuedAt", issuedAt, min: 0)
        return ServingAuthority.join([Self.tag, account, alg, renewalPub, deviceId, String(issuedAt)])
    }
}

extension ServingLease {
    public func canonicalBytes() throws -> Data {
        try ServingAuthority.account(account)
        try ServingAuthority.hex("box", box, ServingAuthority.isHex64)
        try ServingAuthority.int("regGen", regGen, min: 1)
        try ServingAuthority.int("policyGen", policyGen, min: 1)
        try ServingAuthority.hex("leaseId", leaseId, ServingAuthority.isHex32)
        try ServingAuthority.int("issuedAt", issuedAt, min: 0)
        try ServingAuthority.int("notAfter", notAfter, min: 0)
        guard notAfter > issuedAt else { throw ServingRecordError.invalid("notAfter must be after issuedAt") }
        return ServingAuthority.join([Self.tag, account, box, String(regGen), String(policyGen), leaseId, String(issuedAt), String(notAfter)])
    }
}

public enum ServingAuthority {
    /// The lease an admin device signs when the app opens: the full grace ahead of now. Nil under an indefinite policy.
    public static func leaseFor(_ policy: ServingPolicy, now: Int64, leaseId: String) -> ServingLease? {
        guard let ms = policy.graceValue?.ms else { return nil }
        return ServingLease(account: policy.account, box: policy.box, regGen: policy.regGen, policyGen: policy.policyGen,
                            leaseId: leaseId, issuedAt: now, notAfter: now + ms)
    }

    public static func randomLeaseId() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        return HexUtil.encode(Data(bytes))
    }

    /// Ed25519 over the canonical bytes (the admin root's signatures), lowercase hex.
    public static func signEd25519(_ canonical: Data, key: Curve25519.Signing.PrivateKey) throws -> String {
        HexUtil.encode(try key.signature(for: canonical))
    }

    public static func verifyEd25519(_ canonical: Data, signatureHex: String, publicKeyHex: String) -> Bool {
        guard isHex(signatureHex, chars: 128), isHex64(publicKeyHex),
              let sig = HexUtil.decode(signatureHex), let pub = HexUtil.decode(publicKeyHex),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: pub) else { return false }
        return key.isValidSignature(sig, for: canonical)
    }

    // MARK: P-256 (the renewal key)

    /// The P-256 group order n, big-endian.
    static let p256Order: [UInt8] = hexBytes("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551")
    /// floor(n / 2): an S above it is "high".
    static let p256HalfOrder: [UInt8] = hexBytes("7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8")

    /// A compact `r‖s` signature with S replaced by n − S when S is high. Nil for anything not 64 bytes.
    public static func normalizeLowS(_ raw: Data) -> Data? {
        guard raw.count == 64 else { return nil }
        let r = [UInt8](raw.prefix(32))
        let s = [UInt8](raw.suffix(32))
        guard compare(s, p256HalfOrder) > 0 else { return raw }
        return Data(r + subtract(p256Order, s))
    }

    public static func isLowS(_ raw: Data) -> Bool {
        raw.count == 64 && compare([UInt8](raw.suffix(32)), p256HalfOrder) <= 0
    }

    /// A DER `SEQUENCE { INTEGER r, INTEGER s }` as compact 64-byte `r‖s` (not yet normalised). Nil when malformed.
    public static func derToRaw(_ der: Data) -> Data? {
        let b = [UInt8](der)
        var i = 0
        func readLen() -> Int? {
            guard i < b.count else { return nil }
            let first = Int(b[i]); i += 1
            if first < 0x80 { return first }
            let n = first & 0x7f
            guard n >= 1, n <= 2, i + n <= b.count else { return nil }
            var len = 0
            for _ in 0..<n { len = (len << 8) | Int(b[i]); i += 1 }
            return len
        }
        func readInt() -> [UInt8]? {
            guard i < b.count, b[i] == 0x02 else { return nil }
            i += 1
            guard let len = readLen(), len >= 1, i + len <= b.count else { return nil }
            var v = Array(b[i..<(i + len)]); i += len
            while v.count > 1 && v[0] == 0 { v.removeFirst() }
            guard v.count <= 32 else { return nil }
            return [UInt8](repeating: 0, count: 32 - v.count) + v
        }
        guard b.first == 0x30 else { return nil }
        i = 1
        guard let total = readLen(), i + total == b.count else { return nil }
        guard let r = readInt(), let s = readInt(), i == b.count else { return nil }
        return Data(r + s)
    }

    /// Sign a lease with a P-256 signer that returns compact `r‖s` (CryptoKit's `rawRepresentation`), low-S hex.
    public static func signLeaseP256(_ lease: ServingLease, sign: (Data) throws -> Data) throws -> String {
        let raw = try sign(try lease.canonicalBytes())
        guard let low = normalizeLowS(raw) else { throw ServingRecordError.invalid("a P-256 signature is 64 bytes") }
        return HexUtil.encode(low)
    }

    /// A lease signed by a delegated renewal key; refuses high-S and anything malformed.
    public static func verifyLeaseP256(_ lease: ServingLease, signatureHex: String, renewalPubHex: String) -> Bool {
        guard isHex(signatureHex, chars: 128), isP256Pub(renewalPubHex),
              let sig = HexUtil.decode(signatureHex), isLowS(sig),
              let pubBytes = HexUtil.decode(renewalPubHex),
              let pub = try? P256.Signing.PublicKey(compressedRepresentation: pubBytes),
              let ecdsa = try? P256.Signing.ECDSASignature(rawRepresentation: sig),
              let canonical = try? lease.canonicalBytes() else { return false }
        return pub.isValidSignature(ecdsa, for: canonical)
    }

    /// SEC1 compressed form of a P-256 public key, 66 lowercase hex.
    public static func compressedHex(_ key: P256.Signing.PublicKey) -> String {
        HexUtil.encode(key.compressedRepresentation)
    }

    // MARK: field rules

    static func join(_ parts: [String]) -> Data { Data(parts.joined(separator: "|").utf8) }

    static func isHex(_ s: String, chars: Int) -> Bool {
        s.utf8.count == chars && s.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    static func isHex64(_ s: String) -> Bool { isHex(s, chars: 64) }
    static func isHex32(_ s: String) -> Bool { isHex(s, chars: 32) }
    static func isP256Pub(_ s: String) -> Bool { isHex(s, chars: 66) && (s.hasPrefix("02") || s.hasPrefix("03")) }

    static func hex(_ name: String, _ v: String, _ ok: (String) -> Bool) throws {
        guard ok(v) else { throw ServingRecordError.invalid("\(name) must be lowercase hex of the right length") }
    }
    static func int(_ name: String, _ v: Int64, min: Int64) throws {
        guard v >= min, v <= 9_007_199_254_740_991 else { throw ServingRecordError.invalid("\(name) must be a safe integer ≥ \(min)") }
    }
    static func account(_ v: String) throws {
        let u = Array(v.utf8)
        func ok(_ c: UInt8) -> Bool { (48...57).contains(c) || (97...122).contains(c) }
        guard (1...63).contains(u.count), ok(u.first!), ok(u.last!),
              u.allSatisfy({ ok($0) || $0 == 45 }) else { throw ServingRecordError.invalid("account must be a lowercase account name") }
    }

    private static func hexBytes(_ s: String) -> [UInt8] { [UInt8](HexUtil.decode(s) ?? Data()) }

    private static func compare(_ a: [UInt8], _ b: [UInt8]) -> Int {
        for (x, y) in zip(a, b) where x != y { return x < y ? -1 : 1 }
        return 0
    }

    /// a − b for equal-length big-endian numbers with a ≥ b.
    private static func subtract(_ a: [UInt8], _ b: [UInt8]) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: a.count)
        var borrow = 0
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            var d = Int(a[i]) - Int(b[i]) - borrow
            borrow = d < 0 ? 1 : 0
            if d < 0 { d += 256 }
            out[i] = UInt8(d)
        }
        return out
    }
}

/// What this device last learned of each server's serving policy (non-secret, the box and `.com`
/// enforce): whether it locks the server and the current deadline. Bounds auto-unlock leases
/// (`ServingLockLeaseBound`) and lets the server page show the line before the box answers.
public struct ServingStateStore {
    private let defaults: UserDefaults
    private static let locksPrefix = "flagship.serving.locks."
    private static let untilPrefix = "flagship.serving.until."

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private static func key(_ prefix: String, _ domain: String) -> String { prefix + domain.lowercased() }

    public func locks(_ serverDomain: String) -> Bool {
        defaults.bool(forKey: Self.key(Self.locksPrefix, serverDomain))
    }

    public func until(_ serverDomain: String) -> Int64? {
        (defaults.object(forKey: Self.key(Self.untilPrefix, serverDomain)) as? NSNumber)?.int64Value
    }

    public func record(_ serverDomain: String, onLapse: ServingOnLapse, grace: ServingGrace, until: Int64?) {
        defaults.set(onLapse == .lockServer && grace != .indefinite, forKey: Self.key(Self.locksPrefix, serverDomain))
        let k = Self.key(Self.untilPrefix, serverDomain)
        if let until { defaults.set(NSNumber(value: until), forKey: k) } else { defaults.removeObject(forKey: k) }
    }

    public func record(_ serverDomain: String, view: ServingView) {
        record(serverDomain, onLapse: view.onLapseValue, grace: view.graceValue, until: view.until)
    }

    public func clear(_ serverDomain: String) {
        defaults.removeObject(forKey: Self.key(Self.locksPrefix, serverDomain))
        defaults.removeObject(forKey: Self.key(Self.untilPrefix, serverDomain))
    }
}

/// The server page's one line (issuance-and-lease-records.md section 5).
public enum ServingLine {
    public enum Kind: Equatable, Sendable {
        /// "Stays online until <date> if no admin opens Flagship".
        case staysOnline(until: Int64)
        /// "Locks on <date> if no admin opens Flagship".
        case locks(until: Int64)
        /// "No time limit".
        case noLimit
        /// A finite policy no admin device has renewed yet (or whose lease has ended).
        case noLease(locks: Bool)
    }

    public static func kind(grace: ServingGrace, onLapse: ServingOnLapse, until: Int64?) -> Kind {
        guard grace != .indefinite else { return .noLimit }
        let locks = onLapse == .lockServer
        guard let until else { return .noLease(locks: locks) }
        return locks ? .locks(until: until) : .staysOnline(until: until)
    }
}
