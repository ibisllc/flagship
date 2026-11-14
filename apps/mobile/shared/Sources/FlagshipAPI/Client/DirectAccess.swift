import Foundation
import CryptoKit

/// Direct access — Swift mirror of `packages/protocol/src/directAccess.ts`
/// (docs/direct-access-and-domains.md). The owner's admin device signs the
/// order; the box signs its address update and the v2 hint; a phone uses a
/// public endpoint only inside an order it verified itself. Pinned by
/// `packages/protocol/test-vectors/direct-access/vectors.json`.
public enum DirectAccess {
    static let tagOrder = "flagship/direct-access/v1"
    static let tagAddress = "flagship/direct-address/v1"
    static let tagHintV2 = "flagship/lan-hint/v2"
    public static let maxAddresses = 8
    public static let maxPrefixes = 4
    static let minPrefixV4 = 24
    static let minPrefixV6 = 32
    static let clockSkewMs: Int64 = 5 * 60_000

    // MARK: addresses

    public struct ParsedIp: Equatable, Sendable {
        public let family: Int
        public let bytes: [UInt8]
    }

    /// Dotted quad (no leading zeros) or IPv6 hex groups with "::"; no zone, no dotted tail.
    public static func parseIp(_ text: String) -> ParsedIp? {
        guard !text.isEmpty, text.count <= 45, text.allSatisfy(\.isASCII) else { return nil }
        if text.allSatisfy({ $0 == "." || $0.isNumber }) {
            let parts = text.split(separator: ".", omittingEmptySubsequences: false)
            guard parts.count == 4 else { return nil }
            var bytes: [UInt8] = []
            for p in parts {
                guard (1...3).contains(p.count), p == "0" || p.first != "0", let n = Int(p), n <= 255 else { return nil }
                bytes.append(UInt8(n))
            }
            return ParsedIp(family: 4, bytes: bytes)
        }
        guard text.contains(":"), text.allSatisfy({ $0 == ":" || $0.isHexDigit }) else { return nil }
        let halves = text.components(separatedBy: "::")
        guard halves.count <= 2 else { return nil }
        func groups(_ s: String) -> [String] { s.isEmpty ? [] : s.components(separatedBy: ":") }
        let head = groups(halves[0])
        let tail = halves.count == 2 ? groups(halves[1]) : []
        let all = head + tail
        guard !all.contains(where: { $0.isEmpty || $0.count > 4 }) else { return nil }
        if halves.count == 1 { guard all.count == 8 else { return nil } } else { guard all.count <= 7 else { return nil } }
        let words = (head + Array(repeating: "0", count: 8 - all.count) + tail).compactMap { UInt16($0, radix: 16) }
        guard words.count == 8 else { return nil }
        return ParsedIp(family: 6, bytes: words.flatMap { [UInt8($0 >> 8), UInt8($0 & 0xff)] })
    }

    /// Dotted quad, or RFC 5952 text.
    public static func formatIp(_ ip: ParsedIp) -> String {
        if ip.family == 4 { return ip.bytes.map(String.init).joined(separator: ".") }
        var w: [Int] = []
        for i in 0..<8 { w.append(Int(ip.bytes[2 * i]) << 8 | Int(ip.bytes[2 * i + 1])) }
        var best = -1, bestLen = 0, i = 0
        while i < 8 {
            if w[i] != 0 { i += 1; continue }
            var j = i
            while j < 8 && w[j] == 0 { j += 1 }
            if j - i > bestLen && j - i >= 2 { best = i; bestLen = j - i }
            i = j
        }
        func hex(_ a: ArraySlice<Int>) -> String { a.map { String($0, radix: 16) }.joined(separator: ":") }
        if best < 0 { return hex(w[...]) }
        return "\(hex(w[0..<best]))::\(hex(w[(best + bestLen)...]))"
    }

    public static func canonicalIp(_ text: String) -> String? { parseIp(text).map(formatIp) }

    private static func inRange(_ bytes: [UInt8], _ net: [UInt8], _ len: Int) -> Bool {
        for bit in 0..<len {
            let mask = UInt8(0x80) >> UInt8(bit & 7)
            let n = bit >> 3 < net.count ? net[bit >> 3] : 0
            if bytes[bit >> 3] & mask != n & mask { return false }
        }
        return true
    }

