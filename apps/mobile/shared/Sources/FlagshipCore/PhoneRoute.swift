import Foundation
import CryptoKit
import Security
import FlagshipAPI

/// The phone's bare `<account>.<apex>` name (plan H2/H3, docs/architecture-v2/phone-route.md). Byte-identical to
/// `packages/protocol/src/phoneRoute.ts` for what the phone signs and builds, pinned by
/// `packages/protocol/test-vectors/phone-route/vectors.json`:
///
///   flagship/route-claim/v1|<account>|<phoneRoutePub>|<hostname>|<generation>|<sessionNonce>|<issuedAt>
///   flagship/certificate-order/v1|phone|<device>|0|<csrSha256>|<requestId>|<issuedAt>
///
/// Both are Ed25519 by the account device key (the key the phone's admin grant names). The CSR is
/// PKCS #10 for exactly the bare name, signed by the phone's own TLS key.
public struct RouteClaim: Codable, Equatable, Sendable {
    public var account: String
    public var phoneRoutePub: String
    public var hostname: String
    public var generation: Int64
    public var sessionNonce: String
    public var issuedAt: Int64

    public init(account: String, phoneRoutePub: String, hostname: String, generation: Int64, sessionNonce: String, issuedAt: Int64) {
        self.account = account
        self.phoneRoutePub = phoneRoutePub
        self.hostname = hostname
        self.generation = generation
        self.sessionNonce = sessionNonce
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try ServingAuthority.account(account)
        try ServingAuthority.hex("phoneRoutePub", phoneRoutePub, ServingAuthority.isHex64)
        guard hostname == hostname.lowercased(), hostname.hasPrefix(account + "."), hostname.split(separator: ".").count >= 3,
              !hostname.contains("|") else { throw ServingRecordError.invalid("hostname must be the account's own bare name") }
        try ServingAuthority.int("generation", generation, min: 1)
        try ServingAuthority.hex("sessionNonce", sessionNonce, ServingAuthority.isHex32)
        try ServingAuthority.int("issuedAt", issuedAt, min: 0)
        return ServingAuthority.join([PhoneRoute.tagRouteClaim, account, phoneRoutePub, hostname, String(generation), sessionNonce, String(issuedAt)])
    }
}

public struct PhoneCertificateOrder: Equatable, Sendable {
    public var device: String
    public var csrSha256: String
    public var requestId: String
    public var issuedAt: Int64

    public init(device: String, csrSha256: String, requestId: String, issuedAt: Int64) {
        self.device = device
        self.csrSha256 = csrSha256
        self.requestId = requestId
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        try ServingAuthority.hex("device", device, ServingAuthority.isHex64)
        try ServingAuthority.hex("csrSha256", csrSha256, ServingAuthority.isHex64)
        try ServingAuthority.hex("requestId", requestId, ServingAuthority.isHex32)
        try ServingAuthority.int("issuedAt", issuedAt, min: 0)
        return ServingAuthority.join([PhoneRoute.tagCertificateOrder, "phone", device, "0", csrSha256, requestId, String(issuedAt)])
    }
}

public enum PhoneRoute {
    public static let tagRouteClaim = "flagship/route-claim/v1"
    public static let tagCertificateOrder = "flagship/certificate-order/v1"
    public static let tagRouteRelease = "flagship/route-release/v1"
    public static let tagPhonePresence = "flagship/phone-presence/v1"
    public static let claimSkewMs: Int64 = 60_000

    /// The holder's release: the fields of the claim it holds, under the release tag.
    public static func canonicalRelease(_ held: RouteClaim) throws -> Data {
        let claim = String(decoding: try held.canonicalBytes(), as: UTF8.self)
        return Data((tagRouteRelease + claim.dropFirst(tagRouteClaim.count)).utf8)
    }

    /// "I'm here": a device's hello to the phone holding the bare name.
    public static func canonicalPresence(account: String, devicePub: String, hostname: String, issuedAt: Int64) throws -> Data {
        try ServingAuthority.account(account)
        try ServingAuthority.hex("devicePub", devicePub, ServingAuthority.isHex64)
        guard hostname == hostname.lowercased(), hostname.hasPrefix(account + "."), hostname.split(separator: ".").count >= 3,
              !hostname.contains("|") else { throw ServingRecordError.invalid("hostname must be the account's own bare name") }
        try ServingAuthority.int("issuedAt", issuedAt, min: 0)
        return ServingAuthority.join([tagPhonePresence, account, devicePub, hostname, String(issuedAt)])
    }
    public static let certRenewBeforeMs: Int64 = 30 * 86_400_000
    public static let certRetryAfterMs: Int64 = 6 * 3_600_000
    public static let beatSeconds: Double = 15
    public static let sessionCookie = "__Host-flagship-phone"
    public static let csrfHeader = "x-flagship-csrf"

