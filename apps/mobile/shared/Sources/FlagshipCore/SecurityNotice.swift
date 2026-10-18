import Foundation
import CryptoKit

/// Security notices (docs/security-notices.md): the Swift port of
/// `packages/protocol/src/securityNotice.ts`. A notice is signed OFFLINE by
/// the cold ca-track maintainer key, never by `.com`; an app accepts one only
/// when its signer is the ca-track authority at THIS device's clock, found by
/// walking the mandate log forward from the baked pin. Everything fails
/// OPEN: an unreachable endpoint, a bad signature, an expired or malformed
/// notice, or an authority that cannot be shown locks nothing.
///
///     flagship/security-notice/v1|<signedBy>|<seq>|<kind>|<validFrom>|<validUntil>|<eventAt>|<lockFrom>|<platforms>|<advisoryId>|<deprecatesProtocol>|<reason>|<message>
///
/// The shared vectors `packages/protocol/test-vectors/security-notice` pin
/// this port to the same canonical bytes and the same decisions
/// (`SecurityNoticeVectorTests`).

/// The protocol generation this build speaks. Raise it only when a build ships
/// a breaking change to a signed message or a wire contract, and announce it
/// with a notice. A test pins it to `CLIENT_PROTOCOL_LEVEL` in TypeScript.
public let clientProtocolLevel: Int64 = 1

public struct SecurityNoticeError: Error, Equatable, Sendable {
    public let code: String
    public init(_ code: String) { self.code = code }
}

public struct SecurityNoticeMinimum: Equatable, Sendable {
    public var minBuild: Int64
    public var minProtocol: Int64
    public init(minBuild: Int64, minProtocol: Int64) {
        self.minBuild = minBuild
        self.minProtocol = minProtocol
    }
}

/// What a signature covers. A number that is not a safe non-negative integer
/// is carried as -1 so the rules, not the decoder, report it.
public struct SecurityNoticeBody: Equatable, Sendable {
    public var seq: Int64
    public var kind: String
    public var validFrom: Int64
    public var validUntil: Int64
    public var eventAt: Int64
    public var lockFrom: Int64
    public var platforms: [String: SecurityNoticeMinimum]
    public var advisoryId: String
    public var deprecatesProtocol: Int64
    public var reason: String
    public var message: String

    public init(
        seq: Int64, kind: String, validFrom: Int64, validUntil: Int64, eventAt: Int64, lockFrom: Int64,
        platforms: [String: SecurityNoticeMinimum], advisoryId: String, deprecatesProtocol: Int64,
        reason: String, message: String
    ) {
        self.seq = seq
        self.kind = kind
        self.validFrom = validFrom
        self.validUntil = validUntil
        self.eventAt = eventAt
        self.lockFrom = lockFrom
        self.platforms = platforms
        self.advisoryId = advisoryId
        self.deprecatesProtocol = deprecatesProtocol
        self.reason = reason
        self.message = message
    }
}

public struct SecurityNotice: Equatable, Sendable {
    public var body: SecurityNoticeBody
    /// lower-hex Ed25519 pubkey of the ca-track maintainer authority that signed.
    public var signedBy: String
    /// lower-hex Ed25519 signature over the canonical bytes.
    public var signature: String

    public var seq: Int64 { body.seq }
    public var kind: String { body.kind }
    public var validFrom: Int64 { body.validFrom }
    public var validUntil: Int64 { body.validUntil }
    public var eventAt: Int64 { body.eventAt }
    public var lockFrom: Int64 { body.lockFrom }
    public var platforms: [String: SecurityNoticeMinimum] { body.platforms }
    public var advisoryId: String { body.advisoryId }
    public var reason: String { body.reason }
    public var message: String { body.message }

    public init(body: SecurityNoticeBody, signedBy: String, signature: String) {
        self.body = body
        self.signedBy = signedBy
        self.signature = signature
    }
}

public enum SecurityNoticeRules {
    public static let tag = "flagship/security-notice/v1"
    /// A notice is valid for at most this long, so a replayed one cannot lock forever.
    public static let maxWindowMs: Int64 = 30 * 24 * 3600_000
    public static let maxMessage = 280
    public static let maxReason = 160
    static let maxSafe: Int64 = 9_007_199_254_740_991
    static let kinds = ["none", "maintenance", "update-advisory", "update-required"]
    static let platformNames = ["android", "ios", "web"]

    static func isUint(_ v: Int64) -> Bool { v >= 0 && v <= maxSafe }