    private static let v4Special: [([UInt8], Int)] = [
        ([0], 8), ([10], 8), ([100, 64], 10), ([127], 8), ([169, 254], 16), ([172, 16], 12),
        ([192, 0, 0], 24), ([192, 0, 2], 24), ([192, 88, 99], 24), ([192, 168], 16), ([198, 18], 15),
        ([198, 51, 100], 24), ([203, 0, 113], 24), ([224], 4), ([240], 4),
    ]
    private static let v6Special: [([UInt8], Int)] = [
        ([0x20, 0x01, 0x00, 0x00], 23), ([0x20, 0x01, 0x0d, 0xb8], 32), ([0x20, 0x02], 16), ([0x3f, 0xff], 20),
    ]

    /// Globally routable unicast only (same rule as `addressPolicy.ts`).
    public static func isPublicAddress(_ text: String) -> Bool {
        guard let p = parseIp(text) else { return false }
        if p.family == 4 { return !v4Special.contains { inRange(p.bytes, $0.0, $0.1) } }
        guard inRange(p.bytes, [0x20], 3) else { return false }
        return !v6Special.contains { inRange(p.bytes, $0.0, $0.1) }
    }

    public struct Prefix: Equatable, Sendable {
        public let ip: ParsedIp
        public let length: Int
    }

    public static func parsePrefix(_ text: String) -> Prefix? {
        let parts = text.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, let ip = parseIp(String(parts[0])) else { return nil }
        let l = parts[1]
        guard (1...3).contains(l.count), l.allSatisfy(\.isNumber), l == "0" || l.first != "0", let length = Int(l),
              length <= ip.bytes.count * 8 else { return nil }
        for bit in length..<(ip.bytes.count * 8) where ip.bytes[bit >> 3] & (UInt8(0x80) >> UInt8(bit & 7)) != 0 {
            return nil
        }
        return Prefix(ip: ip, length: length)
    }

    public static func formatPrefix(_ p: Prefix) -> String { "\(formatIp(p.ip))/\(p.length)" }

    public static func prefixContains(_ p: Prefix, _ address: String) -> Bool {
        guard let ip = parseIp(address), ip.family == p.ip.family else { return false }
        return inRange(ip.bytes, p.ip.bytes, p.length)
    }

    // MARK: the owner's order

    public struct Order: Codable, Equatable, Sendable {
        public let serverDomain: String
        public let enabled: Bool
        public let addresses: [String]
        public let prefixes: [String]
        public let port: Int
        public let issuedAt: Int64
        public init(serverDomain: String, enabled: Bool, addresses: [String], prefixes: [String], port: Int, issuedAt: Int64) {
            self.serverDomain = serverDomain
            self.enabled = enabled
            self.addresses = addresses
            self.prefixes = prefixes
            self.port = port
            self.issuedAt = issuedAt
        }
    }

    /// The order as the box serves it beside a hint or an address update.
    public struct SignedOrder: Codable, Equatable, Sendable {
        public let order: Order
        public let signatureHex: String
        public init(order: Order, signatureHex: String) {
            self.order = order
            self.signatureHex = signatureHex
        }
    }

    /// `GET /api/screens/direct-access`.
    public struct View: Codable, Equatable, Sendable {
        public let on: Bool
        public let addresses: [String]
        public let prefixes: [String]
        public let port: Int?
        public let issuedAt: Int64?
        public let endpoints: [LanHint.Endpoint]
    }

    /// `POST /api/screens/direct-access` answer.
    public struct Change: Codable, Equatable, Sendable {
        public let ok: Bool
        public let change: String
        public let directAccess: View
    }

    /// The reason code an order can't be signed or taken, or nil.
    public static func problem(_ o: Order) -> String? {
        if o.serverDomain.isEmpty || o.serverDomain.contains(where: { $0 == "|" || $0 == "," || $0.isWhitespace }) { return "no-server" }
        if o.issuedAt <= 0 { return "bad-time" }
        if !(1...65535).contains(o.port) { return "bad-port" }
        if !o.enabled { return o.addresses.isEmpty && o.prefixes.isEmpty ? nil : "off-with-addresses" }
        if o.addresses.isEmpty && o.prefixes.isEmpty { return "no-addresses" }
        if o.addresses.count > maxAddresses || o.prefixes.count > maxPrefixes { return "too-many" }
        for a in o.addresses {
            guard let c = canonicalIp(a) else { return "bad-address" }
            if c != a { return "non-canonical-address" }
            if !isPublicAddress(a) { return "private-address" }
        }
        for p in o.prefixes {
            guard let parsed = parsePrefix(p) else { return "bad-prefix" }
            if formatPrefix(parsed) != p { return "non-canonical-address" }
            if parsed.length < (parsed.ip.family == 4 ? minPrefixV4 : minPrefixV6) { return "prefix-too-wide" }
            if !isPublicAddress(formatIp(parsed.ip)) { return "private-address" }
        }
        if Set(o.addresses).count != o.addresses.count || Set(o.prefixes).count != o.prefixes.count { return "duplicate" }
        return nil
    }

