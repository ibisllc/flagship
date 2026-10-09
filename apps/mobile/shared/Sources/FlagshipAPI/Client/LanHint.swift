import Foundation
import CryptoKit

/// STK-signed LAN hint — Swift mirror of `packages/protocol/src/lanHint.ts`
/// (docs/lan-direct.md). The box serves it to paired devices; the phone checks
/// it under the STK derived from its own UMK before dialing a local address.
/// Byte-identical canonical form, pinned by `LanHintTests` against the shared
/// vector.
public enum LanHint {
    public struct Endpoint: Codable, Equatable, Sendable {
        public let address: String
        public let port: Int
        public init(address: String, port: Int) {
            self.address = address
            self.port = port
        }
    }

    public struct Hint: Codable, Equatable, Sendable {
        public let serverDomain: String
        public let certSha256: String
        public let endpoints: [Endpoint]
        public let issuedAt: Int64
        public let expiresAt: Int64
        public init(serverDomain: String, certSha256: String, endpoints: [Endpoint], issuedAt: Int64, expiresAt: Int64) {
            self.serverDomain = serverDomain
            self.certSha256 = certSha256
            self.endpoints = endpoints
            self.issuedAt = issuedAt
            self.expiresAt = expiresAt
        }
    }

    /// `GET /api/screens/lan-hint` body.
    public struct Envelope: Codable, Sendable {
        public let hint: Hint
        public let signatureHex: String
        public init(hint: Hint, signatureHex: String) {
            self.hint = hint
            self.signatureHex = signatureHex
        }
    }

    static let tag = "flagship/lan-hint/v1"
    public static let maxTtlMs: Int64 = 24 * 60 * 60_000
    public static let maxEndpoints = 8
    static let clockSkewMs: Int64 = 5 * 60_000

    /// RFC 1918 IPv4 and fc00::/7 IPv6 only — see `isLanAddress` in lanHint.ts.
    public static func isLanAddress(_ address: String) -> Bool {
        let parts = address.split(separator: ".", omittingEmptySubsequences: false)
        if parts.count == 4 {
            var octets: [Int] = []
            for p in parts {
                guard (1...3).contains(p.count), p.allSatisfy(\.isASCII), p.allSatisfy(\.isNumber),
                      let n = Int(p), n <= 255 else { return false }
                octets.append(n)
            }
            let (a, b) = (octets[0], octets[1])
            return a == 10 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168)
        }
        guard address.contains(":"), !address.contains("."),
              address.allSatisfy({ $0 == ":" || $0.isHexDigit }) else { return false }
        let first = address.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
        guard (1...4).contains(first.count), let h = Int(first, radix: 16) else { return false }
        return (h & 0xfe00) == 0xfc00
    }

    public static func format(_ e: Endpoint) -> String {
        e.address.contains(":") ? "[\(e.address.lowercased())]:\(e.port)" : "\(e.address):\(e.port)"
    }

    public static func canonical(_ h: Hint) -> Data {
        let endpoints = h.endpoints.map(format).sorted().joined(separator: ",")
        return Data([
            tag, h.serverDomain, h.certSha256, endpoints, String(h.issuedAt), String(h.expiresAt),
        ].joined(separator: "|").utf8)
    }

    /// nil when acceptable; otherwise why the hint was refused.
    public static func reject(
        _ h: Hint,
        signature: Data,
        stkPub: Data,
        serverDomain: String,
        certSha256: String,
        nowMs: Int64
    ) -> String? {
        let sigOk = (try? Curve25519.Signing.PublicKey(rawRepresentation: stkPub))
            .map { $0.isValidSignature(signature, for: canonical(h)) } ?? false
        let hex64 = h.certSha256.count == 64 && h.certSha256.allSatisfy { $0.isHexDigit && !$0.isUppercase }
        if !sigOk { return "bad-signature" }
        if h.serverDomain.lowercased() != serverDomain.lowercased() { return "wrong-server" }
        if !hex64 || h.certSha256 != certSha256.lowercased() { return "cert-mismatch" }
        if h.issuedAt > nowMs + clockSkewMs { return "not-yet-valid" }
        if h.expiresAt <= nowMs { return "expired" }
        if h.expiresAt - h.issuedAt > maxTtlMs { return "ttl-too-long" }
        if h.endpoints.isEmpty || h.endpoints.count > maxEndpoints { return "bad-endpoint-count" }
        if h.endpoints.contains(where: { !isLanAddress($0.address) }) { return "non-lan-endpoint" }
        if h.endpoints.contains(where: { !(1...65535).contains($0.port) }) { return "bad-port" }
        return nil
    }

    static func hexDecode(_ s: String) -> Data? {
        guard s.count % 2 == 0 else { return nil }
        var out = Data(capacity: s.count / 2)
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            guard let b = UInt8(s[i..<j], radix: 16) else { return nil }
            out.append(b)
            i = j
        }
        return out
    }
}
