import Foundation
import CryptoKit
import FlagshipAPI

/// A box's outbound proxy order (docs/outbound-proxy.md), byte-identical to
/// `packages/protocol/src/boxProxy.ts` (vectors in
/// `packages/protocol/test-vectors/box-proxy/`). Signed by the sensitive-order
/// key: the admin master root when this device holds one, else the account IRK.
/// Credentials are never part of it.
public struct BoxProxy: Equatable, Sendable {
    public static let tag = "flagship/box-proxy/v1"

    public enum Kind: String, CaseIterable, Sendable {
        case none
        case socks5
        case http

        public var label: String {
            switch self {
            case .none: return "None"
            case .socks5: return "SOCKS5"
            case .http: return "HTTP"
            }
        }

        public var defaultPort: Int? {
            switch self {
            case .none: return nil
            case .socks5: return 1080
            case .http: return 3128
            }
        }
    }

    public enum OrderError: Error, Equatable {
        case badServerDomain
        case badKind
        case noneCarriesNothing
        case badHost(String)
        case badPort
        case badNonce
        case badIssuedAt
    }

    public let serverDomain: String
    public let kind: String
    public let host: String
    public let port: Int
    public let auth: Bool
    public let fallbackDirect: Bool
    public let issuedAt: Int64
    public let nonce: String

    public init(serverDomain: String, kind: String, host: String, port: Int, auth: Bool,
                fallbackDirect: Bool, issuedAt: Int64, nonce: String) {
        self.serverDomain = serverDomain
        self.kind = kind
        self.host = host
        self.port = port
        self.auth = auth
        self.fallbackDirect = fallbackDirect
        self.issuedAt = issuedAt
        self.nonce = nonce
    }

    public init(_ f: BoxProxyFields) {
        self.init(serverDomain: f.serverDomain, kind: f.kind, host: f.host, port: f.port, auth: f.auth,
                  fallbackDirect: f.fallbackDirect, issuedAt: f.issuedAt, nonce: f.nonce)
    }

    public var fields: BoxProxyFields {
        BoxProxyFields(serverDomain: serverDomain, kind: kind, host: host, port: port, auth: auth,
                       fallbackDirect: fallbackDirect, issuedAt: issuedAt, nonce: nonce)
    }

    /// A fresh order for `serverDomain`. `kind == .none` turns the proxy off.
    public static func make(
        serverDomain: String,
        kind: Kind,
        host: String,
        port: Int,
        auth: Bool,
        fallbackDirect: Bool,
        now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        nonce: Data = SecretRequestCoordinator.randomNonce()
    ) -> BoxProxy {
        let off = kind == .none
        return BoxProxy(
            serverDomain: serverDomain.lowercased(),
            kind: kind.rawValue,
            host: off ? "" : normalizeHost(host),
            port: off ? 0 : port,
            auth: off ? false : auth,
            fallbackDirect: off ? false : fallbackDirect,
            issuedAt: now,
            nonce: HexUtil.encode(nonce)
        )
    }

    public func canonicalBytes() throws -> Data {
        if serverDomain.isEmpty || serverDomain != serverDomain.lowercased() || Self.hasSepOrCtrl(serverDomain) {
            throw OrderError.badServerDomain
        }
        guard let k = Kind(rawValue: kind) else { throw OrderError.badKind }
        if k == .none {
            if !host.isEmpty || port != 0 || auth || fallbackDirect { throw OrderError.noneCarriesNothing }
        } else {
            if Self.normalizeHost(host) != host {
                throw OrderError.badHost("host must be normalized (lowercase, no brackets, no trailing dot)")
            }
            if let why = Self.hostError(host) { throw OrderError.badHost(why) }
            guard (1...65535).contains(port) else { throw OrderError.badPort }
        }
        guard ServerOrder.isLowerHex(nonce, bytes: 32) else { throw OrderError.badNonce }
        guard issuedAt > 0 else { throw OrderError.badIssuedAt }
        let parts = [
            Self.tag, serverDomain, kind, host, String(port),
            auth ? "1" : "0", fallbackDirect ? "1" : "0", String(issuedAt), nonce,
        ]
        return Data(parts.joined(separator: "|").utf8)
    }