    public static func canonical(_ o: Order) -> Data {
        Data([
            tagOrder, o.serverDomain, o.enabled ? "on" : "off",
            o.addresses.sorted().joined(separator: ","), o.prefixes.sorted().joined(separator: ","),
            String(o.port), String(o.issuedAt),
        ].joined(separator: "|").utf8)
    }

    public static func orderSha256(_ o: Order) -> String {
        SHA256.hash(data: canonical(o)).map { String(format: "%02x", $0) }.joined()
    }

    /// Sign with the sensitive-order key (admin root; the IRK only where none is pinned). Callers gate it behind biometrics.
    public static func sign(_ o: Order, key: Curve25519.Signing.PrivateKey) throws -> String {
        if let why = problem(o) { throw DirectAccessError.refused(why) }
        return try key.signature(for: canonical(o)).map { String(format: "%02x", $0) }.joined()
    }

    public static func verify(_ o: Order, signatureHex: String, pub: Data) -> Bool {
        guard problem(o) == nil, let sig = LanHint.hexDecode(signatureHex), sig.count == 64,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: pub) else { return false }
        return key.isValidSignature(sig, for: canonical(o))
    }

    /// Verified under any of `authorityPubs` (the account's admin root, or its IRK when it pins none).
    public static func verify(_ s: SignedOrder, authorityPubs: [Data]) -> Bool {
        authorityPubs.contains { verify(s.order, signatureHex: s.signatureHex, pub: $0) }
    }

    public static func allows(_ o: Order, _ address: String) -> Bool {
        guard o.enabled, isPublicAddress(address), canonicalIp(address) == address else { return false }
        if o.addresses.contains(address) { return true }
        return o.prefixes.contains { parsePrefix($0).map { prefixContains($0, address) } ?? false }
    }

    // MARK: the box's address update

    public struct AddressUpdate: Codable, Equatable, Sendable {
        public let serverDomain: String
        public let orderSha256: String
        public let addresses: [String]
        public let port: Int
        public let issuedAt: Int64
        public init(serverDomain: String, orderSha256: String, addresses: [String], port: Int, issuedAt: Int64) {
            self.serverDomain = serverDomain
            self.orderSha256 = orderSha256
            self.addresses = addresses
            self.port = port
            self.issuedAt = issuedAt
        }
    }

    public static func canonical(_ u: AddressUpdate) -> Data {
        Data([tagAddress, u.serverDomain, u.orderSha256, u.addresses.sorted().joined(separator: ","), String(u.port), String(u.issuedAt)]
            .joined(separator: "|").utf8)
    }

    private static func ed25519Valid(_ sig: Data, _ msg: Data, _ pub: Data) -> Bool {
        (try? Curve25519.Signing.PublicKey(rawRepresentation: pub)).map { $0.isValidSignature(sig, for: msg) } ?? false
    }

    private static func isHex64(_ s: String) -> Bool { s.count == 64 && s.allSatisfy { $0.isHexDigit && !$0.isUppercase } }

    /// nil when acceptable; otherwise the reason. `order` must already be verified under the owner's key.
    public static func reject(_ u: AddressUpdate, signature: Data, stkPub: Data, order: Order, serverDomain: String, nowMs: Int64) -> String? {
        if !ed25519Valid(signature, canonical(u), stkPub) { return "bad-signature" }
        if u.serverDomain.lowercased() != serverDomain.lowercased() || order.serverDomain.lowercased() != u.serverDomain.lowercased() { return "wrong-server" }
        if !isHex64(u.orderSha256) || u.orderSha256 != orderSha256(order) { return "order-mismatch" }
        if !order.enabled { return "direct-access-off" }
        if u.issuedAt > nowMs + clockSkewMs { return "not-yet-valid" }
        if u.addresses.isEmpty || u.addresses.count > maxAddresses { return "bad-endpoint-count" }
        if Set(u.addresses).count != u.addresses.count { return "duplicate" }
        if u.port != order.port { return "bad-port" }
        for a in u.addresses {
            if canonicalIp(a) != a { return "non-canonical-address" }
            if !isPublicAddress(a) { return "private-address" }
            if !allows(order, a) { return "outside-grant" }
        }
        return nil
    }

    // MARK: hint v2

    public struct HintV2: Codable, Equatable, Sendable {
        public let serverDomain: String
        public let certSha256: String
        public let lan: [LanHint.Endpoint]
        public let direct: [LanHint.Endpoint]
        public let orderSha256: String
        public let issuedAt: Int64
        public let expiresAt: Int64
        public init(serverDomain: String, certSha256: String, lan: [LanHint.Endpoint], direct: [LanHint.Endpoint],
                    orderSha256: String, issuedAt: Int64, expiresAt: Int64) {
            self.serverDomain = serverDomain
            self.certSha256 = certSha256
            self.lan = lan
            self.direct = direct
            self.orderSha256 = orderSha256
            self.issuedAt = issuedAt
            self.expiresAt = expiresAt
        }
    }

    /// `GET /api/screens/lan-hint/v2` body.
    public struct HintV2Envelope: Codable, Sendable {
        public let hint: HintV2
        public let signatureHex: String
        public let directAccess: SignedOrder?
        public init(hint: HintV2, signatureHex: String, directAccess: SignedOrder?) {
            self.hint = hint
            self.signatureHex = signatureHex
            self.directAccess = directAccess
        }
    }

    public static func canonical(_ h: HintV2) -> Data {
        Data([
            tagHintV2, h.serverDomain, h.certSha256,
            h.lan.map(LanHint.format).sorted().joined(separator: ","),
            h.direct.map(LanHint.format).sorted().joined(separator: ","),
            h.orderSha256, String(h.issuedAt), String(h.expiresAt),
        ].joined(separator: "|").utf8)
    }

    public enum HintVerdict: Equatable, Sendable {
        case accepted(useDirect: Bool)
        case refused(String)
    }

    /// v1's rules for the whole hint; the `direct` part only inside `order` (already verified by the caller).
    public static func check(_ h: HintV2, signature: Data, stkPub: Data, serverDomain: String, certSha256: String,
                             nowMs: Int64, order: Order?) -> HintVerdict {
        if !ed25519Valid(signature, canonical(h), stkPub) { return .refused("bad-signature") }
        if h.serverDomain.lowercased() != serverDomain.lowercased() { return .refused("wrong-server") }
        if !isHex64(h.certSha256) || h.certSha256 != certSha256.lowercased() { return .refused("cert-mismatch") }
        if h.issuedAt > nowMs + clockSkewMs { return .refused("not-yet-valid") }
        if h.expiresAt <= nowMs { return .refused("expired") }
        if h.expiresAt - h.issuedAt > LanHint.maxTtlMs { return .refused("ttl-too-long") }
        if h.lan.count > LanHint.maxEndpoints || h.direct.count > maxAddresses || h.lan.isEmpty && h.direct.isEmpty {
            return .refused("bad-endpoint-count")
        }
        if (h.lan + h.direct).contains(where: { !(1...65535).contains($0.port) }) { return .refused("bad-port") }
        if h.lan.contains(where: { !LanHint.isLanAddress($0.address) }) { return .refused("non-lan-endpoint") }
        if h.direct.isEmpty { return h.orderSha256.isEmpty ? .accepted(useDirect: false) : .refused("order-mismatch") }
        if h.direct.contains(where: { canonicalIp($0.address) != $0.address || !isPublicAddress($0.address) }) {
            return .refused("private-address")
        }
        if !isHex64(h.orderSha256) { return .refused("order-mismatch") }
        guard let order else { return h.lan.isEmpty ? .refused("direct-without-order") : .accepted(useDirect: false) }
        if orderSha256(order) != h.orderSha256 || order.serverDomain.lowercased() != h.serverDomain.lowercased() {
            return .refused("order-mismatch")
        }
        if !order.enabled { return .refused("direct-access-off") }
        for e in h.direct {
            if e.port != order.port { return .refused("bad-port") }
            if !allows(order, e.address) { return .refused("outside-grant") }
        }
        return .accepted(useDirect: true)
    }
}

public enum DirectAccessError: Error, Equatable {
    case refused(String)
}
