import Foundation
import CryptoKit
import Security

/// Oblivious HTTP (RFC 9458) with Binary HTTP (RFC 9292), the Swift twin of packages/protocol/src/ohttp.ts.
/// One suite: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM. HPKE base mode is built from CryptoKit's
/// primitives (not `HPKE.Sender`) so the ephemeral key and the response nonce can be fixed for the shared vectors;
/// a test checks CryptoKit's own `HPKE.Recipient` opens what this seals.
public enum Ohttp {
    public static let requestMediaType = "message/ohttp-req"
    public static let responseMediaType = "message/ohttp-res"
    public static let kemX25519 = 0x0020
    public static let kdfHkdfSha256 = 0x0001
    public static let aeadAes128Gcm = 0x0001

    static let nk = 16, nn = 12, nh = 32, nenc = 32
    static let secretLen = max(nn, nk)

    public enum Failure: Error, Equatable { case key, format, decrypt }

    // MARK: HPKE (RFC 9180, base mode)

    static func u16(_ n: Int) -> [UInt8] { [UInt8((n >> 8) & 0xff), UInt8(n & 0xff)] }
    static func utf8(_ s: String) -> [UInt8] { Array(s.utf8) }

    static let kemSuite = utf8("KEM") + u16(kemX25519)
    static let hpkeSuite = utf8("HPKE") + u16(kemX25519) + u16(kdfHkdfSha256) + u16(aeadAes128Gcm)
    static let hpkeV1 = utf8("HPKE-v1")

    static func hmac(_ key: [UInt8], _ data: [UInt8]) -> [UInt8] {
        Array(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    static func hkdfExtract(salt: [UInt8], ikm: [UInt8]) -> [UInt8] { hmac(salt, ikm) }

    static func hkdfExpand(prk: [UInt8], info: [UInt8], length: Int) -> [UInt8] {
        var out: [UInt8] = [], t: [UInt8] = [], i: UInt8 = 1
        while out.count < length {
            t = hmac(prk, t + info + [i])
            out += t
            i += 1
        }
        return Array(out.prefix(length))
    }

    static func labeledExtract(_ suite: [UInt8], salt: [UInt8], label: String, ikm: [UInt8]) -> [UInt8] {
        hkdfExtract(salt: salt, ikm: hpkeV1 + suite + utf8(label) + ikm)
    }

    static func labeledExpand(_ suite: [UInt8], prk: [UInt8], label: String, info: [UInt8], length: Int) -> [UInt8] {
        hkdfExpand(prk: prk, info: u16(length) + hpkeV1 + suite + utf8(label) + info, length: length)
    }

    static func kemSharedSecret(dh: [UInt8], enc: [UInt8], pkR: [UInt8]) -> [UInt8] {
        let eaePrk = labeledExtract(kemSuite, salt: [], label: "eae_prk", ikm: dh)
        return labeledExpand(kemSuite, prk: eaePrk, label: "shared_secret", info: enc + pkR, length: 32)
    }

    struct Context { var key: [UInt8]; var baseNonce: [UInt8]; var exporterSecret: [UInt8] }

    static func keySchedule(sharedSecret: [UInt8], info: [UInt8]) -> Context {
        let pskIdHash = labeledExtract(hpkeSuite, salt: [], label: "psk_id_hash", ikm: [])
        let infoHash = labeledExtract(hpkeSuite, salt: [], label: "info_hash", ikm: info)
        let ctx = [0] + pskIdHash + infoHash
        let secret = labeledExtract(hpkeSuite, salt: sharedSecret, label: "secret", ikm: [])
        return Context(key: labeledExpand(hpkeSuite, prk: secret, label: "key", info: ctx, length: nk),
                       baseNonce: labeledExpand(hpkeSuite, prk: secret, label: "base_nonce", info: ctx, length: nn),
                       exporterSecret: labeledExpand(hpkeSuite, prk: secret, label: "exp", info: ctx, length: nh))
    }

    static func export(_ c: Context, _ exporterContext: [UInt8], _ length: Int) -> [UInt8] {
        labeledExpand(hpkeSuite, prk: c.exporterSecret, label: "sec", info: exporterContext, length: length)
    }

    static func dh(_ priv: [UInt8], _ pub: [UInt8]) throws -> [UInt8] {
        let sk = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: priv)
        let pk = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: pub)
        return try sk.sharedSecretFromKeyAgreement(with: pk).withUnsafeBytes { Array($0) }
    }

