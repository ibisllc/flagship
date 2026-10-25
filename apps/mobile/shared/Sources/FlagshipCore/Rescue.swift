import Foundation
import CryptoKit

/// Data rescue and basic offline control (docs/data-sovereignty.md): the messages the owner's phone
/// and its box exchange on the local network with `.com` and the relay out of reach. Wire parity with
/// packages/protocol/src/rescue.ts; pinned by packages/protocol/test-vectors/rescue/*.json.
///
///   flagship/rescue-hello/v1|<serverDomain>|<clientNonce>|<boxNonce>|<certSha256>|<issuedAt>      (box STK)
///   flagship/rescue-session/v1|<serverDomain>|<clientNonce>|<boxNonce>|<certSha256>|<issuedAt>    (owner)
///   flagship/offline-control/v1|<serverDomain>|<sessionNonce>|<action>|<target>|<nonce>|<issuedAt> (owner)
///
/// The phone trusts the box by its PINNED key (ServerKeyPins), never by DNS or a certificate
/// authority: the hello names the leaf certificate the connection presented, so a machine in the
/// middle (which must present another one) is caught before the phone signs anything.
public enum Rescue {
    public static let helloTag = "flagship/rescue-hello/v1"
    public static let sessionTag = "flagship/rescue-session/v1"
    public static let controlTag = "flagship/offline-control/v1"
    static let discoveryTag = "flagship/lan-discovery/v1"
    /// A hello and the order that answers it are good for this long.
    public static let helloTtlMs: Int64 = 2 * 60_000
    static let clockSkewMs: Int64 = 2 * 60_000
    /// The Bonjour service type a box announces (lanDiscovery.ts).
    public static let serviceType = "_flagship._tcp"

    public struct Invalid: Error, Equatable { public let reason: String }

    /// One hello, and the session order that answers it (same fields, another tag).
    public struct Exchange: Codable, Equatable, Sendable {
        public var serverDomain: String
        public var clientNonce: String
        public var boxNonce: String
        public var certSha256: String
        public var issuedAt: Int64

        public init(serverDomain: String, clientNonce: String, boxNonce: String, certSha256: String, issuedAt: Int64) {
            self.serverDomain = serverDomain; self.clientNonce = clientNonce; self.boxNonce = boxNonce
            self.certSha256 = certSha256; self.issuedAt = issuedAt
        }

        func canonical(_ tag: String) throws -> Data {
            guard !serverDomain.isEmpty, Rescue.clean(serverDomain) else { throw Invalid(reason: "serverDomain") }
            guard Rescue.isHex(clientNonce, 32) else { throw Invalid(reason: "clientNonce") }
            guard Rescue.isHex(boxNonce, 32) else { throw Invalid(reason: "boxNonce") }
            guard Rescue.isHex(certSha256, 64) else { throw Invalid(reason: "certSha256") }
            guard issuedAt >= 0, issuedAt <= (1 << 53) - 1 else { throw Invalid(reason: "issuedAt") }
            return Data([tag, serverDomain, clientNonce, boxNonce, certSha256, String(issuedAt)].joined(separator: "|").utf8)
        }

        public func helloCanonical() throws -> Data { try canonical(Rescue.helloTag) }
        public func sessionCanonical() throws -> Data { try canonical(Rescue.sessionTag) }
    }

    /// What the phone checks before it signs anything: the hello is signed by the server's pinned
    /// key, answers this phone's nonce, is current, and names the certificate this connection
    /// presented. Returns the refusal, or nil when the hello is good.
    public static func checkHello(_ h: Exchange, signature: Data, stkPub: Data, serverDomain: String, clientNonce: String,
                                  seenCertSha256: String, now: Int64) -> String? {
        guard let bytes = try? h.helloCanonical(), let key = try? Curve25519.Signing.PublicKey(rawRepresentation: stkPub),
              signature.count == 64, key.isValidSignature(signature, for: bytes)
        else { return "bad-signature" }
        if h.serverDomain.lowercased() != serverDomain.lowercased() { return "wrong-server" }
        if h.clientNonce != clientNonce { return "wrong-nonce" }
        if h.certSha256 != seenCertSha256.lowercased() { return "cert-mismatch" }
        if h.issuedAt > now + clockSkewMs { return "not-yet-valid" }
        if now - h.issuedAt > helloTtlMs { return "expired" }
        return nil
    }

