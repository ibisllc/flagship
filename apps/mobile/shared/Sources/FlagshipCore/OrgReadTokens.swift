import Foundation
import CryptoKit

/// A key this device can mint an org read token with: the seat it signs for and an Ed25519 signer.
public struct OrgReadTokenCredential: Sendable {
    public let seatId: String
    public let pubHex: String
    public let sign: @Sendable ([UInt8]) throws -> [UInt8]
    public init(seatId: String, pubHex: String, sign: @escaping @Sendable ([UInt8]) throws -> [UInt8]) {
        self.seatId = seatId; self.pubHex = pubHex; self.sign = sign
    }

    /// The seat member key, derived from the UMK for this org only (packages/protocol deriveOrgSeatMemberSeeds).
    public static func member(umk: [UInt8], orgId: String, seatId: String) throws -> OrgReadTokenCredential {
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: try OrgAuthority.memberSeeds(umk: umk, orgId: orgId).edSeed)
        return OrgReadTokenCredential(seatId: seatId, pubHex: OrgAuthority.hex(Array(key.publicKey.rawRepresentation))) { m in
            Array(try key.signature(for: m))
        }
    }
}

/// The org read token request (docs/account-read-token.md "Org routes", packages/protocol orgReadToken.ts).
public enum OrgReadToken {
    public static let tag = "flagship/org-read-token-request/v1"

    public static func path(orgId: String) -> String { "/api/orgs/\(orgId.lowercased())/read-token" }

    public static func seatSubject(_ seatId: String) -> String { "seat:\(seatId.lowercased())" }

    /// `TAG|orgId|subject|pubHex|issuedAt|nonceHex`.
    public static func canonicalRequest(orgId: String, subject: String, pubHex: String, issuedAt: Int64, nonceHex: String) -> [UInt8] {
        Array([tag, orgId, subject, pubHex, String(issuedAt), nonceHex].joined(separator: "|").utf8)
    }

    /// The body POSTed to `path(orgId:)`: `{request, signature}`.
    public static func requestBody(orgId: String, credential: OrgReadTokenCredential, issuedAt: Int64, nonceHex: String) throws -> [String: Any] {
        let subject = seatSubject(credential.seatId)
        let msg = canonicalRequest(orgId: orgId, subject: subject, pubHex: credential.pubHex, issuedAt: issuedAt, nonceHex: nonceHex)
        return [
            "request": ["orgId": orgId, "subject": subject, "pubHex": credential.pubHex, "issuedAt": NSNumber(value: issuedAt), "nonceHex": nonceHex] as [String: Any],
            "signature": OrgAuthority.hex(try credential.sign(msg)),
        ]
    }

    /// The org a GET of `path` reads with a token, or nil (the public plan, the invite offer, anything else).
    public static func gatedOrg(path: String) -> String? {
        let p = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        let parts = p.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard parts.count >= 4, parts[0] == "api", parts[1] == "orgs", parts[2].count == 32, parts[2].allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { return nil }
        let sub = parts[3...].joined(separator: "/")
        if sub == "plan" || sub == "read-token" || sub.hasPrefix("invites/") { return nil }
        return parts[2]
    }
}

/// This device's org read tokens: one per org, kept in memory until 10 minutes before `.com`'s expiry,
/// minted again once after a 401. Minting never prompts: `credentials` offers only keys at hand.
public final class OrgReadTokens: @unchecked Sendable {
    public static let shared = OrgReadTokens()

    public typealias Post = (_ path: String, _ body: [String: Any]) async throws -> (status: Int, json: [String: Any])

    private let lock = NSLock()
    private var cache: [String: (token: String, expiresAt: Int64)] = [:]
    private var credentials: @Sendable (String) async -> [OrgReadTokenCredential]
    private static let refreshMarginMs: Int64 = 10 * 60_000

    public init(credentials: @escaping @Sendable (String) async -> [OrgReadTokenCredential] = { _ in [] }) {
        self.credentials = credentials
    }

    public func setCredentials(_ f: @escaping @Sendable (String) async -> [OrgReadTokenCredential]) {
        lock.withLock { credentials = f }
    }

    public func forgetAll() {
        lock.withLock { cache.removeAll() }
    }

    /// A token for `orgId`, from memory or a fresh mint through `post`; nil when no key at hand mints one.
    public func token(orgId: String, fresh: Bool, now: Int64, post: Post) async -> String? {
        let key = orgId.lowercased()
        let (held, creds) = lookup(key, fresh: fresh, now: now)
        if let held { return held }
        for c in await creds(key) {
            var nonce = [UInt8](repeating: 0, count: 16)
            guard SecRandomCopyBytes(kSecRandomDefault, nonce.count, &nonce) == errSecSuccess,
                  let body = try? OrgReadToken.requestBody(orgId: key, credential: c, issuedAt: now, nonceHex: OrgAuthority.hex(nonce)),
                  let r = try? await post(OrgReadToken.path(orgId: key), body), r.status == 200,
                  let token = r.json["token"] as? String, let exp = OrgAuthority.int64(r.json["expiresAt"]) else { continue }
            keep(key, token: token, expiresAt: exp)
            return token
        }
        return nil
    }

    private func lookup(_ key: String, fresh: Bool, now: Int64) -> (String?, @Sendable (String) async -> [OrgReadTokenCredential]) {
        lock.withLock {
            if fresh { cache[key] = nil }
            if let held = cache[key], now < held.expiresAt - Self.refreshMarginMs { return (held.token, credentials) }
            return (nil, credentials)
        }
    }

    private func keep(_ key: String, token: String, expiresAt: Int64) {
        lock.withLock { cache[key] = (token, expiresAt) }
    }
}