    private static func isAccount(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard (1...63).contains(b.count) else { return false }
        func ok(_ c: UInt8) -> Bool { (48...57).contains(c) || (97...122).contains(c) }
        return ok(b.first!) && ok(b.last!) && b.allSatisfy { ok($0) || $0 == 45 }
    }

    public static func hostname(account: String, apex: String) -> String {
        "\(account.lowercased()).\(apex.lowercased())"
    }

    /// The account when `sni` is exactly a bare `<account>.<apex>` name, else nil.
    public static func bareAccount(_ sni: String, apex: String) -> String? {
        let lower = sni.lowercased()
        let suffix = "." + apex.lowercased()
        guard lower.hasSuffix(suffix) else { return nil }
        let head = String(lower.dropLast(suffix.count))
        return isAccount(head) ? head : nil
    }

    // MARK: the begin (relay mesh, relay-mesh.md §8.2)

    /// Most grants a phone sends in `begin` (a mesh relay reads no more).
    public static let beginMaxGrants = 8

    /// The phone's own admin grant chain for `begin`, picked from `.com`'s `/api/users/:u/device-grants` body: grants
    /// naming this device key and account, signed by the admin root, with the `admin` scope and not yet expired; the
    /// latest expiry first (then the smaller grant id), at most 8. Matches the TS `phoneBeginGrants`
    /// (`phone-route/vectors.json` "begin"). The relay still verifies every one.
    public static func beginGrants(_ body: Any?, account: String, devicePub: String, now: Int64) -> [[String: Any]] {
        let listed = ((body as? [String: Any])?["grants"] as? [Any]) ?? []
        let me = devicePub.lowercased()
        let user = account.lowercased()
        func int(_ v: Any?) -> Int64? {
            guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == Double(n.int64Value) else { return nil }
            return n.int64Value
        }
        var out: [(expiresAt: Int64, grantId: String, wire: [String: Any])] = []
        for raw in listed {
            guard let g = raw as? [String: Any], let grantId = g["grantId"] as? String, let username = g["username"] as? String,
                  let deviceId = g["deviceId"] as? String, let pub = g["devicePubHex"] as? String, let rawScopes = g["scopes"] as? [Any],
                  let issuedAt = int(g["issuedAt"]), let expiresAt = int(g["expiresAt"]), let sig = g["signatureHex"] as? String,
                  sig.utf8.count == 128, sig.allSatisfy(\.isHexDigit) else { continue }
            let scopes = rawScopes.compactMap { $0 as? String }
            guard pub.lowercased() == me, username.lowercased() == user, g["signerRoot"] as? String == "admin-root",
                  scopes.contains("admin"), expiresAt > now else { continue }
            let grant: [String: Any] = ["grantId": grantId, "username": username, "deviceId": deviceId, "devicePubHex": me,
                                        "scopes": scopes, "issuedAt": issuedAt, "expiresAt": expiresAt]
            out.append((expiresAt, grantId, ["grant": grant, "signatureHex": sig.lowercased(), "signerRoot": "admin-root"]))
        }
        out.sort { $0.expiresAt != $1.expiresAt ? $0.expiresAt > $1.expiresAt : $0.grantId.utf16.lexicographicallyPrecedes($1.grantId.utf16) }
        return out.prefix(beginMaxGrants).map(\.wire)
    }

    /// `{type:"begin", account, grants}`; a relay without the mesh ignores `grants`.
    public static func beginMessage(account: String, grants: [[String: Any]]) -> [String: Any] {
        ["type": "begin", "account": account.lowercased(), "grants": grants]
    }

    public static func signEd25519(_ bytes: Data, key: Curve25519.Signing.PrivateKey) throws -> String {
        HexUtil.encode(try key.signature(for: bytes))
    }

    public static func sha256Hex(_ d: Data) -> String {
        HexUtil.encode(Data(SHA256.hash(data: d)))
    }

