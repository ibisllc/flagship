import Foundation

/// The "Load into Flagship" voucher link: Swift twin of packages/protocol/src/voucherLink.ts, pinned by
/// test-vectors/voucher-link/ (docs/anonymous-vouchers.md "Voucher links").
///
///   link      https://<control apex>/app/vouchers#v=<payload, base64url without padding>
///   payload   version (1) | part | parts | keyId (8 bytes) | count | sigLen (2 bytes, big-endian)
///             | count × (prefix 32 | nonce 32 | signature sigLen) | check (4 bytes)
///   check     the first 4 bytes of SHA-256("flagship/voucher-link/v1|" followed by every payload byte before it)
///
/// The vouchers ride only in the fragment, which never reaches a server; adding them needs no network call.
public enum VoucherLink {
    public static let tag = "flagship/voucher-link/v1"
    public static let path = "/app/vouchers"
    public static let version: UInt8 = 1
    public static let maxPerLink = 30
    public static let maxParts = 255
    public static let maxChars = 32_768
    static let minSig = 256
    static let maxSig = 1024
    static let header = 14
    static let checkLen = 4

    public enum ParseError: String, Error, Equatable, Sendable {
        case notALink = "not-a-link"
        case damaged
        case newer
    }

    public struct Parsed: Equatable, Sendable {
        public let part: Int
        public let parts: Int
        public let keyId: String
        public let vouchers: [Voucher]
    }

    public enum Outcome: String, Equatable, Sendable {
        case add, full, invalid, alreadySpent = "spent", already
        case unknownKey = "unknown-key"
    }

    public struct ImportPlan: Equatable, Sendable {
        public var add: [Voucher]
        public var duplicate: Int
        public var spent: Int
        public var invalid: Int
        public var unknownKey: Int
        public var full: Bool
        public var outcome: Outcome
    }

    public struct EncodeError: Error, Equatable { public let reason: String }

    static func b64url(_ b: [UInt8]) -> String {
        var s = CanonicalJson.b64Encode(b).replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        while s.hasSuffix("=") { s.removeLast() }
        return s
    }

    static func fromB64url(_ s: String) -> [UInt8]? {
        guard s.utf8.allSatisfy({ ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 45 || $0 == 95 }),
              s.utf8.count % 4 != 1 else { return nil }
        let std = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return CanonicalJson.b64Decode(std + String(repeating: "=", count: (4 - std.utf8.count % 4) % 4))
    }

    static func check(_ body: [UInt8]) -> [UInt8] { Array(CanonicalJson.sha256(Array("\(tag)|".utf8) + body).prefix(checkLen)) }

    /// One link's payload: `vouchers` share one key and one signature length.
    public static func encodePayload(_ vouchers: [Voucher], part: Int, parts: Int) throws -> String {
        guard let first = vouchers.first, vouchers.count <= maxPerLink else { throw EncodeError(reason: "bad count") }
        guard part >= 1, parts >= part, parts <= maxParts else { throw EncodeError(reason: "bad part") }
        var sigs: [[UInt8]] = []
        for v in vouchers {
            guard Vouchers.parse(v.json) != nil, v.k == first.k, let s = CanonicalJson.b64Decode(v.s) else { throw EncodeError(reason: "bad voucher") }
            sigs.append(s)
        }
        let sigLen = sigs[0].count
        guard sigLen >= minSig, sigLen <= maxSig, sigs.allSatisfy({ $0.count == sigLen }) else { throw EncodeError(reason: "bad signature length") }
        var body: [UInt8] = [version, UInt8(part), UInt8(parts)]
        body += try CanonicalJson.hexToBytes(first.k)
        body += [UInt8(vouchers.count), UInt8(sigLen >> 8), UInt8(sigLen & 0xff)]
        for (i, v) in vouchers.enumerated() {
            body += try CanonicalJson.hexToBytes(v.p)
            body += try CanonicalJson.hexToBytes(v.n)
            body += sigs[i]
        }
        return b64url(body + check(body))
    }

    /// Every link for `vouchers`: grouped by key (first seen first), at most `maxPerLink` a link, numbered across the set.
    public static func encodeLinks(_ vouchers: [Voucher], apex: String) throws -> [String] {
        var order: [String] = []
        var groups: [String: [Voucher]] = [:]
        for v in vouchers {
            if groups[v.k] == nil { order.append(v.k) }
            groups[v.k, default: []].append(v)
        }
        var chunks: [[Voucher]] = []
        for k in order {
            let g = groups[k]!
            stride(from: 0, to: g.count, by: maxPerLink).forEach { chunks.append(Array(g[$0..<min($0 + maxPerLink, g.count)])) }
        }
        guard !chunks.isEmpty, chunks.count <= maxParts else { throw EncodeError(reason: "bad count") }
        return try chunks.enumerated().map { "https://\(apex)\(path)#v=\(try encodePayload($1, part: $0 + 1, parts: chunks.count))" }
    }