    static func seal(key: [UInt8], nonce: [UInt8], _ plaintext: [UInt8]) throws -> [UInt8] {
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: try AES.GCM.Nonce(data: nonce))
        return Array(box.ciphertext) + Array(box.tag)
    }

    static func open(key: [UInt8], nonce: [UInt8], _ ct: [UInt8]) throws -> [UInt8] {
        guard ct.count >= 16 else { throw Failure.decrypt }
        let box = try AES.GCM.SealedBox(nonce: try AES.GCM.Nonce(data: nonce), ciphertext: ct.dropLast(16), tag: ct.suffix(16))
        return Array(try AES.GCM.open(box, using: SymmetricKey(data: key)))
    }

    // MARK: key configuration (RFC 9458 §3)

    public struct KeyConfig: Equatable, Sendable {
        public var keyId: UInt8
        /// X25519 public key, 32 bytes.
        public var publicKey: [UInt8]
        public init(keyId: UInt8, publicKey: [UInt8]) { self.keyId = keyId; self.publicKey = publicKey }
    }

    public struct GatewayKey: Sendable {
        public var config: KeyConfig
        public var privateKey: [UInt8]
        public init(keyId: UInt8, privateKey: [UInt8]) throws {
            let sk = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
            self.privateKey = privateKey
            self.config = KeyConfig(keyId: keyId, publicKey: Array(sk.publicKey.rawRepresentation))
        }
    }

    public static func encodeKeyConfig(_ c: KeyConfig) -> [UInt8] {
        [c.keyId] + u16(kemX25519) + c.publicKey + u16(4) + u16(kdfHkdfSha256) + u16(aeadAes128Gcm)
    }

    /// One key configuration; nil unless it offers our KEM and suite.
    public static func parseKeyConfig(_ b: [UInt8]) -> KeyConfig? {
        guard b.count >= 1 + 2 + nenc + 2 else { return nil }
        guard (Int(b[1]) << 8 | Int(b[2])) == kemX25519 else { return nil }
        let pk = Array(b[3..<(3 + nenc)])
        var o = 3 + nenc
        let len = Int(b[o]) << 8 | Int(b[o + 1])
        o += 2
        guard len % 4 == 0, o + len == b.count else { return nil }
        var i = o
        while i < o + len {
            let kdf = Int(b[i]) << 8 | Int(b[i + 1]), aead = Int(b[i + 2]) << 8 | Int(b[i + 3])
            if kdf == kdfHkdfSha256 && aead == aeadAes128Gcm { return KeyConfig(keyId: b[0], publicKey: pk) }
            i += 4
        }
        return nil
    }

    public static func keyConfig(hex: String) -> KeyConfig? {
        guard hex.count % 2 == 0, !hex.isEmpty, let d = HexUtil.decode(hex) else { return nil }
        return parseKeyConfig(Array(d))
    }

    // MARK: encapsulation (RFC 9458 §4)

    static let requestLabel = utf8("message/bhttp request")
    static let responseLabel = utf8("message/bhttp response")

    static func header(_ keyId: UInt8) -> [UInt8] { [keyId] + u16(kemX25519) + u16(kdfHkdfSha256) + u16(aeadAes128Gcm) }

    /// What a side keeps to seal or open the response.
    public struct ResponseContext: Sendable { public var enc: [UInt8]; public var secret: [UInt8] }

    /// Client: encrypt a Binary HTTP request for the gateway. `ephemeralPrivateKey` is a test seam.
    public static func encapsulateRequest(_ config: KeyConfig, _ request: [UInt8], ephemeralPrivateKey: [UInt8]? = nil) throws
        -> (encapsulated: [UInt8], context: ResponseContext) {
        let skE = try ephemeralPrivateKey.map { try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: $0) } ?? Curve25519.KeyAgreement.PrivateKey()
        let enc = Array(skE.publicKey.rawRepresentation)
        let shared = try dh(Array(skE.rawRepresentation), config.publicKey)
        let hdr = header(config.keyId)
        let ctx = keySchedule(sharedSecret: kemSharedSecret(dh: shared, enc: enc, pkR: config.publicKey), info: requestLabel + [0] + hdr)
        let ct = try seal(key: ctx.key, nonce: ctx.baseNonce, request)
        return (hdr + enc + ct, ResponseContext(enc: enc, secret: export(ctx, responseLabel, secretLen)))
    }

    /// Gateway: decrypt an Encapsulated Request (tests and the mock gateway).
    public static func decapsulateRequest(_ keys: [GatewayKey], _ e: [UInt8]) throws -> (request: [UInt8], context: ResponseContext) {
        guard e.count >= 7 + nenc + 16 else { throw Failure.format }
        let kem = Int(e[1]) << 8 | Int(e[2]), kdf = Int(e[3]) << 8 | Int(e[4]), aead = Int(e[5]) << 8 | Int(e[6])
        guard let key = keys.first(where: { $0.config.keyId == e[0] }), kem == kemX25519, kdf == kdfHkdfSha256, aead == aeadAes128Gcm else {
            throw Failure.key
        }
        let hdr = Array(e[0..<7]), enc = Array(e[7..<(7 + nenc)]), ct = Array(e[(7 + nenc)...])
        do {
            let shared = try dh(key.privateKey, enc)
            let ctx = keySchedule(sharedSecret: kemSharedSecret(dh: shared, enc: enc, pkR: key.config.publicKey), info: requestLabel + [0] + hdr)
            let request = try open(key: ctx.key, nonce: ctx.baseNonce, ct)
            return (request, ResponseContext(enc: enc, secret: export(ctx, responseLabel, secretLen)))
        } catch {
            throw Failure.decrypt
        }
    }

    static func responseKeys(_ c: ResponseContext, _ nonce: [UInt8]) -> (key: [UInt8], nonce: [UInt8]) {
        let prk = hkdfExtract(salt: c.enc + nonce, ikm: c.secret)
        return (hkdfExpand(prk: prk, info: utf8("key"), length: nk), hkdfExpand(prk: prk, info: utf8("nonce"), length: nn))
    }

    /// Gateway: encrypt a Binary HTTP response. `responseNonce` is a test seam.
    public static func encapsulateResponse(_ c: ResponseContext, _ response: [UInt8], responseNonce: [UInt8]? = nil) throws -> [UInt8] {
        var nonce = responseNonce ?? []
        if nonce.isEmpty {
            nonce = [UInt8](repeating: 0, count: secretLen)
            _ = SecRandomCopyBytes(kSecRandomDefault, secretLen, &nonce)
        }
        let k = responseKeys(c, nonce)
        return nonce + (try seal(key: k.key, nonce: k.nonce, response))
    }

    /// Client: decrypt an Encapsulated Response.
    public static func decapsulateResponse(_ c: ResponseContext, _ e: [UInt8]) throws -> [UInt8] {
        guard e.count >= secretLen + 16 else { throw Failure.format }
        let k = responseKeys(c, Array(e[0..<secretLen]))
        do { return try open(key: k.key, nonce: k.nonce, Array(e[secretLen...])) } catch { throw Failure.decrypt }
    }
}