    /// Order now? Reuse a held certificate until 30 days before its end; back off 6 h after a failure.
    public static func needsOrder(notAfter: Int64?, lastFailureAt: Int64?, now: Int64) -> Bool {
        if let f = lastFailureAt, now - f < certRetryAfterMs { return false }
        guard let end = notAfter else { return true }
        return end - now <= certRenewBeforeMs
    }

    // MARK: the CSR (PKCS #10, ECDSA P-256, exactly one name)

    private static func len(_ n: Int) -> [UInt8] {
        if n < 0x80 { return [UInt8(n)] }
        var out: [UInt8] = []
        var v = n
        while v > 0 { out.insert(UInt8(v & 0xff), at: 0); v >>= 8 }
        return [0x80 | UInt8(out.count)] + out
    }
    private static func tlv(_ tag: UInt8, _ body: [UInt8]) -> [UInt8] { [tag] + len(body.count) + body }
    private static func oid(_ dotted: String) -> [UInt8] {
        let p = dotted.split(separator: ".").map { Int($0)! }
        var out: [UInt8] = [UInt8(40 * p[0] + p[1])]
        for v0 in p.dropFirst(2) {
            var bytes: [UInt8] = []
            var v = v0
            repeat { bytes.insert(UInt8(v & 0x7f), at: 0); v >>= 7 } while v > 0
            for i in 0..<(bytes.count - 1) { bytes[i] |= 0x80 }
            out += bytes
        }
        return tlv(0x06, out)
    }

    public enum CsrError: Error { case badKey, badName }

    /// The CertificationRequestInfo for the phone's key (65-byte uncompressed point) and its name.
    public static func csrInfo(publicKey: Data, hostname: String) throws -> Data {
        guard publicKey.count == 65, publicKey.first == 0x04 else { throw CsrError.badKey }
        guard (1...253).contains(hostname.utf8.count),
              hostname.utf8.allSatisfy({ (48...57).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 46 }) else { throw CsrError.badName }
        let ascii = Array(hostname.utf8)
        let name = tlv(0x30, tlv(0x31, tlv(0x30, oid("2.5.4.3") + tlv(0x0c, ascii))))
        let spki = tlv(0x30, tlv(0x30, oid("1.2.840.10045.2.1") + oid("1.2.840.10045.3.1.7")) + tlv(0x03, [0] + Array(publicKey)))
        let san = tlv(0x30, oid("2.5.29.17") + tlv(0x04, tlv(0x30, tlv(0x82, ascii))))
        let attr = tlv(0x30, oid("1.2.840.113549.1.9.14") + tlv(0x31, tlv(0x30, san)))
        return Data(tlv(0x30, tlv(0x02, [0]) + name + spki + tlv(0xa0, attr)))
    }

    /// The full CSR from its info and a DER ECDSA-SHA256 signature over the info.
    public static func csr(info: Data, signatureDer: Data) -> Data {
        Data(tlv(0x30, Array(info) + tlv(0x30, oid("1.2.840.10045.4.3.2")) + tlv(0x03, [0] + Array(signatureDer))))
    }
}

// MARK: the phone endpoint's request policy (Appendix H, scenario 11)

public struct PhoneEndpointRequest: Sendable {
    public var method: String
    public var host: String
    public var origin: String?
    public var sessionCookie: String?
    public var csrf: String?
    public var upgrade: Bool
    public var establish: Bool

    public init(method: String, host: String, origin: String?, sessionCookie: String?, csrf: String?, upgrade: Bool, establish: Bool = false) {
        self.method = method
        self.host = host
        self.origin = origin
        self.sessionCookie = sessionCookie
        self.csrf = csrf
        self.upgrade = upgrade
        self.establish = establish
    }
}

public enum PhoneEndpointPolicy {
    /// Mirror of `phoneEndpointCheck`: exact Host, exact Origin for anything but a plain read, host-only cookie, CSRF header.
    public static func check(_ r: PhoneEndpointRequest, hostname: String, sessionToken: String?, csrfToken: String?) -> String {
        let host = hostname.lowercased()
        if r.host.lowercased() != host { return "wrong-host" }
        let method = r.method.uppercased()
        if (method == "GET" || method == "HEAD") && !r.upgrade { return "allow" }
        if r.origin != "https://\(host)" { return "cross-origin" }
        if r.establish && method == "POST" && !r.upgrade { return "allow" }
        guard let t = sessionToken, let c = r.sessionCookie, equal(c, t) else { return "no-session" }
        guard let x = csrfToken, let h = r.csrf, equal(h, x) else { return "csrf" }
        return "allow"
    }

