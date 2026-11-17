import Foundation

/// A box's outbound proxy order as it travels (docs/outbound-proxy.md): in the
/// recipe as the unsigned `outboundProxy` sibling, and in
/// `POST /api/screens/outbound-proxy`. Field names match
/// `packages/protocol/src/boxProxy.ts`.
public struct BoxProxyFields: Codable, Equatable, Sendable {
    public let serverDomain: String
    /// "none", "socks5" or "http".
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
}

public struct SignedBoxProxyWire: Codable, Equatable, Sendable {
    public let proxy: BoxProxyFields
    public let signature: String

    public init(proxy: BoxProxyFields, signature: String) {
        self.proxy = proxy
        self.signature = signature
    }
}

/// Never signed; sent beside the order over the paired session, or in the
/// recipe only when the owner typed them there.
public struct BoxProxyCredentials: Codable, Equatable, Sendable {
    public let username: String
    public let password: String

    public init(username: String, password: String) {
        self.username = username
        self.password = password
    }
}

/// `POST /api/screens/outbound-proxy`. `credentials` is omitted when nil, so
/// the box keeps the ones it holds for an unchanged proxy.
public struct OutboundProxySetRequest: Codable, Equatable, Sendable {
    public let proxy: BoxProxyFields
    public let signature: String
    public let credentials: BoxProxyCredentials?

    public init(proxy: BoxProxyFields, signature: String, credentials: BoxProxyCredentials? = nil) {
        self.proxy = proxy
        self.signature = signature
        self.credentials = credentials
    }
}

/// What the box reports about its proxy (`GET /api/screens/outbound-proxy`
/// and `server-detail.outboundProxy`). The password is never returned.
public struct OutboundProxySummary: Codable, Equatable, Sendable {
    public struct Proxy: Codable, Equatable, Sendable {
        public let kind: String
        public let host: String
        public let port: Int
        public let auth: Bool
        public let fallbackDirect: Bool
        public let issuedAt: Int64

        public init(kind: String, host: String, port: Int, auth: Bool, fallbackDirect: Bool, issuedAt: Int64) {
            self.kind = kind
            self.host = host
            self.port = port
            self.auth = auth
            self.fallbackDirect = fallbackDirect
            self.issuedAt = issuedAt
        }
    }

    public struct Status: Codable, Equatable, Sendable {
        /// "direct", "ok", "failing" or "fallback".
        public let state: String
        public let since: Int64
        /// The box's own English line; the apps show the sentence for `code` instead.
        public let lastError: String?
        /// `unreachable`, `auth`, `refused` or `protocol` while failing; absent from older boxes.
        public let code: String?

        public init(state: String, since: Int64, lastError: String? = nil, code: String? = nil) {
            self.state = state
            self.since = since
            self.lastError = lastError
            self.code = code
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = try c.decode(String.self, forKey: .state)
            since = (try? c.decodeIfPresent(Int64.self, forKey: .since)) ?? 0
            lastError = (try? c.decodeIfPresent(String.self, forKey: .lastError)) ?? nil
            code = (try? c.decodeIfPresent(String.self, forKey: .code)) ?? nil
        }
    }

    public let proxy: Proxy?
    public let hasCredentials: Bool
    public let status: Status
    /// False once `.com` has told the box the account is on Free: the proxy is
    /// part of Pro, so the box takes no new one (turning it off still works).
    /// Absent from older boxes.
    public let available: Bool?

    public init(proxy: Proxy?, hasCredentials: Bool, status: Status, available: Bool? = nil) {
        self.proxy = proxy
        self.hasCredentials = hasCredentials
        self.status = status
        self.available = available
    }
}

public struct OutboundProxySetResponse: Codable, Equatable, Sendable {
    public let ok: Bool?
    public let outboundProxy: OutboundProxySummary?

    public init(ok: Bool?, outboundProxy: OutboundProxySummary?) {
        self.ok = ok
        self.outboundProxy = outboundProxy
    }
}

/// The fallback lane (`POST /api/server/<domain>/proxy-order` on `.com`): the
/// same signed order, never credentials, so the owner can fix or clear a proxy
/// whose failure keeps the box offline. `.com` verifies the signature and the
/// box picks it up on its next check.
public struct OutboundProxyLaneRequest: Codable, Equatable, Sendable {
    public let proxy: BoxProxyFields
    public let signature: String
    public init(proxy: BoxProxyFields, signature: String) {
        self.proxy = proxy
        self.signature = signature
    }
}
