import Foundation

// API keys for machine clients of an app: scripts, devices and other servers
// call it with `Authorization: Bearer fsk_<keyId>_<secret>`.
//
// MIRRORS: docs/app-apis.md §3
//          packages/protocol/test-vectors/app-api-key/vectors.json (every case
//          runs in AppApiKeyVectorTests)

public enum AppApiKeyScope: String, Codable, Equatable, Sendable, CaseIterable {
    /// GET / HEAD / OPTIONS only.
    case read
    /// Every method.
    case write

    public var label: String {
        switch self {
        case .read: return "Read"
        case .write: return "Read & write"
        }
    }
}

public enum AppApiKeyId {
    /// 16 random lowercase hex characters.
    public static func random() -> String {
        var rng = SystemRandomNumberGenerator()
        return (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &rng)) }.joined()
    }

    public static func isValid(_ keyId: String) -> Bool {
        keyId.utf8.count == 16 && keyId.unicodeScalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }
}

/// `flagship/app-api-key/v1|serverDomain|serviceId|keyId|scope|expiresAt|issuedAt`,
/// signed by the sensitive-order key.
public struct AppApiKeyGrant: Codable, Equatable, Sendable {
    public static let canonicalTag = "flagship/app-api-key/v1"

    public let serverDomain: String
    public let serviceId: String
    public let keyId: String
    public let scope: AppApiKeyScope
    /// Epoch ms, 0 = never. The apps always send 0: keys work until revoked.
    public let expiresAt: Int64
    public let issuedAt: Int64

    public init(serverDomain: String, serviceId: String, keyId: String, scope: AppApiKeyScope,
                expiresAt: Int64 = 0, issuedAt: Int64) {
        self.serverDomain = serverDomain
        self.serviceId = serviceId
        self.keyId = keyId
        self.scope = scope
        self.expiresAt = expiresAt
        self.issuedAt = issuedAt
    }

    public func canonicalBytes() -> Data {
        Data([Self.canonicalTag, serverDomain, serviceId, keyId, scope.rawValue, String(expiresAt), String(issuedAt)]
            .joined(separator: "|").utf8)
    }
}

/// `POST /api/screens/services/:id/api-keys` body.
public struct AppApiKeyCreateRequest: Codable, Equatable, Sendable {
    public let grant: AppApiKeyGrant
    /// Ed25519 over `grant.canonicalBytes()`, 128 lowercase hex.
    public let signature: String
    public let label: String

    public init(grant: AppApiKeyGrant, signature: String, label: String) {
        self.grant = grant
        self.signature = signature
        self.label = label
    }
}

/// The POST answer: the full key, which the box never shows again.
public struct AppApiKeyCreateResponse: Codable, Equatable, Sendable {
    public let ok: Bool?
    public let key: String?

    public init(ok: Bool? = true, key: String?) {
        self.ok = ok
        self.key = key
    }
}

/// One entry of `GET /api/screens/services/:id/api-keys`. Never the secret.
public struct AppApiKey: Codable, Equatable, Sendable, Identifiable {
    public let keyId: String
    public let label: String
    public let scope: AppApiKeyScope
    public let createdAt: Int64
    /// Nil: never used.
    public let lastUsedAt: Int64?
    /// Nil: never expires.
    public let expiresAt: Int64?

    public var id: String { keyId }

    public init(keyId: String, label: String, scope: AppApiKeyScope, createdAt: Int64,
                lastUsedAt: Int64? = nil, expiresAt: Int64? = nil) {
        self.keyId = keyId
        self.label = label
        self.scope = scope
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt.flatMap { $0 > 0 ? $0 : nil }
        self.expiresAt = expiresAt.flatMap { $0 > 0 ? $0 : nil }
    }

    private enum CodingKeys: String, CodingKey { case keyId, label, scope, createdAt, lastUsedAt, expiresAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let lastUsed = try c.decodeIfPresent(Int64.self, forKey: .lastUsedAt)
        let expires = try c.decodeIfPresent(Int64.self, forKey: .expiresAt)
        self.init(keyId: try c.decode(String.self, forKey: .keyId),
                  label: try c.decodeIfPresent(String.self, forKey: .label) ?? "",
                  scope: try c.decode(AppApiKeyScope.self, forKey: .scope),
                  createdAt: try c.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0,
                  lastUsedAt: lastUsed, expiresAt: expires)
    }

    public func isExpired(now: Date = Date()) -> Bool {
        guard let expiresAt else { return false }
        return expiresAt <= Int64(now.timeIntervalSince1970 * 1000)
    }
}

public struct AppApiKeysResponse: Codable, Equatable, Sendable {
    public let keys: [AppApiKey]
    public init(keys: [AppApiKey]) { self.keys = keys }

    private enum CodingKeys: String, CodingKey { case keys }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        keys = try c.decodeIfPresent([AppApiKey].self, forKey: .keys) ?? []
    }
}
