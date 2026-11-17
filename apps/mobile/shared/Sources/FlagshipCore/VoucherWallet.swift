import CryptoKit
import Foundation

/// The account's voucher wallet, held by its admin phones and synced end to end encrypted like the call hours. Swift
/// twin of packages/protocol/src/voucherWallet.ts, pinned by test-vectors/vouchers/ (`wallet`, `merge`, `trickle`,
/// `overage`, `planAhead`).
///
///   key     HKDF-SHA256(ikm UMK seed, salt empty, info "flagship/voucher-wallet/v1", 32)
///   sealed  {version, nonce (hex 12), ct (base64)}: AES-256-GCM(key, nonce, aad "flagship/voucher-wallet/v1|<version>",
///           canonical JSON plaintext padded with "0"s in `pad` to 4096 · 2^i bytes); version = stored + 1
///   merge   vouchers and spent are unions (spent wins), settings by the newer updatedAt, overage by the later month
public struct VoucherWalletSettings: Equatable, Sendable, Codable {
    public var plan: PaidPlan?
    public var autoPay: Bool
    public var overageCapUnits: Int64
    public var delayStart: Bool
    public var startAt: Int64
    public var updatedAt: Int64
    public init(plan: PaidPlan?, autoPay: Bool, overageCapUnits: Int64, delayStart: Bool, startAt: Int64, updatedAt: Int64) {
        self.plan = plan; self.autoPay = autoPay; self.overageCapUnits = overageCapUnits; self.delayStart = delayStart
        self.startAt = startAt; self.updatedAt = updatedAt
    }
    var json: JSONValue {
        ["plan": plan.map { .string($0.rawValue) } ?? .null, "autoPay": .bool(autoPay), "overageCapUnits": .int(overageCapUnits),
         "delayStart": .bool(delayStart), "startAt": .int(startAt), "updatedAt": .int(updatedAt)]
    }
}

public struct VoucherWallet: Equatable, Sendable, Codable {
    public struct OverageMonth: Equatable, Sendable, Codable { public var period: String; public var units: Int64 }
    public var vouchers: [Voucher]
    public var spent: [String]
    public var settings: VoucherWalletSettings
    public var overage: OverageMonth

    public init(vouchers: [Voucher], spent: [String], settings: VoucherWalletSettings, overage: OverageMonth) {
        self.vouchers = vouchers; self.spent = spent; self.settings = settings; self.overage = overage
    }

    public static func empty(overageCapUnits: Int64) -> VoucherWallet {
        VoucherWallet(vouchers: [], spent: [],
                      settings: VoucherWalletSettings(plan: nil, autoPay: true, overageCapUnits: overageCapUnits, delayStart: false, startAt: 0, updatedAt: 0),
                      overage: OverageMonth(period: "", units: 0))
    }

    public var balance: Int { vouchers.count }

    func json(pad: String) -> JSONValue {
        ["v": 1, "vouchers": .array(vouchers.map(\.json)), "spent": .array(spent.map { .string($0) }), "settings": settings.json,
         "overage": ["period": .string(overage.period), "units": .int(overage.units)], "pad": .string(pad)]
    }
}

public enum VoucherWalletSync {
    public static let tag = "flagship/voucher-wallet/v1"
    public static let maxVouchers = 500
    public static let maxSpent = 2048
    public static let bucket = 4096
    public static let maxBytes = 512 * 1024

    static func isPeriod(_ s: String) -> Bool {
        if s.isEmpty { return true }
        let b = Array(s.utf8)
        guard b.count == 7, b[4] == 0x2d, b.enumerated().allSatisfy({ $0.offset == 4 || (0x30...0x39).contains($0.element) }),
              let m = Int(s.suffix(2)) else { return false }
        return (1...12).contains(m)
    }

    static func parseSettings(_ v: JSONValue?) -> VoucherWalletSettings? {
        guard let o = v?.object, Set(o.keys) == ["plan", "autoPay", "overageCapUnits", "delayStart", "startAt", "updatedAt"] else { return nil }
        let plan: PaidPlan?
        if o["plan"]?.isNull == true { plan = nil } else { guard let p = o["plan"]?.string.flatMap(PaidPlan.init(rawValue:)) else { return nil }; plan = p }
        guard case .bool(let autoPay)? = o["autoPay"], case .bool(let delay)? = o["delayStart"], let cap = o["overageCapUnits"]?.time, cap <= 10_000,
              let startAt = o["startAt"]?.time, let at = o["updatedAt"]?.time else { return nil }
        return VoucherWalletSettings(plan: plan, autoPay: autoPay, overageCapUnits: cap, delayStart: delay, startAt: startAt, updatedAt: at)
    }

