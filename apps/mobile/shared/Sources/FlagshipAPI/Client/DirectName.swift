import Foundation
import CryptoKit

/// Direct names — Swift mirror of `packages/protocol/src/directName.ts`
/// (docs/direct-access-and-domains.md §8). The owner's admin device signs one
/// order per name on the direct domain; `.com` publishes exactly what it says.
/// Pinned by `packages/protocol/test-vectors/direct-name/vectors.json`.
public enum DirectName {
    static let tag = "flagship/direct-name/v1"
    public static let apex = "fshp.app"

    public enum Caa: String, Codable, Sendable { case pin, off }

    public struct Order: Codable, Equatable, Sendable {
        public let name: String
        public let serverDomain: String
        public let enabled: Bool
        public let addresses: [String]
        public let caa: Caa
        public let issuedAt: Int64
        public init(name: String, serverDomain: String, enabled: Bool, addresses: [String], caa: Caa, issuedAt: Int64) {
            self.name = name
            self.serverDomain = serverDomain
            self.enabled = enabled
            self.addresses = addresses
            self.caa = caa
            self.issuedAt = issuedAt
        }
    }

    public struct SignedOrder: Codable, Equatable, Sendable {
        public let order: Order
        public let signatureHex: String
        public init(order: Order, signatureHex: String) {
            self.order = order
            self.signatureHex = signatureHex
        }
    }

    public enum Kind: Equatable, Sendable {
        case derived(slug: String, creator: String)
        case vanity
    }

    public static let reservedLabels: Set<String> = [
        "www", "webapp", "remote", "recovery", "boot", "web", "api", "app", "apps", "admin", "mail", "smtp", "imap",
        "ns", "ns1", "ns2", "dns", "relay", "status", "docs", "help", "support", "security", "abuse", "flagship",
        "flagshipserver", "fshp", "voici", "inference", "_psl",
    ]

    private static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }

    private static func isLabel(_ s: String) -> Bool { matches(s, "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$") }
    private static func isUser(_ s: String) -> Bool { matches(s, "^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$") }
    private static func isSlug(_ s: String) -> Bool { matches(s, "^[a-z0-9](?:-?[a-z0-9]){0,29}$") }

    /// The label of `name` under `apex`, or nil when it isn't exactly one valid label deeper.
    public static func labelOf(_ name: String, apex: String = apex) -> String? {
        guard name == name.lowercased(), name.hasSuffix(".\(apex)") else { return nil }
        let label = String(name.dropLast(apex.count + 1))
        return isLabel(label) ? label : nil
    }

    /// What a label is, or nil when it may not be held (reserved, punycode, two `--`, a bad half).
    public static func kind(_ label: String) -> Kind? {
        guard isLabel(label), !label.hasPrefix("xn--"), !reservedLabels.contains(label) else { return nil }
        let parts = label.components(separatedBy: "--")
        if parts.count == 1 { return .vanity }
        guard parts.count == 2, isSlug(parts[0]), isUser(parts[1]) else { return nil }
        return .derived(slug: parts[0], creator: parts[1])
    }

    /// `<slug>--<creator>.<apex>`, or nil when the label can't be held.
    public static func derivedName(slug: String, creator: String, apex: String = apex) -> String? {
        let label = "\(slug.lowercased())--\(creator.lowercased())"
        guard case .derived = kind(label) else { return nil }
        return "\(label).\(apex)"
    }

    /// The reason code an order can't be signed or taken, or nil.
    public static func problem(_ o: Order, apex: String = apex) -> String? {
        guard let label = labelOf(o.name, apex: apex), kind(label) != nil else { return "bad-name" }
        if o.serverDomain.isEmpty || o.serverDomain.contains(where: { $0 == "|" || $0 == "," || $0.isWhitespace }) { return "no-server" }
        if o.issuedAt <= 0 { return "bad-time" }
        if !o.enabled { return o.addresses.isEmpty ? nil : "off-with-addresses" }
        if o.addresses.count > DirectAccess.maxAddresses { return "too-many" }
        for a in o.addresses {
            guard let c = DirectAccess.canonicalIp(a) else { return "bad-address" }
            if c != a { return "non-canonical-address" }
            if !DirectAccess.isPublicAddress(a) { return "private-address" }
        }
        if Set(o.addresses).count != o.addresses.count { return "duplicate" }
        return nil
    }

    public static func canonical(_ o: Order) -> Data {
        Data([
            tag, o.name, o.serverDomain, o.enabled ? "on" : "off",
            o.addresses.sorted().joined(separator: ","), o.caa.rawValue, String(o.issuedAt),
        ].joined(separator: "|").utf8)
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
}