    public static func sessionCookie(_ token: String) -> String {
        "\(PhoneRoute.sessionCookie)=\(token); Path=/; Secure; HttpOnly; SameSite=Strict"
    }

    private static func equal(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count else { return false }
        var d: UInt8 = 0
        for i in x.indices { d |= x[i] ^ y[i] }
        return d == 0
    }
}

// MARK: HTTP (the minimal endpoint)

public struct HttpHead: Sendable {
    public var method: String
    public var path: String
    public var headers: [String: String]

    public init(method: String, path: String, headers: [String: String]) {
        self.method = method
        self.path = path
        self.headers = Dictionary(uniqueKeysWithValues: headers.map { ($0.key.lowercased(), $0.value) })
    }

    public func header(_ name: String) -> String? { headers[name.lowercased()] }

    public func cookie(_ name: String) -> String? {
        header("cookie")?.split(separator: ";").lazy.compactMap { part -> String? in
            let p = part.trimmingCharacters(in: .whitespaces)
            guard let i = p.firstIndex(of: "="), p[..<i] == name else { return nil }
            return String(p[p.index(after: i)...])
        }.first
    }

    public static func parse(_ head: String) -> HttpHead? {
        let lines = head.components(separatedBy: "\r\n")
        guard let first = lines.first else { return nil }
        let parts = first.split(separator: " ")
        guard parts.count == 3, parts[2].hasPrefix("HTTP/1.") else { return nil }
        var headers: [String: String] = [:]
        for l in lines.dropFirst() where !l.isEmpty {
            guard let i = l.firstIndex(of: ":"), i != l.startIndex else { return nil }
            headers[l[..<i].trimmingCharacters(in: .whitespaces).lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
        }
        return HttpHead(method: String(parts[0]), path: String(parts[1]), headers: headers)
    }
}

/// Collects one request (head and Content-Length body) from plaintext chunks.
public struct HttpRequestReader {
    private var buf = Data()
    private let maxBytes: Int

    public init(maxBytes: Int = 64 * 1024) { self.maxBytes = maxBytes }

    public enum ReadError: Error { case tooLarge, bad }

    public mutating func push(_ chunk: Data) throws -> (HttpHead, Data)? {
        buf.append(chunk)
        guard buf.count <= maxBytes else { throw ReadError.tooLarge }
        guard let end = buf.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let head = HttpHead.parse(String(decoding: buf[buf.startIndex..<end.lowerBound], as: UTF8.self)) else { throw ReadError.bad }
        let length = Int(head.header("content-length") ?? "0") ?? -1
        guard (0...maxBytes).contains(length) else { throw ReadError.bad }
        let bodyStart = end.upperBound
        guard buf.count - (bodyStart - buf.startIndex) >= length else { return nil }
        return (head, Data(buf[bodyStart..<(bodyStart + length)]))
    }
}

/// The endpoint's answers. Thread-safe; the tunnel feeds it whole requests and writes back what it returns.
public final class PhoneEndpointResponder: @unchecked Sendable {
    public let account: String
    public let hostname: String
    public let phoneRoutePub: String
    private let now: () -> Int64
    private let lock = NSLock()
    private var code: (value: String, expiresAt: Int64)?
    private var sessions: [String: (csrf: String, expiresAt: Int64)] = [:]
    private var seen: [String: Int64] = [:]

    /// Devices that said hello (signed presence) while this phone held the name: device key → last seen (ms).
    /// A hello proves only that its own key signed it, so only keys in the account's device book are returned.
    public func lastSeen(accountDevices: Set<String>) -> [String: Int64] { lock.withLock { seen.filter { accountDevices.contains($0.key) } } }