    /// Strict shape of a wallet plaintext (`pad` allowed and dropped).
    public static func parse(_ v: JSONValue?) -> VoucherWallet? {
        guard let o = v?.object else { return nil }
        let keys = Set(o.keys).subtracting(["pad"])
        guard keys == ["v", "vouchers", "spent", "settings", "overage"], o["v"]?.isOne == true else { return nil }
        if let pad = o["pad"] { guard let s = pad.string, s.utf8.allSatisfy({ $0 == 0x30 }) else { return nil } }
        guard let vs = o["vouchers"]?.array, vs.count <= maxVouchers, let sp = o["spent"]?.array, sp.count <= maxSpent else { return nil }
        var spent: [String] = []
        for s in sp { guard let h = s.string, CanonicalJson.isLowerHex(h, bytes: 32) else { return nil }; spent.append(h) }
        var vouchers: [Voucher] = []
        for x in vs { guard let p = Vouchers.parse(x) else { return nil }; vouchers.append(p) }
        guard let settings = parseSettings(o["settings"]), let ov = o["overage"]?.object, Set(ov.keys) == ["period", "units"],
              let period = ov["period"]?.string, isPeriod(period), let units = ov["units"]?.time else { return nil }
        return normalize(VoucherWallet(vouchers: vouchers, spent: spent, settings: settings, overage: .init(period: period, units: units)))
    }

    static func less(_ a: Voucher, _ b: Voucher) -> Bool { a.k == b.k ? CanonicalJson.utf16Less(a.n, b.n) : CanonicalJson.utf16Less(a.k, b.k) }

    /// Sorted, deduplicated, spent vouchers dropped, lists capped.
    public static func normalize(_ w: VoucherWallet) -> VoucherWallet {
        let spent = Array(Set(w.spent).sorted(by: CanonicalJson.utf16Less).suffix(maxSpent))
        let spentSet = Set(spent)
        var seen = Set<String>()
        var vouchers: [Voucher] = []
        for x in w.vouchers.sorted(by: less) {
            let id = "\(x.k)|\(x.n)"
            if seen.contains(id) || spentSet.contains(Vouchers.nullifier(x)) { continue }
            seen.insert(id)
            vouchers.append(x)
        }
        var out = w
        out.vouchers = Array(vouchers.prefix(maxVouchers))
        out.spent = spent
        return out
    }

    public static func merge(local: VoucherWallet, remote: VoucherWallet) -> VoucherWallet {
        let settings = remote.settings.updatedAt > local.settings.updatedAt ? remote.settings : local.settings
        let overage: VoucherWallet.OverageMonth
        if local.overage.period == remote.overage.period {
            overage = .init(period: local.overage.period, units: max(local.overage.units, remote.overage.units))
        } else {
            overage = CanonicalJson.utf16Less(remote.overage.period, local.overage.period) ? local.overage : remote.overage
        }
        return normalize(VoucherWallet(vouchers: local.vouchers + remote.vouchers, spent: local.spent + remote.spent, settings: settings, overage: overage))
    }

    public static func take(_ w: VoucherWallet, _ n: Int) -> [Voucher] { Array(normalize(w).vouchers.prefix(max(0, n))) }

    public static func markSpent(_ w: VoucherWallet, _ nullifiers: [String]) -> VoucherWallet {
        var x = w
        x.spent += nullifiers
        return normalize(x)
    }

    public static func add(_ w: VoucherWallet, _ vouchers: [Voucher]) -> VoucherWallet {
        var x = w
        x.vouchers += vouchers
        return normalize(x)
    }

    public struct WalletError: Error, Equatable { public let reason: String }

    /// The canonical plaintext, padded to its bucket.
    public static func plaintext(_ w: VoucherWallet) throws -> String {
        let n = normalize(w)
        let bare = try CanonicalJson.canonicalJson(n.json(pad: ""))
        let len = bare.utf8.count
        var b = bucket
        while b < len { b *= 2 }
        guard b <= maxBytes else { throw WalletError(reason: "\(tag): too large") }
        return try CanonicalJson.canonicalJson(n.json(pad: String(repeating: "0", count: b - len)))
    }

    public static func deriveKey(umk: [UInt8]) -> [UInt8] { VoiciMessages.kdf(umk, tag) }

    static func aad(_ version: Int64) -> Data { Data("\(tag)|\(version)".utf8) }

    public static func seal(key: [UInt8], version: Int64, wallet: VoucherWallet, nonce: [UInt8]? = nil) throws -> JSONValue {
        let n = nonce ?? Vouchers.random(12)
        guard version >= 1, n.count == 12 else { throw WalletError(reason: "\(tag): bad input") }
        let box = try AES.GCM.seal(Data(try plaintext(wallet).utf8), using: SymmetricKey(data: key), nonce: try AES.GCM.Nonce(data: n),
                                   authenticating: aad(version))
        return ["version": .int(version), "nonce": .string(CanonicalJson.hex(n)), "ct": .string(CanonicalJson.b64Encode(Array(box.ciphertext + box.tag)))]
    }

    public static func open(key: [UInt8], blob: JSONValue?) -> VoucherWallet? {
        guard let o = blob?.object, Set(o.keys) == ["version", "nonce", "ct"], let version = o["version"]?.time, let nonceHex = o["nonce"]?.string,
              CanonicalJson.isLowerHex(nonceHex, bytes: 12), let ct = CanonicalJson.b64Decode(o["ct"]), ct.count >= 16, ct.count <= maxBytes + 16,
              let nonce = try? CanonicalJson.hexToBytes(nonceHex),
              let box = try? AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ct.dropLast(16), tag: ct.suffix(16)),
              let pt = try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad(version)),
              let text = String(data: pt, encoding: .utf8), let v = JSONValue.parse(text), CanonicalJson.isCanonical(v, text) else { return nil }
        return parse(v)
    }

    public static func version(_ blob: JSONValue?) -> Int64 { blob?["version"]?.time ?? 0 }
}