    private static func isLowerHex(_ s: String, _ length: Int) -> Bool {
        guard s.utf8.count == length else { return false }
        return s.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }
    static func isHex64(_ s: String) -> Bool { isLowerHex(s, 64) }
    static func isHex128(_ s: String) -> Bool { isLowerHex(s, 128) }

    private static func textProblem(_ s: String, _ max: Int) -> Bool {
        if s.utf16.count > max { return true }
        for u in s.unicodeScalars where u.value == 0x7c || u.value <= 0x1f || u.value == 0x7f { return true }
        return false
    }

    /// `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
    private static func isAdvisoryId(_ s: String) -> Bool {
        let bytes = Array(s.utf8)
        guard (1...64).contains(bytes.count) else { return false }
        func alnum(_ c: UInt8) -> Bool {
            (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
        }
        guard alnum(bytes[0]) else { return false }
        return bytes.dropFirst().allSatisfy { alnum($0) || $0 == 0x2e || $0 == 0x5f || $0 == 0x2d }
    }

    /// Check the whole rule set and return the bytes to sign. Throws a
    /// `SecurityNoticeError` whose code names the first rule broken.
    public static func canonical(_ b: SecurityNoticeBody, signedBy: String) throws -> Data {
        if !isHex64(signedBy) { throw SecurityNoticeError("bad-signer") }
        if !isUint(b.seq) || b.seq < 1 { throw SecurityNoticeError("bad-seq") }
        if !kinds.contains(b.kind) { throw SecurityNoticeError("bad-kind") }
        if !isUint(b.validFrom) || !isUint(b.validUntil) { throw SecurityNoticeError("bad-time") }
        if b.validUntil <= b.validFrom { throw SecurityNoticeError("window-order") }
        if b.validUntil - b.validFrom > maxWindowMs { throw SecurityNoticeError("window-too-long") }
        if !isUint(b.eventAt) { throw SecurityNoticeError("bad-event-at") }
        if b.eventAt != 0 && (b.eventAt < b.validFrom || b.eventAt > b.validUntil) {
            throw SecurityNoticeError("bad-event-at")
        }
        if !isUint(b.lockFrom) { throw SecurityNoticeError("bad-lock-from") }
        if !isUint(b.deprecatesProtocol) { throw SecurityNoticeError("bad-deprecates") }

        var entries: [(String, SecurityNoticeMinimum)] = []
        for name in b.platforms.keys {
            guard platformNames.contains(name) else { throw SecurityNoticeError("bad-platforms") }
            let m = b.platforms[name]!
            guard isUint(m.minBuild), isUint(m.minProtocol) else { throw SecurityNoticeError("bad-minimum") }
            entries.append((name, m))
        }
        entries.sort { $0.0 < $1.0 }
        let platforms = entries.map { "\($0.0):\($0.1.minBuild):\($0.1.minProtocol)" }.joined(separator: ",")

        if textProblem(b.advisoryId, 64) { throw SecurityNoticeError("bad-advisory") }
        if !b.advisoryId.isEmpty && !isAdvisoryId(b.advisoryId) { throw SecurityNoticeError("bad-advisory") }
        if textProblem(b.reason, maxReason) { throw SecurityNoticeError("bad-reason") }
        if textProblem(b.message, maxMessage) { throw SecurityNoticeError("bad-message") }
        if b.message.contains("://") { throw SecurityNoticeError("message-has-link") }
        if b.reason.contains("://") { throw SecurityNoticeError("message-has-link") }
        if b.message.contains("{date}") && b.eventAt == 0 { throw SecurityNoticeError("date-token-needs-event") }

        let carriesMinimums = b.kind == "update-advisory" || b.kind == "update-required"
        if b.kind == "none" {
            if !entries.isEmpty { throw SecurityNoticeError("platforms-not-allowed") }
            if !b.message.isEmpty { throw SecurityNoticeError("message-not-allowed") }
            if b.eventAt != 0 { throw SecurityNoticeError("bad-event-at") }
        } else if b.message.isEmpty {
            throw SecurityNoticeError("message-required")
        }
        if carriesMinimums {
            if entries.isEmpty { throw SecurityNoticeError("platforms-required") }
            for (_, m) in entries where m.minBuild == 0 && m.minProtocol == 0 {
                throw SecurityNoticeError("minimum-required")
            }
        } else {
            for (_, m) in entries where m.minBuild != 0 || m.minProtocol != 0 {
                throw SecurityNoticeError("minimum-not-allowed")
            }
        }
        if b.kind == "update-required" {
            if b.advisoryId.isEmpty { throw SecurityNoticeError("advisory-required") }
            if b.reason.isEmpty { throw SecurityNoticeError("reason-required") }
            if b.lockFrom < b.validFrom || b.lockFrom >= b.validUntil { throw SecurityNoticeError("bad-lock-from") }
            if b.deprecatesProtocol != 0 {
                for (_, m) in entries where m.minProtocol <= b.deprecatesProtocol {
                    throw SecurityNoticeError("deprecates-not-enforced")
                }
            }
        } else {
            if b.lockFrom != 0 { throw SecurityNoticeError("lock-from-not-allowed") }
            if b.deprecatesProtocol != 0 { throw SecurityNoticeError("deprecates-not-allowed") }
            if b.kind != "update-advisory" {
                if !b.advisoryId.isEmpty { throw SecurityNoticeError("advisory-not-allowed") }
                if !b.reason.isEmpty { throw SecurityNoticeError("reason-not-allowed") }
            }
        }

        let line = [
            tag, signedBy, String(b.seq), b.kind, String(b.validFrom), String(b.validUntil),
            String(b.eventAt), String(b.lockFrom), platforms, b.advisoryId,
            String(b.deprecatesProtocol), b.reason, b.message,
        ].joined(separator: "|")
        return Data(line.utf8)
    }
}

// MARK: - Untrusted JSON in, JSON out

extension SecurityNotice {
    /// A JSON number that is a whole number, or -1.
    private static func number(_ v: Any?) -> Int64 {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return -1 }
        let d = n.doubleValue
        guard d.isFinite, d == d.rounded(), abs(d) < 9.2e18 else { return -1 }
        return Int64(d)
    }