    /// The payload of a whole URL or a bare fragment ("#v=…", "v=…"); nil when it has none.
    static func payload(of link: String) -> Result<String?, ParseError> {
        let s = link.trimmingCharacters(in: .whitespacesAndNewlines)
        let frag: Substring
        let lower = s.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") {
            let afterScheme = s[s.range(of: "://")!.upperBound...]
            let pathStart = afterScheme.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) ?? afterScheme.endIndex
            let rest = afterScheme[pathStart...]
            let pathEnd = rest.firstIndex(where: { $0 == "?" || $0 == "#" }) ?? rest.endIndex
            var p = String(rest[..<pathEnd])
            while p.hasSuffix("/") { p.removeLast() }
            guard p == path else { return .failure(.notALink) }
            guard let hash = s.firstIndex(of: "#") else { return .success(nil) }
            frag = s[s.index(after: hash)...]
        } else if let hash = s.firstIndex(of: "#") {
            frag = s[s.index(after: hash)...]
        } else {
            frag = s[...]
        }
        for pair in frag.split(separator: "&", omittingEmptySubsequences: false) where pair.hasPrefix("v=") {
            return .success(String(pair.dropFirst(2)))
        }
        return .success(nil)
    }

    /// Shape and checksum only; signatures are checked by `planImport`.
    public static func parse(_ link: String) -> Result<Parsed, ParseError> {
        let p: String?
        switch payload(of: link) {
        case .failure(let e): return .failure(e)
        case .success(let x): p = x
        }
        guard let payload = p, !payload.isEmpty, payload.utf8.count <= maxChars, let b = fromB64url(payload), !b.isEmpty else { return .failure(.damaged) }
        if b[0] != version { return .failure(b[0] > version ? .newer : .damaged) }
        guard b.count >= header + checkLen else { return .failure(.damaged) }
        let body = Array(b[0..<(b.count - checkLen)])
        guard check(body) == Array(b[(b.count - checkLen)...]) else { return .failure(.damaged) }
        let part = Int(b[1]), parts = Int(b[2]), count = Int(b[11])
        let keyId = CanonicalJson.hex(Array(b[3..<11]))
        let sigLen = (Int(b[12]) << 8) | Int(b[13])
        guard part >= 1, parts >= part, count >= 1, count <= maxPerLink, sigLen >= minSig, sigLen <= maxSig,
              body.count == header + count * (64 + sigLen) else { return .failure(.damaged) }
        var vouchers: [Voucher] = []
        var o = header
        for _ in 0..<count {
            vouchers.append(Voucher(k: keyId, p: CanonicalJson.hex(Array(body[o..<(o + 32)])), n: CanonicalJson.hex(Array(body[(o + 32)..<(o + 64)])),
                                    s: CanonicalJson.b64Encode(Array(body[(o + 64)..<(o + 64 + sigLen)]))))
            o += 64 + sigLen
        }
        return .success(Parsed(part: part, parts: parts, keyId: keyId, vouchers: vouchers))
    }

    /// What adding a link's vouchers to `wallet` would do, decided on the device alone (same rules as the TS).
    public static func planImport(wallet: VoucherWallet, vouchers: [Voucher], keys: [VoucherPublicKey]) -> ImportPlan {
        var have = Set(wallet.vouchers.map { "\($0.k)|\($0.n)" })
        let spentSet = Set(wallet.spent)
        var plan = ImportPlan(add: [], duplicate: 0, spent: 0, invalid: 0, unknownKey: 0, full: false, outcome: .already)
        for v in vouchers {
            guard let key = keys.first(where: { $0.keyId == v.k }) else { plan.unknownKey += 1; continue }
            if !Vouchers.verify(key: key, voucher: v) { plan.invalid += 1 }
            else if spentSet.contains(Vouchers.nullifier(v)) { plan.spent += 1 }
            else if have.contains("\(v.k)|\(v.n)") { plan.duplicate += 1 }
            else {
                have.insert("\(v.k)|\(v.n)")
                plan.add.append(v)
            }
        }
        plan.full = !plan.add.isEmpty && wallet.vouchers.count + plan.add.count > VoucherWalletSync.maxVouchers
        plan.outcome = plan.full ? .full
            : !plan.add.isEmpty ? .add
            : plan.invalid > 0 ? .invalid
            : plan.unknownKey > 0 ? .unknownKey
            : plan.spent > 0 ? .alreadySpent
            : .already
        return plan
    }

    /// Why a link adds nothing; each has one sentence on every app.
    public enum Refusal: String, Equatable, Sendable {
        case damaged, newer, already, spent, invalid, full
        case unknownKey = "unknown-key"
        case notAdmin = "not-admin"
        case signedOut = "signed-out"
    }

    public enum Decision: Equatable, Sendable {
        case confirm(ImportPlan, part: Int, parts: Int)
        case refuse(Refusal)
    }

    /// What the screen does with an opened link. `plan` is the device's own planning (nil when this device can't
    /// hold the wallet: not an admin device, or the account key isn't at hand).
    public static func decide(link: String, signedIn: Bool, plan: ([Voucher]) -> ImportPlan?) -> Decision {
        let parsed: Parsed
        switch parse(link) {
        case .failure(.newer): return .refuse(.newer)
        case .failure: return .refuse(.damaged)
        case .success(let p): parsed = p
        }
        guard signedIn else { return .refuse(.signedOut) }
        guard let p = plan(parsed.vouchers) else { return .refuse(.notAdmin) }
        switch p.outcome {
        case .add: return .confirm(p, part: parsed.part, parts: parsed.parts)
        case .full: return .refuse(.full)
        case .invalid: return .refuse(.invalid)
        case .unknownKey: return .refuse(.unknownKey)
        case .alreadySpent: return .refuse(.spent)
        case .already: return .refuse(.already)
        }
    }
}