    public func sign(with key: Curve25519.Signing.PrivateKey) throws -> String {
        HexUtil.encode(try key.signature(for: canonicalBytes()))
    }

    public func verify(signatureHex: String, publicKey: Curve25519.Signing.PublicKey) -> Bool {
        guard ServerOrder.isLowerHex(signatureHex, bytes: 64),
              let sig = HexUtil.decode(signatureHex),
              let bytes = try? canonicalBytes() else { return false }
        return publicKey.isValidSignature(sig, for: bytes)
    }

    // MARK: - Shared rules (same strings as boxProxy.ts)

    /// Trim, lowercase and drop IPv6 brackets: what the apps do to typed input before signing.
    public static func normalizeHost(_ raw: String) -> String {
        var h = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if h.hasPrefix("[") && h.hasSuffix("]") && h.count >= 2 { h = String(h.dropFirst().dropLast()) }
        if h.hasSuffix(".") { h = String(h.dropLast()) }
        return h
    }

    /// Why `host` is not an acceptable proxy host, or nil. Expects normalized input.
    public static func hostError(_ host: String) -> String? {
        if host.isEmpty { return "Enter the proxy's address." }
        if host.utf16.count > 253 { return "That address is too long." }
        if host.contains(":") {
            let okChars = host.unicodeScalars.allSatisfy { isDigit($0) || ("a"..."f").contains($0) || $0 == ":" || $0 == "." }
            let n = host.utf16.count
            let parts = host.split(separator: ":", omittingEmptySubsequences: false).count
            // One colon is almost always "host:port" typed into the address field.
            return okChars && n >= 2 && n <= 45 && parts >= 3
                ? nil : "Use a host name or an IP address, without a scheme, path or port."
        }
        if isIPv4(host) { return nil }
        if host.unicodeScalars.allSatisfy({ isDigit($0) || $0 == "." }) { return "That isn't a valid IPv4 address." }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        if labels.allSatisfy({ isLabel(String($0)) }) { return nil }
        return "Use a host name or an IP address, without a scheme, path or port."
    }

    /// Why the credentials can't be used, or nil. SOCKS5 caps both at 255 bytes (RFC 1929).
    public static func credentialsError(username: String, password: String) -> String? {
        let u = username.utf8.count
        let p = password.utf8.count
        if u == 0 || p == 0 { return "Enter a username and password." }
        if u > 255 || p > 255 { return "The username and password can be at most 255 bytes each." }
        if username.contains(":") { return "The username can't contain a colon." }
        if hasCtrl(username) || hasCtrl(password) { return "The username and password can't contain control characters." }
        return nil
    }

    private static func isDigit(_ s: Unicode.Scalar) -> Bool { ("0"..."9").contains(s) }

    private static func isIPv4(_ h: String) -> Bool {
        let parts = h.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        return parts.allSatisfy { p in
            guard (1...3).contains(p.count), p.unicodeScalars.allSatisfy(isDigit) else { return false }
            if p.count > 1 && p.hasPrefix("0") { return false }
            return (Int(p) ?? 256) <= 255
        }
    }

    private static func isLabel(_ l: String) -> Bool {
        guard (1...63).contains(l.count) else { return false }
        let ok = l.unicodeScalars.allSatisfy { isDigit($0) || ("a"..."z").contains($0) || $0 == "-" }
        return ok && !l.hasPrefix("-") && !l.hasSuffix("-")
    }

    private static func hasCtrl(_ s: String) -> Bool {
        s.unicodeScalars.contains { $0.value <= 0x1f || $0.value == 0x7f }
    }

    private static func hasSepOrCtrl(_ s: String) -> Bool { s.contains("|") || hasCtrl(s) }
}