    /// The signed body of an untrusted JSON object (types are loose; the rules
    /// report what is wrong). Nil only when `platforms` is not an object.
    public static func body(fromJSON r: [String: Any]) -> SecurityNoticeBody? {
        guard let platformsAny = r["platforms"] as? [String: Any] else { return nil }
        var platforms: [String: SecurityNoticeMinimum] = [:]
        for (name, value) in platformsAny {
            let m = value as? [String: Any]
            platforms[name] = SecurityNoticeMinimum(minBuild: number(m?["minBuild"]), minProtocol: number(m?["minProtocol"]))
        }
        return SecurityNoticeBody(
            seq: number(r["seq"]),
            kind: (r["kind"] as? String) ?? "",
            validFrom: number(r["validFrom"]),
            validUntil: number(r["validUntil"]),
            eventAt: number(r["eventAt"]),
            lockFrom: number(r["lockFrom"]),
            platforms: platforms,
            advisoryId: (r["advisoryId"] as? String) ?? "",
            deprecatesProtocol: number(r["deprecatesProtocol"]),
            reason: (r["reason"] as? String) ?? "",
            message: (r["message"] as? String) ?? ""
        )
    }

    /// Shape-check an untrusted notice and enforce every rule (no signature check).
    public static func parse(_ v: Any?) -> SecurityNotice? {
        guard let r = v as? [String: Any] else { return nil }
        guard (r["type"] as? String) == "SecurityNotice", number(r["version"]) == 1 else { return nil }
        guard let signedBy = r["signedBy"] as? String, let signature = r["signature"] as? String,
              SecurityNoticeRules.isHex64(signedBy), SecurityNoticeRules.isHex128(signature) else { return nil }
        guard r["kind"] is String, r["advisoryId"] is String, r["reason"] is String, r["message"] is String else { return nil }
        guard let body = body(fromJSON: r) else { return nil }
        do { _ = try SecurityNoticeRules.canonical(body, signedBy: signedBy) } catch { return nil }
        return SecurityNotice(body: body, signedBy: signedBy, signature: signature)
    }

    /// The wire JSON of this notice (stored with the mandate log it came with).
    public func json() -> [String: Any] {
        var platforms: [String: Any] = [:]
        for (name, m) in body.platforms { platforms[name] = ["minBuild": m.minBuild, "minProtocol": m.minProtocol] }
        return [
            "type": "SecurityNotice", "version": 1,
            "seq": body.seq, "kind": body.kind,
            "validFrom": body.validFrom, "validUntil": body.validUntil,
            "eventAt": body.eventAt, "lockFrom": body.lockFrom,
            "platforms": platforms,
            "advisoryId": body.advisoryId, "deprecatesProtocol": body.deprecatesProtocol,
            "reason": body.reason, "message": body.message,
            "signedBy": signedBy, "signature": signature,
        ]
    }