    /// The hello's post-quantum half, checked under the pinned STK and the ML-DSA key it vouched for.
    /// `strict`: the phone holds this server as strict, so a hello without a good hybrid half is
    /// refused. A hybrid half that is sent must always verify.
    public static func checkHelloPq(_ h: Exchange, pqSignature: SignatureEnvelope?, stkHex: String, pinnedMldsaHex: String?,
                                    strict: Bool) -> String? {
        guard let pq = pqSignature else { return strict ? "strict-requires-hybrid" : nil }
        guard let mldsa = pinnedMldsaHex else { return strict ? "strict-requires-binding" : nil }
        guard pq.suite == "hybrid-ed25519-mldsa65/v1", let sig = PqBin.unhex(pq.signature.lowercased()), sig.count == PqHybrid.sigLen,
              let pk = PqBin.unhex(stkHex.lowercased() + mldsa.lowercased()), let msg = try? h.helloCanonical()
        else { return "bad-signature" }
        do {
            try PqHybrid.hybridVerify(publicKey: pk, purpose: helloTag, payload: [UInt8](msg), signature: sig)
            return nil
        } catch {
            return "bad-signature"
        }
    }

    /// The opaque id a box announces on its local network: the first 8 bytes of
    /// HMAC-SHA256(key = its STK public key, "flagship/lan-discovery/v1|" + lowercase name), hex.
    public static func discoveryId(stkPub: Data, serverDomain: String) -> String? {
        guard clean(serverDomain) else { return nil }
        let mac = HMAC<SHA256>.authenticationCode(for: Data("\(discoveryTag)|\(serverDomain.lowercased())".utf8), using: SymmetricKey(data: stkPub))
        return Data(mac).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    public static func newNonce() -> String {
        (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }

    static func clean(_ s: String) -> Bool {
        !s.unicodeScalars.contains { $0.value == 0x7c || $0.value <= 0x1f || $0.value == 0x7f }
    }

    static func isHex(_ s: String, _ n: Int) -> Bool {
        s.utf8.count == n && s.unicodeScalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    static func isLabel(_ s: Substring) -> Bool {
        guard let first = s.unicodeScalars.first, s.utf8.count <= 63 else { return false }
        let ok: (Unicode.Scalar) -> Bool = { ("a"..."z").contains($0) || ("0"..."9").contains($0) }
        return ok(first) && s.unicodeScalars.allSatisfy { ok($0) || $0 == "-" }
    }

    /// `<creator>--<slug>` or a bare `<slug>`, each half a lowercase DNS label.
    public static func isServiceId(_ id: String) -> Bool {
        let parts = id.components(separatedBy: "--")
        return parts.count <= 2 && parts.allSatisfy { isLabel(Substring($0)) }
    }
}

/// One offline action, signed by the owner (the admin root where the box pins one), bound to the
/// rescue session it is sent on, fresh and spent once by the box.
public struct OfflineControlOrder: Codable, Equatable, Sendable {
    public enum Action: String, Codable, CaseIterable, Sendable {
        case appStart = "app-start"
        case appStop = "app-stop"
        case appRestart = "app-restart"
        case serverRestart = "server-restart"
        case serverShutdown = "server-shutdown"

        public var isServerAction: Bool { self == .serverRestart || self == .serverShutdown }
    }

    public var serverDomain: String
    /// The box nonce of the hello this session answered (`GET /api/rescue/server` names it).
    public var sessionNonce: String
    public var action: String
    /// The app's service id, or the server's own name for a server action.
    public var target: String
    public var nonce: String
    public var issuedAt: Int64

    public init(serverDomain: String, sessionNonce: String, action: Action, target: String, nonce: String = Rescue.newNonce(), issuedAt: Int64) {
        self.serverDomain = serverDomain; self.sessionNonce = sessionNonce; self.action = action.rawValue
        self.target = target; self.nonce = nonce; self.issuedAt = issuedAt
    }

    public init(serverDomain: String, sessionNonce: String, actionName: String, target: String, nonce: String, issuedAt: Int64) {
        self.serverDomain = serverDomain; self.sessionNonce = sessionNonce; self.action = actionName
        self.target = target; self.nonce = nonce; self.issuedAt = issuedAt
    }

    public func canonicalBytes() throws -> Data {
        guard !serverDomain.isEmpty, serverDomain == serverDomain.lowercased(), Rescue.clean(serverDomain) else { throw Rescue.Invalid(reason: "serverDomain") }
        guard Rescue.isHex(sessionNonce, 32) else { throw Rescue.Invalid(reason: "sessionNonce") }
        guard let a = Action(rawValue: action) else { throw Rescue.Invalid(reason: "action") }
        if a.isServerAction {
            guard target == serverDomain else { throw Rescue.Invalid(reason: "target") }
        } else {
            guard Rescue.isServiceId(target) else { throw Rescue.Invalid(reason: "target") }
        }
        guard Rescue.isHex(nonce, 32) else { throw Rescue.Invalid(reason: "nonce") }
        guard issuedAt >= 0, issuedAt <= (1 << 53) - 1 else { throw Rescue.Invalid(reason: "issuedAt") }
        return Data([Rescue.controlTag, serverDomain, sessionNonce, action, target, nonce, String(issuedAt)].joined(separator: "|").utf8)
    }
}