    /// Record a signed hello (`GET /` with the presence headers): this account's bare name, fresh, signed by the key.
    private func hello(_ head: HttpHead) -> Bool {
        guard let device = head.header("x-flagship-presence-device"), let at = Int64(head.header("x-flagship-presence-at") ?? ""),
              let sig = head.header("x-flagship-presence-sig"), abs(at - now()) <= PhoneRoute.claimSkewMs,
              let bytes = try? PhoneRoute.canonicalPresence(account: account, devicePub: device, hostname: hostname, issuedAt: at),
              ServingAuthority.verifyEd25519(bytes, signatureHex: sig, publicKeyHex: device) else { return false }
        if seen.count >= 32, seen[device] == nil, let oldest = seen.min(by: { $0.value < $1.value })?.key { seen[oldest] = nil }
        seen[device] = now()
        return true
    }

    public init(account: String, hostname: String, phoneRoutePub: String, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.account = account
        self.hostname = hostname
        self.phoneRoutePub = phoneRoutePub
        self.now = now
    }

    /// A fresh one-time code (6 digits, 5 minutes) the owner types in the browser that opens a session.
    public func newCode() -> String {
        let v = String(Int.random(in: 100_000...999_999))
        lock.withLock { code = (v, now() + 5 * 60_000) }
        return v
    }

    private static func random32() -> String {
        var b = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
        return HexUtil.encode(Data(b))
    }