// MARK: - Binary HTTP, known-length (RFC 9292)

public struct BhttpRequest: Equatable, Sendable {
    public var method: String
    public var scheme: String
    public var authority: String
    public var path: String
    public var headers: [(String, String)]
    public var body: [UInt8]
    public init(method: String, scheme: String = "https", authority: String, path: String, headers: [(String, String)] = [], body: [UInt8] = []) {
        self.method = method; self.scheme = scheme; self.authority = authority; self.path = path; self.headers = headers; self.body = body
    }
    public static func == (a: Self, b: Self) -> Bool {
        a.method == b.method && a.scheme == b.scheme && a.authority == b.authority && a.path == b.path && a.body == b.body
            && a.headers.map { [$0.0, $0.1] } == b.headers.map { [$0.0, $0.1] }
    }
}

public struct BhttpResponse: Equatable, Sendable {
    public var status: Int
    public var headers: [(String, String)]
    public var body: [UInt8]
    public init(status: Int, headers: [(String, String)] = [], body: [UInt8] = []) { self.status = status; self.headers = headers; self.body = body }
    public static func == (a: Self, b: Self) -> Bool {
        a.status == b.status && a.body == b.body && a.headers.map { [$0.0, $0.1] } == b.headers.map { [$0.0, $0.1] }
    }
    /// The first value of `name` (case-insensitive).
    public func header(_ name: String) -> String? { headers.first { $0.0.lowercased() == name.lowercased() }?.1 }
}