    /// `{date}` replaced by the caller's rendering of `eventAt`.
    public func text(formatDate: (Date) -> String = SecurityNotice.localDate) -> String {
        guard body.eventAt != 0 else { return body.message }
        let date = Date(timeIntervalSince1970: Double(body.eventAt) / 1000)
        return body.message.replacingOccurrences(of: "{date}", with: formatDate(date))
    }

    /// A date for a person, in their own locale and zone, never sent anywhere
    /// ("Wednesday, October 21 at 9:00 AM").
    public static func localDate(_ date: Date) -> String {
        date.formatted(.dateTime.weekday(.wide).month(.wide).day().hour().minute())
    }
}

// MARK: - Verify, decide, accept

public enum SecurityNoticeVerifier {
    public enum Rejection: String, Equatable, Sendable {
        case malformed
        case unauthorizedSigner = "unauthorized-signer"
        case signatureInvalid = "signature-invalid"
        case stale
    }

    /// Is the signature good, and is the signer one of `authorityKeys` (the
    /// ca-track authority at the verifier's clock)? Time windows are judged
    /// separately by `outcome`.
    public static func verify(_ n: SecurityNotice, authorityKeys: [String]) -> Rejection? {
        let bytes: Data
        do { bytes = try SecurityNoticeRules.canonical(n.body, signedBy: n.signedBy) } catch { return .malformed }
        guard SecurityNoticeRules.isHex128(n.signature) else { return .malformed }
        guard authorityKeys.contains(n.signedBy) else { return .unauthorizedSigner }
        return MaintainersEd25519.verify(sigHex: n.signature, message: bytes, pubKeyHex: n.signedBy) ? nil : .signatureInvalid
    }
}

/// What this build is, for the notice: it names the oldest build and protocol
/// it still accepts.
public struct SecurityNoticeClient: Equatable, Sendable {
    public var platform: String
    public var build: Int64
    public var protocolLevel: Int64
    public init(platform: String, build: Int64, protocolLevel: Int64) {
        self.platform = platform
        self.build = build
        self.protocolLevel = protocolLevel
    }

    /// This iOS build: `CFBundleVersion` as an integer (the number a notice's
    /// `minBuild` names). A build number that cannot be read never locks by
    /// build (fail open), so it counts as the newest.
    public static func current(bundle: Bundle = .main) -> SecurityNoticeClient {
        let raw = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        let build = raw.flatMap { Int64($0.trimmingCharacters(in: .whitespaces)) } ?? Int64.max
        return SecurityNoticeClient(platform: "ios", build: build, protocolLevel: clientProtocolLevel)
    }
}

public enum SecurityNoticeOutcome: Equatable, Sendable {
    case none(why: String)
    case banner(style: BannerStyle, notice: SecurityNotice)
    case lock(notice: SecurityNotice)

    public enum BannerStyle: String, Equatable, Sendable { case maintenance, update }

    public var isLock: Bool {
        if case .lock = self { return true }
        return false
    }
}

extension SecurityNoticeVerifier {
    /// Is this client below the notice's minimum for its platform? (false when the platform isn't listed.)
    public static func clientBelowMinimum(_ n: SecurityNotice, _ c: SecurityNoticeClient) -> Bool {
        guard let m = n.platforms[c.platform] else { return false }
        return (m.minBuild > 0 && c.build < m.minBuild) || (m.minProtocol > 0 && c.protocolLevel < m.minProtocol)
    }

    /// What a client shows for an already VERIFIED notice. Fail open: outside
    /// [validFrom, validUntil) nothing is shown, and only update-required,
    /// from lockFrom, for a client below the minimum, locks.
    public static func outcome(_ n: SecurityNotice, client c: SecurityNoticeClient, nowMs now: Int64) -> SecurityNoticeOutcome {
        if n.kind == "none" { return .none(why: "kind-none") }
        if now < n.validFrom { return .none(why: "not-yet") }
        if now >= n.validUntil { return .none(why: "expired") }
        if n.kind == "maintenance" {
            if !n.platforms.isEmpty && n.platforms[c.platform] == nil { return .none(why: "other-platform") }
            return .banner(style: .maintenance, notice: n)
        }
        if n.platforms[c.platform] == nil { return .none(why: "other-platform") }
        if !clientBelowMinimum(n, c) { return .none(why: "up-to-date") }
        if n.kind == "update-required" && now >= n.lockFrom { return .lock(notice: n) }
        return .banner(style: .update, notice: n)
    }

    /// What a client persists between launches (the verified part).
    public struct Store: Equatable, Sendable {
        public var highestSeq: Int64
        public var notice: SecurityNotice?
        public init(highestSeq: Int64 = 0, notice: SecurityNotice? = nil) {
            self.highestSeq = highestSeq
            self.notice = notice
        }
    }

