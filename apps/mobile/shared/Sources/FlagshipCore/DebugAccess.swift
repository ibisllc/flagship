import Foundation
import CryptoKit

/// Owner debug access (docs/recipe-delivery-and-remote-install.md "Debug
/// access"; Swift mirror of packages/protocol/src/debugAccess.ts): one SSH key
/// the box lets in as `debug` until a set time. Signed with the sensitive-order
/// key (the admin root; the IRK only on a box with none pinned).
///
///   flagship/debug-access/v2|<serverDomain>|<sshPublicKey>|<issuedAt>|<expiresAt>
///   flagship/debug-access-revoke/v1|<serverDomain>|<issuedAt>
///
/// Pinned by packages/protocol/test-vectors/debug-access/vectors.json.
public enum DebugAccess {
    public static let hourMs: Int64 = 60 * 60 * 1000
    public static let defaultMs: Int64 = 24 * hourMs
    public static let maxMs: Int64 = 7 * 24 * hourMs

    /// The durations the apps offer.
    public enum Duration: String, CaseIterable, Identifiable, Sendable {
        case oneHour, oneDay, sevenDays
        public var id: String { rawValue }
        public var ms: Int64 {
            switch self {
            case .oneHour: return DebugAccess.hourMs
            case .oneDay: return DebugAccess.defaultMs
            case .sevenDays: return DebugAccess.maxMs
            }
        }
        public var label: String {
            switch self {
            case .oneHour: return "1 hour"
            case .oneDay: return "24 hours"
            case .sevenDays: return "7 days"
            }
        }
    }

    public static let keyTypes: [String] = [
        "ssh-ed25519",
        "sk-ssh-ed25519@openssh.com",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "sk-ecdsa-sha2-nistp256@openssh.com",
        "ssh-rsa",
    ]

    public struct Grant: Codable, Equatable, Sendable {
        public let serverDomain: String
        /// Normalized `<type> <base64>`.
        public let sshPublicKey: String
        public let issuedAt: Int64
        public let expiresAt: Int64
        public init(serverDomain: String, sshPublicKey: String, issuedAt: Int64, expiresAt: Int64) {
            self.serverDomain = serverDomain
            self.sshPublicKey = sshPublicKey
            self.issuedAt = issuedAt
            self.expiresAt = expiresAt
        }
    }

    public struct Revoke: Codable, Equatable, Sendable {
        public let serverDomain: String
        public let issuedAt: Int64
        public init(serverDomain: String, issuedAt: Int64) {
            self.serverDomain = serverDomain
            self.issuedAt = issuedAt
        }
    }

    public enum Refusal: Error, LocalizedError, Equatable {
        case problem(String)
        public var errorDescription: String? {
            switch self { case .problem(let s): return s }
        }
    }

    // MARK: - SSH keys

    private static func keyBlob(_ body: String) -> Data? {
        guard !body.isEmpty, body.count % 4 == 0,
              body.range(of: "^[A-Za-z0-9+/]+={0,2}$", options: .regularExpression) != nil
        else { return nil }
        return Data(base64Encoded: body)
    }

    /// `<type> <base64>` (options and comment dropped), or nil when the line
    /// isn't a public key this server can use.
    public static func normalizeSshPublicKey(_ input: String) -> String? {
        let parts = input.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" }).map(String.init)
        guard let at = parts.firstIndex(where: { keyTypes.contains($0) }), at + 1 < parts.count else { return nil }
        let type = parts[at]
        let body = parts[at + 1]
        guard let blob = keyBlob(body), blob.count >= 4 + type.utf8.count, blob.count <= 4096 else { return nil }
        let b = [UInt8](blob)
        let n = (UInt32(b[0]) << 24) | (UInt32(b[1]) << 16) | (UInt32(b[2]) << 8) | UInt32(b[3])
        guard Int(n) == type.utf8.count, String(bytes: b[4..<(4 + Int(n))], encoding: .utf8) == type else { return nil }
        return "\(type) \(body)"
    }

    /// OpenSSH's `SHA256:<base64 without padding>`.
    public static func fingerprint(_ key: String) -> String? {
        guard let norm = normalizeSshPublicKey(key),
              let blob = keyBlob(String(norm.split(separator: " ")[1])) else { return nil }
        let b64 = Data(SHA256.hash(data: blob)).base64EncodedString()
        return "SHA256:" + b64.replacingOccurrences(of: "=", with: "")
    }

    // MARK: - Grants

