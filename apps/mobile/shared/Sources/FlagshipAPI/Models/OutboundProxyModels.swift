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
        public let lastError: String?

        public init(state: String, since: Int64, lastError: String? = nil) {
            self.state = state
            self.since = since
            self.lastError = lastError
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