public enum Bhttp {
    static func varint(_ n: Int) throws -> [UInt8] {
        if n < 0x40 { return [UInt8(n)] }
        if n < 0x4000 { return [UInt8(0x40 | (n >> 8)), UInt8(n & 0xff)] }
        if n < 0x4000_0000 { return [UInt8(0x80 | (n >> 24)), UInt8((n >> 16) & 0xff), UInt8((n >> 8) & 0xff), UInt8(n & 0xff)] }
        throw Ohttp.Failure.format
    }

    static func lp(_ b: [UInt8]) throws -> [UInt8] { try varint(b.count) + b }

    static func fieldSection(_ headers: [(String, String)]) throws -> [UInt8] {
        var inner: [UInt8] = []
        for (n, v) in headers { inner += try lp(Array(n.lowercased().utf8)) + lp(Array(v.utf8)) }
        return try lp(inner)
    }

    public static func encode(_ r: BhttpRequest) throws -> [UInt8] {
        try varint(0) + lp(Array(r.method.utf8)) + lp(Array(r.scheme.utf8)) + lp(Array(r.authority.utf8)) + lp(Array(r.path.utf8))
            + fieldSection(r.headers) + lp(r.body) + varint(0)
    }

    public static func encode(_ r: BhttpResponse) throws -> [UInt8] {
        try varint(1) + varint(r.status) + fieldSection(r.headers) + lp(r.body) + varint(0)
    }

    struct Reader {
        let b: [UInt8]
        var o = 0
        var done: Bool { o >= b.count }
        mutating func varint() throws -> Int {
            guard o < b.count else { throw Ohttp.Failure.format }
            let first = b[o], len = 1 << Int(first >> 6)
            guard o + len <= b.count, len != 8 else { throw Ohttp.Failure.format }
            var v = Int(first & 0x3f)
            if len > 1 { for i in 1..<len { v = v * 256 + Int(b[o + i]) } }
            o += len
            return v
        }
        mutating func bytes() throws -> [UInt8] {
            let n = try varint()
            guard o + n <= b.count else { throw Ohttp.Failure.format }
            defer { o += n }
            return Array(b[o..<(o + n)])
        }
        mutating func text() throws -> String { String(decoding: try bytes(), as: UTF8.self) }
        mutating func fields() throws -> [(String, String)] {
            if done { return [] }
            var s = Reader(b: try bytes())
            var out: [(String, String)] = []
            while !s.done { out.append((try s.text(), try s.text())) }
            return out
        }
    }

    public static func decodeRequest(_ b: [UInt8]) throws -> BhttpRequest {
        var r = Reader(b: b)
        guard try r.varint() == 0 else { throw Ohttp.Failure.format }
        let method = try r.text(), scheme = try r.text(), authority = try r.text(), path = try r.text()
        let headers = try r.fields()
        let body = r.done ? [] : try r.bytes()
        return BhttpRequest(method: method, scheme: scheme, authority: authority, path: path, headers: headers, body: body)
    }

    public static func decodeResponse(_ b: [UInt8]) throws -> BhttpResponse {
        var r = Reader(b: b)
        guard try r.varint() == 1 else { throw Ohttp.Failure.format }
        var status = try r.varint()
        while status >= 100 && status < 200 {
            _ = try r.fields()
            status = try r.varint()
        }
        let headers = try r.fields()
        let body = r.done ? [] : try r.bytes()
        return BhttpResponse(status: status, headers: headers, body: body)
    }
}