    /// Why this grant can't be signed, as a sentence, or nil when it's fine.
    public static func grantProblem(_ g: Grant) -> String? {
        if g.serverDomain.isEmpty { return "The debug access grant doesn't name a server." }
        if g.sshPublicKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Debug access needs an SSH public key."
        }
        if normalizeSshPublicKey(g.sshPublicKey) != g.sshPublicKey {
            return "That isn't an SSH public key this server can use."
        }
        if g.issuedAt <= 0 { return "The debug access grant has no valid time." }
        if g.expiresAt <= g.issuedAt { return "Debug access has to end after it starts." }
        if g.expiresAt - g.issuedAt > maxMs { return "Debug access can be on for at most 7 days at a time." }
        return nil
    }

    private static func fieldOK(_ s: String) -> Bool {
        !s.unicodeScalars.contains { $0 == "|" || $0.value <= 0x1f || $0.value == 0x7f }
    }

    public static func canonicalBytes(_ g: Grant) throws -> Data {
        guard fieldOK(g.serverDomain), fieldOK(g.sshPublicKey) else {
            throw Refusal.problem("That debug access grant can't be signed.")
        }
        return Data("flagship/debug-access/v2|\(g.serverDomain)|\(g.sshPublicKey)|\(g.issuedAt)|\(g.expiresAt)".utf8)
    }

    public static func canonicalBytes(_ r: Revoke) throws -> Data {
        guard fieldOK(r.serverDomain) else { throw Refusal.problem("That request can't be signed.") }
        return Data("flagship/debug-access-revoke/v1|\(r.serverDomain)|\(r.issuedAt)".utf8)
    }

    /// A grant for `rawKey` (any pasted key line), refused with a sentence
    /// when the key or the times are wrong.
    public static func makeGrant(serverDomain: String, rawKey: String, issuedAt: Int64, duration: Int64) throws -> Grant {
        let trimmed = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { throw Refusal.problem("Debug access needs an SSH public key.") }
        guard let key = normalizeSshPublicKey(trimmed) else {
            throw Refusal.problem("That isn't an SSH public key this server can use.")
        }
        let g = Grant(serverDomain: serverDomain, sshPublicKey: key, issuedAt: issuedAt, expiresAt: issuedAt + duration)
        if let p = grantProblem(g) { throw Refusal.problem(p) }
        return g
    }

    /// Sign with the sensitive-order key; returns the signature hex.
    public static func sign(_ g: Grant, key: Curve25519.Signing.PrivateKey) throws -> String {
        if let p = grantProblem(g) { throw Refusal.problem(p) }
        return HexUtil.encode(try key.signature(for: canonicalBytes(g)))
    }

    public static func sign(_ r: Revoke, key: Curve25519.Signing.PrivateKey) throws -> String {
        HexUtil.encode(try key.signature(for: canonicalBytes(r)))
    }

    public static func verify(_ g: Grant, signatureHex: String, pub: Data) -> Bool {
        guard grantProblem(g) == nil, let sig = HexUtil.decode(signatureHex), let bytes = try? canonicalBytes(g),
              let pk = try? Curve25519.Signing.PublicKey(rawRepresentation: pub) else { return false }
        return pk.isValidSignature(sig, for: bytes)
    }

    public static func verify(_ r: Revoke, signatureHex: String, pub: Data) -> Bool {
        guard !r.serverDomain.isEmpty, let sig = HexUtil.decode(signatureHex), let bytes = try? canonicalBytes(r),
              let pk = try? Curve25519.Signing.PublicKey(rawRepresentation: pub) else { return false }
        return pk.isValidSignature(sig, for: bytes)
    }

    // MARK: - Wire

    /// `{grant:{serverDomain,sshPublicKey,issuedAt,expiresAt}, signatureHex}`: the
    /// recipe's `debugGrant` sibling (as a string) and the body of
    /// `POST /api/screens/debug-access`.
    public static func envelopeJSON(_ g: Grant, signatureHex: String) -> String {
        jsonString([
            "grant": [
                "serverDomain": g.serverDomain,
                "sshPublicKey": g.sshPublicKey,
                "issuedAt": g.issuedAt,
                "expiresAt": g.expiresAt,
            ],
            "signatureHex": signatureHex,
        ])
    }

    /// `{revoke:{serverDomain,issuedAt}, signatureHex}`: the body of
    /// `POST /api/screens/debug-access/revoke`.
    public static func revokeJSON(_ r: Revoke, signatureHex: String) -> String {
        jsonString([
            "revoke": ["serverDomain": r.serverDomain, "issuedAt": r.issuedAt],
            "signatureHex": signatureHex,
        ])
    }

    private static func jsonString(_ body: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]),
              let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }
}