    /// Fold a fetched candidate into the store. A candidate that is malformed,
    /// unsigned by the authority, or not newer than the highest seq verified
    /// is dropped and the store stays as it was.
    public static func accept(_ store: Store, candidate: Any?, authorityKeys: [String]) -> (store: Store, refused: Rejection?) {
        if candidate == nil || candidate is NSNull { return (store, nil) }
        guard let n = SecurityNotice.parse(candidate) else { return (store, .malformed) }
        if let bad = verify(n, authorityKeys: authorityKeys) { return (store, bad) }
        if n.seq <= store.highestSeq { return (store, .stale) }
        return (Store(highestSeq: n.seq, notice: n), nil)
    }

    /// The stored notice's outcome, re-verified against the authority NOW. If
    /// the authority cannot be established the answer is "nothing": a lock is
    /// never shown on trust alone.
    public static func storedOutcome(_ store: Store, authorityKeys: [String], client: SecurityNoticeClient, nowMs: Int64) -> SecurityNoticeOutcome {
        guard let n = store.notice else { return .none(why: "kind-none") }
        if verify(n, authorityKeys: authorityKeys) != nil { return .none(why: "kind-none") }
        return outcome(n, client: client, nowMs: nowMs)
    }
}

// MARK: - The authority

/// The ca-track maintainer authority, found from the mandate log a response
/// carries, walked forward from the baked pin.
public enum SecurityNoticeAuthority {
    private struct SigJSON: Decodable { let pubkey: String; let sig: String }
    private struct ApprovalJSON: Decodable { let kind: String; let threshold: Int }
    private struct ProjectJSON: Decodable {
        let name: String?; let contact: String?; let homepage: String?; let tracks: [String]?
    }
    private struct MandateJSON: Decodable {
        let kind: String; let version: Int; let mandateId: String; let track: String
        let holder: String; let issuedAt: String; let expiresAt: String
        let successors: [String]; let approvalRule: ApprovalJSON
        let minSuccessors: Int; let maxDurationSeconds: Int; let defaultDurationSeconds: Int
        let project: ProjectJSON?; let signedBy: String; let signatures: [SigJSON]

        func model() -> Mandate {
            Mandate(
                kind: kind, version: version, mandateId: mandateId, track: track,
                holder: holder, issuedAt: issuedAt, expiresAt: expiresAt, successors: successors,
                approvalRule: MaintainersApprovalRule(kind: approvalRule.kind, threshold: approvalRule.threshold),
                minSuccessors: minSuccessors, maxDurationSeconds: maxDurationSeconds,
                defaultDurationSeconds: defaultDurationSeconds,
                project: project.map { MaintainersProject(name: $0.name, contact: $0.contact, homepage: $0.homepage, tracks: $0.tracks) },
                signedBy: signedBy,
                signatures: signatures.map { MaintainersSignature(pubkey: $0.pubkey, sig: $0.sig) }
            )
        }
    }

    /// The mandate log as the server sent it (`[Mandate JSON]`), or nil when it does not decode.
    public static func decodeMandates(_ raw: Any?) -> [Mandate]? {
        guard let array = raw as? [Any], JSONSerialization.isValidJSONObject(array),
              let data = try? JSONSerialization.data(withJSONObject: array),
              let decoded = try? JSONDecoder().decode([MandateJSON].self, from: data) else { return nil }
        return decoded.map { $0.model() }
    }

    /// The authority key at `now`, and the newest mandate time ("tip", ms)
    /// this device has verified. `minTip` is the `issuedAt` of the newest
    /// authority mandate seen before: an older chain is refused, so a hostile
    /// carrier cannot replay one from before a rotation.
    public static func resolve(
        mandates: [Mandate], now: Date, pin: String = MaintainersTrust.bakedPin, minTip: Int64
    ) -> (keys: [String], tip: Int64) {
        guard !mandates.isEmpty else { return ([], minTip) }
        let chain = MaintainersVerifier.verifyMandateChainFromPin(pinnedHash: pin, mandates: mandates)
        guard let auth = MaintainersVerifier.currentAuthority(chain, now: now),
              let issued = MaintainersTime.epochMs(auth.mandate.issuedAt), issued.isFinite else { return ([], minTip) }
        let issuedMs = Int64(issued)
        if issuedMs < minTip { return ([], minTip) }
        return ([auth.holder], max(issuedMs, minTip))
    }
}