/// The spending rules (trickle, overage, plan lead). Pure, so every port runs the same vectors.
public enum VoucherSpending {
    public struct PaidState: Equatable, Sendable {
        public var plan: PaidPlan?
        public var paidUntil: Int64
        public init(plan: PaidPlan?, paidUntil: Int64) { self.plan = plan; self.paidUntil = paidUntil }
    }

    /// How far ahead `plan` is paid, in `plan`'s time: 0 past the grace, negative inside it, converted across plans.
    public static func planAheadMs(_ cfg: PaymentsConfig, plan: PaidPlan, paid: PaidState, now: Int64) -> Int64 {
        guard let pp = paid.plan, paid.paidUntil > 0 else { return 0 }
        let graceMs = cfg.graceHours * 3_600_000
        if paid.paidUntil + graceMs < now { return 0 }
        let ahead = paid.paidUntil - now
        if pp == plan { return ahead }
        if ahead <= 0 { return 0 }
        // Exact like the TS Math.floor((ahead * unit(plan)) / unit(paid)).
        let num = Double(ahead) * Double(cfg.unitMs(plan))
        return Int64((num / Double(cfg.unitMs(pp))).rounded(.down))
    }

    public struct TrickleInput: Equatable, Sendable {
        public var now: Int64
        public var enabled: Bool
        public var balance: Int64
        public var aheadMs: Int64
        public var startAt: Int64
        public var nextSpendAt: Int64
        public var unitMs: Int64
        public var lowWaterMs: Int64
        public var highWaterMs: Int64
        public var maxPerRequest: Int64
        public init(now: Int64, enabled: Bool, balance: Int64, aheadMs: Int64, startAt: Int64, nextSpendAt: Int64, unitMs: Int64,
                    lowWaterMs: Int64, highWaterMs: Int64, maxPerRequest: Int64) {
            self.now = now; self.enabled = enabled; self.balance = balance; self.aheadMs = aheadMs; self.startAt = startAt
            self.nextSpendAt = nextSpendAt; self.unitMs = unitMs; self.lowWaterMs = lowWaterMs; self.highWaterMs = highWaterMs
            self.maxPerRequest = maxPerRequest
        }
    }

    /// One tick: how many vouchers to spend now and when the next unhurried spend is due. `rand` in [0, 1).
    public static func trickleStep(_ t: TrickleInput, rand: Double) -> (spend: Int64, nextSpendAt: Int64) {
        if !t.enabled || t.balance <= 0 { return (0, 0) }
        if t.now < t.startAt { return (0, t.nextSpendAt) }
        let later = t.now + Int64((rand * Double(t.unitMs)).rounded(.down))
        if t.aheadMs < t.lowWaterMs {
            let gap = t.lowWaterMs - t.aheadMs
            let need = (gap + t.unitMs - 1) / t.unitMs
            return (max(1, min(t.balance, need, t.maxPerRequest)), later)
        }
        if t.aheadMs >= t.highWaterMs { return (0, 0) }
        if t.nextSpendAt == 0 { return (0, later) }
        if t.now >= t.nextSpendAt { return (1, later) }
        return (0, t.nextSpendAt)
    }

    public struct OverageInput: Equatable, Sendable {
        public var paid: Bool
        public var remainingBytes: Int64
        public var buyBelowBytes: Int64
        public var capUnits: Int64
        public var spentUnits: Int64
        public var blockUnits: Int64
        public var balance: Int64
        public init(paid: Bool, remainingBytes: Int64, buyBelowBytes: Int64, capUnits: Int64, spentUnits: Int64, blockUnits: Int64, balance: Int64) {
            self.paid = paid; self.remainingBytes = remainingBytes; self.buyBelowBytes = buyBelowBytes; self.capUnits = capUnits
            self.spentUnits = spentUnits; self.blockUnits = blockUnits; self.balance = balance
        }
    }

    public static func overageStep(_ o: OverageInput) -> Bool {
        o.paid && o.remainingBytes < o.buyBelowBytes && o.spentUnits + o.blockUnits <= o.capUnits && o.balance >= o.blockUnits
    }

    /// "YYYY-MM" (UTC): the overage month, the egress meter's period.
    public static func overagePeriod(_ now: Int64) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let c = cal.dateComponents([.year, .month], from: Date(timeIntervalSince1970: TimeInterval(now) / 1000))
        return String(format: "%04d-%02d", c.year ?? 1970, c.month ?? 1)
    }

    /// Whole months of `plan` a balance buys.
    public static func monthsOfPlan(_ cfg: PaymentsConfig, plan: PaidPlan, balance: Int64) -> Int64 { balance / cfg.plan(plan).unitsPerMonth }
}