    public func respond(_ head: HttpHead, body: Data) -> Data {
        lock.lock()
        defer { lock.unlock() }
        let host = head.header("host").map { String($0.split(separator: ":").first ?? "") } ?? ""
        let establish = head.method == "POST" && head.path == "/api/phone/session"
        let token = head.cookie(PhoneRoute.sessionCookie)
        let session = token.flatMap { t in sessions[t].flatMap { $0.expiresAt > now() ? $0 : nil } }
        let verdict = PhoneEndpointPolicy.check(
            PhoneEndpointRequest(method: head.method, host: host, origin: head.header("origin"), sessionCookie: token,
                                 csrf: head.header(PhoneRoute.csrfHeader), upgrade: head.header("upgrade") != nil, establish: establish),
            hostname: hostname, sessionToken: session == nil ? nil : token, csrfToken: session?.csrf)
        guard verdict == "allow" else { return Self.answer(403, #"{"code":"\#(verdict)"}"#) }
        if head.method == "GET" && head.path == "/" { return Self.answer(200, #"{"present":true,"recorded":\#(hello(head))}"#) }
        if head.method == "GET" && head.path == "/.well-known/flagship-phone" {
            return Self.answer(200, #"{"account":"\#(account)","hostname":"\#(hostname)","phoneRoutePub":"\#(phoneRoutePub)"}"#)
        }
        if establish {
            let text = String(decoding: body, as: UTF8.self)
            let typed = text.range(of: #""code"\s*:\s*"(\d{6})""#, options: .regularExpression).map { String(text[$0]).filter(\.isNumber) }
            guard let typed, let c = code, c.expiresAt > now(), typed == c.value else { return Self.answer(403, #"{"code":"bad-code"}"#) }
            code = nil
            if sessions.count >= 8, let k = sessions.keys.first { sessions[k] = nil }
            let t = Self.random32(), csrf = Self.random32()
            sessions[t] = (csrf, now() + 3_600_000)
            return Self.answer(200, #"{"csrf":"\#(csrf)"}"#, extra: "set-cookie: \(PhoneEndpointPolicy.sessionCookie(t))\r\n")
        }
        if head.method == "POST" && head.path == "/api/phone/ping" { return Self.answer(200, #"{"ok":true}"#) }
        return Self.answer(404, #"{"code":"not-found"}"#)
    }

    static func answer(_ status: Int, _ json: String, extra: String = "") -> Data {
        let reason = status == 200 ? "OK" : status == 403 ? "Forbidden" : "Not Found"
        let body = Data(json.utf8)
        let head = "HTTP/1.1 \(status) \(reason)\r\n" +
            "content-type: application/json\r\n" +
            "content-length: \(body.count)\r\n" +
            "cache-control: no-store\r\n" +
            "x-content-type-options: nosniff\r\n" +
            "content-security-policy: default-src 'none'; frame-ancestors 'none'\r\n" +
            "referrer-policy: no-referrer\r\n" +
            extra +
            "connection: close\r\n\r\n"
        return Data(head.utf8) + body
    }
}

// MARK: tunnel-protocol v1 frames

public enum TunnelFrames {
    public static let open: UInt8 = 0x01
    public static let data: UInt8 = 0x02
    public static let close: UInt8 = 0x03
    public static let closeRemote: UInt8 = 0x04
    public static let maxPayload = 1 << 20

    public struct Frame: Equatable, Sendable {
        public var streamId: UInt32
        public var type: UInt8
        public var payload: Data
    }

    public static func encode(_ streamId: UInt32, _ type: UInt8, _ payload: Data = Data()) -> Data {
        var out = Data(capacity: 9 + payload.count)
        withUnsafeBytes(of: streamId.bigEndian) { out.append(contentsOf: $0) }
        out.append(type)
        withUnsafeBytes(of: UInt32(payload.count).bigEndian) { out.append(contentsOf: $0) }
        out.append(payload)
        return out
    }

    /// Exactly one whole frame, or nil.
    public static func decode(_ d: Data) -> Frame? {
        let b = Array(d)
        guard b.count >= 9 else { return nil }
        let id = b[0..<4].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        let len = b[5..<9].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        guard len <= maxPayload, b.count == 9 + Int(len) else { return nil }
        return Frame(streamId: id, type: b[4], payload: Data(b[9...]))
    }

    /// `wss://…/tunnel` (what `.com`'s `/api/services/endpoints` names) → its `/phone-tunnel` twin.
    public static func phoneTunnelURL(_ tunnelHub: String) -> String {
        (tunnelHub.hasSuffix("/tunnel") ? String(tunnelHub.dropLast("/tunnel".count)) : tunnelHub) + "/phone-tunnel"
    }
}

// MARK: certificate issuance and reuse (H2, H7)

public enum PhoneCertAnswer: Equatable, Sendable {
    case pending(orderId: String, pollAfterMs: Int64)
    case issued(chainPem: String, notAfter: Int64)
    case failed(code: String)
}

/// The issuance API (docs/architecture-v2/issuance-service.md), behind one small interface.
public protocol PhoneCertIssuer: Sendable {
    func order(account: String, order: PhoneCertificateOrder, signature: String, csr: Data) async -> PhoneCertAnswer
    func poll(orderId: String) async -> PhoneCertAnswer
}

/// `.com`'s `POST /api/certificates/orders` and `GET /api/certificates/orders/:id`.
public struct ComPhoneCertIssuer: PhoneCertIssuer {
    let base: URL
    let session: URLSession

    public init(base: URL, session: URLSession = .shared) {
        self.base = base
        self.session = session
    }

    public func order(account: String, order: PhoneCertificateOrder, signature: String, csr: Data) async -> PhoneCertAnswer {
        var req = URLRequest(url: base.appendingPathComponent("api/certificates/orders"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        let csrB64 = csr.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let body: [String: Any] = [
            "account": account,
            "order": ["class": "phone", "device": order.device, "regGen": 0, "csrSha256": order.csrSha256, "requestId": order.requestId, "issuedAt": order.issuedAt],
            "signature": signature,
            "csr": csrB64,
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return await call(req)
    }

    public func poll(orderId: String) async -> PhoneCertAnswer {
        await call(URLRequest(url: base.appendingPathComponent("api/certificates/orders/\(orderId)")))
    }

    private func call(_ req: URLRequest) async -> PhoneCertAnswer {
        guard let (data, res) = try? await session.data(for: req),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return .failed(code: "network") }
        let status = o["status"] as? String
        if status == "issued", let pem = o["chainPem"] as? String { return .issued(chainPem: pem, notAfter: (o["notAfter"] as? NSNumber)?.int64Value ?? 0) }
        if status == "pending", let id = o["orderId"] as? String { return .pending(orderId: id, pollAfterMs: (o["pollAfterMs"] as? NSNumber)?.int64Value ?? 5_000) }
        return .failed(code: o["code"] as? String ?? "http-\((res as? HTTPURLResponse)?.statusCode ?? 0)")
    }
}

/// What the phone remembers about its certificate (public data).
public protocol PhoneCertStoring: AnyObject, Sendable {
    func chainPem(_ account: String) -> String?
    func notAfter(_ account: String) -> Int64?
    func lastFailureAt(_ account: String) -> Int64?
    func pendingOrder(_ account: String) -> String?
    func saveIssued(_ account: String, chainPem: String, notAfter: Int64)
    func savePending(_ account: String, orderId: String)
    func saveFailure(_ account: String, at: Int64)
}

public final class DefaultsPhoneCertStore: PhoneCertStoring, @unchecked Sendable {
    private let d: UserDefaults
    public init(defaults: UserDefaults = .standard) { d = defaults }
    private func k(_ a: String, _ n: String) -> String { "phone-cert.\(a.lowercased()).\(n)" }
    public func chainPem(_ a: String) -> String? { d.string(forKey: k(a, "chain")) }
    public func notAfter(_ a: String) -> Int64? { (d.object(forKey: k(a, "notAfter")) as? NSNumber)?.int64Value }
    public func lastFailureAt(_ a: String) -> Int64? { (d.object(forKey: k(a, "failedAt")) as? NSNumber)?.int64Value }
    public func pendingOrder(_ a: String) -> String? { d.string(forKey: k(a, "order")) }
    public func saveIssued(_ a: String, chainPem: String, notAfter: Int64) {
        d.set(chainPem, forKey: k(a, "chain"))
        d.set(NSNumber(value: notAfter), forKey: k(a, "notAfter"))
        d.removeObject(forKey: k(a, "failedAt"))
        d.removeObject(forKey: k(a, "order"))
    }
    public func savePending(_ a: String, orderId: String) { d.set(orderId, forKey: k(a, "order")) }
    public func saveFailure(_ a: String, at: Int64) {
        d.set(NSNumber(value: at), forKey: k(a, "failedAt"))
        d.removeObject(forKey: k(a, "order"))
    }
}

/// Orders only when due, reuses the held certificate otherwise (never one order per handover).
public struct PhoneCertManager: Sendable {
    let store: any PhoneCertStoring
    let issuer: any PhoneCertIssuer
    let now: @Sendable () -> Int64

    public init(store: any PhoneCertStoring, issuer: any PhoneCertIssuer, now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.store = store
        self.issuer = issuer
        self.now = now
    }

    /// The held chain (PEM) while it has not ended.
    public func current(_ account: String) -> String? {
        guard let pem = store.chainPem(account), let end = store.notAfter(account), end > now() else { return nil }
        return pem
    }

    /// Order when due. `publicKey` is the TLS key's uncompressed point; `signCsr` signs DER ECDSA-SHA256 with it;
    /// `leafKey` returns the uncompressed point of a chain's leaf (to refuse a chain for another key).
    public func ensure(account: String, apex: String, publicKey: Data, signCsr: (Data) throws -> Data,
                       deviceKey: Curve25519.Signing.PrivateKey, leafKey: (String) -> Data?) async -> Bool {
        guard PhoneRoute.needsOrder(notAfter: store.notAfter(account), lastFailureAt: store.lastFailureAt(account), now: now()) else { return false }
        var answer: PhoneCertAnswer
        if let pending = store.pendingOrder(account) {
            answer = await issuer.poll(orderId: pending)
        } else {
            guard let info = try? PhoneRoute.csrInfo(publicKey: publicKey, hostname: PhoneRoute.hostname(account: account, apex: apex)),
                  let sig = try? signCsr(info) else { return false }
            let csr = PhoneRoute.csr(info: info, signatureDer: sig)
            var rid = [UInt8](repeating: 0, count: 16)
            _ = SecRandomCopyBytes(kSecRandomDefault, rid.count, &rid)
            let order = PhoneCertificateOrder(device: HexUtil.encode(deviceKey.publicKey.rawRepresentation), csrSha256: PhoneRoute.sha256Hex(csr),
                                              requestId: HexUtil.encode(Data(rid)), issuedAt: now())
            guard let bytes = try? order.canonicalBytes(), let s = try? PhoneRoute.signEd25519(bytes, key: deviceKey) else { return false }
            answer = await issuer.order(account: account, order: order, signature: s, csr: csr)
        }
        let deadline = now() + 15 * 60_000
        while case .pending(let id, let wait) = answer, now() < deadline {
            store.savePending(account, orderId: id)
            try? await Task.sleep(nanoseconds: UInt64(min(max(wait, 1_000), 60_000)) * 1_000_000)
            answer = await issuer.poll(orderId: id)
        }
        switch answer {
        case .issued(let pem, let notAfter):
            guard let leaf = leafKey(pem), leaf == publicKey else {
                store.saveFailure(account, at: now())
                return false
            }
            store.saveIssued(account, chainPem: pem, notAfter: notAfter)
            return true
        case .failed:
            store.saveFailure(account, at: now())
            return false
        case .pending:
            return false
        }
    }
}
