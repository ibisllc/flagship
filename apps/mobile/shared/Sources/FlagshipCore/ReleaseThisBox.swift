import Foundation
import CryptoKit
import FlagshipAPI

/// "Release this box" (docs/retail-box-setup.md §8.2; Swift mirror of packages/protocol/src/boxRelease.ts):
/// the account's admin root orders a retail box wiped back to unclaimed. Releasing always wipes.
///
///   flagship/box-release/v1|<serverDomain>|<stkPubHex>|<issuedAt>|<nonceHex>
///
/// Signed by the admin root only. A strict box also needs the admin root's hybrid signature over
/// the same bytes (`pqSignature`). Pinned by packages/protocol/test-vectors/box-release/vectors.json.
public enum ReleaseThisBox {
    public static let tag = "flagship/box-release/v1"
    public static let hybridSuite = "hybrid-ed25519-mldsa65/v1"

    public struct Order: Equatable, Sendable {
        public let serverDomain: String
        public let stkPubHex: String
        public let issuedAt: Int64
        public let nonceHex: String
        public init(serverDomain: String, stkPubHex: String, issuedAt: Int64, nonceHex: String) {
            self.serverDomain = serverDomain
            self.stkPubHex = stkPubHex
            self.issuedAt = issuedAt
            self.nonceHex = nonceHex
        }
    }

    public enum Problem: String, Error, Equatable { case domain, stk, time, nonce }

    public static func problem(_ o: Order) -> Problem? {
        if o.serverDomain.range(of: #"^[a-z0-9][a-z0-9.-]{0,252}$"#, options: .regularExpression) == nil { return .domain }
        if o.stkPubHex.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) == nil { return .stk }
        if o.issuedAt <= 0 { return .time }
        if o.nonceHex.range(of: #"^[0-9a-f]{32}$"#, options: .regularExpression) == nil { return .nonce }
        return nil
    }

    public static func canonicalBytes(_ o: Order) throws -> Data {
        if let p = problem(o) { throw p }
        return Data("\(tag)|\(o.serverDomain)|\(o.stkPubHex)|\(o.issuedAt)|\(o.nonceHex)".utf8)
    }

    /// An order for this box, now, with a fresh nonce.
    public static func make(serverDomain: String, stkPubHex: String, issuedAt: Int64) -> Order {
        var nonce = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, nonce.count, &nonce)
        return Order(serverDomain: serverDomain.lowercased(), stkPubHex: stkPubHex.lowercased(), issuedAt: issuedAt, nonceHex: PqBin.hex(nonce))
    }

    public static func sign(_ o: Order, adminRoot: Curve25519.Signing.PrivateKey) throws -> String {
        PqBin.hex([UInt8](try adminRoot.signature(for: canonicalBytes(o))))
    }

    public static func verify(_ o: Order, signatureHex: String, adminRootPub: Data) -> Bool {
        guard let sig = PqBin.unhex(signatureHex), let bytes = try? canonicalBytes(o),
              let pk = try? Curve25519.Signing.PublicKey(rawRepresentation: adminRootPub) else { return false }
        return pk.isValidCheckedSignature(Data(sig), for: bytes)
    }

    public static func verifyHybrid(_ o: Order, signatureHex: String, hybridPub: [UInt8]) -> Bool {
        guard let bytes = try? canonicalBytes(o), let sig = PqBin.unhex(signatureHex) else { return false }
        return (try? PqHybrid.hybridVerify(publicKey: hybridPub, purpose: tag, payload: [UInt8](bytes), signature: sig)) != nil
    }

    /// `POST /api/screens/box-release {order, signatureHex, pqSignature?}`.
    public static func bodyJSON(_ o: Order, signatureHex: String, pqSuite: String? = nil, pqSignature: String? = nil) -> Data {
        var body: [String: Any] = [
            "order": ["serverDomain": o.serverDomain, "stkPubHex": o.stkPubHex, "issuedAt": o.issuedAt, "nonceHex": o.nonceHex] as [String: Any],
            "signatureHex": signatureHex,
        ]
        if let pqSuite, let pqSignature { body["pqSignature"] = ["suite": pqSuite, "signature": pqSignature] }
        return (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data()
    }

    /// The box's refusal code as a sentence in the owner's language.
    public static func refusal(_ code: String) -> String {
        switch code {
        case "release-not-admin", "release-no-admin-root":
            return String(localized: "Only this account's admin key can release this box.")
        case "release-needs-hybrid":
            return String(localized: "This server needs a quantum-safe signature. Turn on Quantum-safe protection on this device and try again.")
        case "release-other-server":
            return String(localized: "That order is for another server. Refresh this page and try again.")
        case "release-clock":
            return String(localized: "This device's clock is too far from the server's. Check the time and try again.")
        case "release-replayed":
            return String(localized: "That order was already used. Try again.")
        case "release-not-claimed":
            return String(localized: "This box is already released.")
        default:
            return String(localized: "The box couldn't be released. Try again in a moment.")
        }
    }
}
