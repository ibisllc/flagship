import Foundation

/// Pro and Pro Max (`.com` tiers hobby and maker).
public enum PaidPlan: String, CaseIterable, Sendable, Codable {
    case pro
    case proMax = "pro-max"

    /// The plan of a `.com` tier, nil for free.
    public static func ofTier(_ tier: String) -> PaidPlan? { tier == "hobby" ? .pro : tier == "maker" ? .proMax : nil }
}

/// Every payment number, as `.com` serves them at `GET /api/payments/config`. Swift twin of
/// packages/protocol/src/paymentsConfig.ts; the defaults are pinned by test-vectors/vouchers/ `defaultConfig`.
public struct PaymentsConfig: Equatable, Sendable, Codable {
    public struct Plan: Equatable, Sendable, Codable { public var unitsPerMonth: Int64; public var includedGb: Int64 }
    public struct Overage: Equatable, Sendable, Codable {
        public var blockUnits: Int64; public var blockGb: Int64; public var defaultCapUnits: Int64; public var maxCapUnits: Int64; public var buyBelowGb: Int64
    }
    public struct Trickle: Equatable, Sendable, Codable { public var lowWaterDays: Int64; public var highWaterDays: Int64 }

    public var unitUsd: Int64
    public var monthDays: Int64
    public var pro: Plan
    public var proMax: Plan
    public var overage: Overage
    public var graceHours: Int64
    public var maxAheadDays: Int64
    public var trickle: Trickle
    public var activationDelayMaxHours: Int64
    public var packs: [Int64]
    public var maxPerRequest: Int64

    public static let defaults = PaymentsConfig(
        unitUsd: 1, monthDays: 30,
        pro: Plan(unitsPerMonth: 10, includedGb: 250), proMax: Plan(unitsPerMonth: 20, includedGb: 500),
        overage: Overage(blockUnits: 5, blockGb: 100, defaultCapUnits: 10, maxCapUnits: 100, buyBelowGb: 10),
        graceHours: 72, maxAheadDays: 35, trickle: Trickle(lowWaterDays: 3, highWaterDays: 10),
        activationDelayMaxHours: 24, packs: [10, 30, 120], maxPerRequest: 30)

    public func plan(_ p: PaidPlan) -> Plan { p == .pro ? pro : proMax }

    static let dayMs: Int64 = 86_400_000

    /// How long one voucher keeps `plan` running (Pro 3 days, Pro Max 36 hours by default).
    public func unitMs(_ p: PaidPlan) -> Int64 { (monthDays * Self.dayMs) / plan(p).unitsPerMonth }

    /// The served config; any missing or invalid field keeps the default (the server already merged its overrides).
    public static func parse(_ v: JSONValue?) -> PaymentsConfig {
        let d = defaults
        guard let o = v?.object else { return d }
        func num(_ x: JSONValue?, _ fallback: Int64) -> Int64 { x?.safeInt.flatMap { $0 > 0 ? $0 : nil } ?? fallback }
        func plan(_ x: JSONValue?, _ f: Plan) -> Plan { Plan(unitsPerMonth: num(x?["unitsPerMonth"], f.unitsPerMonth), includedGb: num(x?["includedGb"], f.includedGb)) }
        let ov = o["overage"], tr = o["trickle"]
        let packs = o["packs"]?.array?.compactMap { $0.safeInt }.filter { $0 > 0 }
        var c = PaymentsConfig(
            unitUsd: num(o["unitUsd"], d.unitUsd), monthDays: num(o["monthDays"], d.monthDays),
            pro: plan(o["plans"]?["pro"], d.pro), proMax: plan(o["plans"]?["pro-max"], d.proMax),
            overage: Overage(blockUnits: num(ov?["blockUnits"], d.overage.blockUnits), blockGb: num(ov?["blockGb"], d.overage.blockGb),
                             defaultCapUnits: num(ov?["defaultCapUnits"], d.overage.defaultCapUnits),
                             maxCapUnits: num(ov?["maxCapUnits"], d.overage.maxCapUnits), buyBelowGb: num(ov?["buyBelowGb"], d.overage.buyBelowGb)),
            graceHours: num(o["graceHours"], d.graceHours), maxAheadDays: num(o["maxAheadDays"], d.maxAheadDays),
            trickle: Trickle(lowWaterDays: num(tr?["lowWaterDays"], d.trickle.lowWaterDays), highWaterDays: num(tr?["highWaterDays"], d.trickle.highWaterDays)),
            activationDelayMaxHours: num(o["activationDelayMaxHours"], d.activationDelayMaxHours),
            packs: (packs?.isEmpty == false ? packs! : d.packs).sorted(), maxPerRequest: num(o["maxPerRequest"], d.maxPerRequest))
        if c.trickle.highWaterDays <= c.trickle.lowWaterDays { c.trickle = d.trickle }
        return c
    }
}

/// One voucher signing key as `.com` publishes it.
public struct PublishedVoucherKey: Equatable, Sendable, Codable {
    public var key: VoucherPublicKey
    public var issueUntil: Int64
    public var acceptUntil: Int64
    public var issuing: Bool
}

/// `GET /api/payments/config`: the numbers, the keys still accepted (each checked: its id must match its numbers),
/// and whether this `.com` gives free test vouchers (the gym only).
public struct PaymentsInfo: Equatable, Sendable {
    public var config: PaymentsConfig
    public var keys: [PublishedVoucherKey]
    public var testIssue: Bool
    public init(config: PaymentsConfig, keys: [PublishedVoucherKey], testIssue: Bool) { self.config = config; self.keys = keys; self.testIssue = testIssue }

    public static func parse(_ v: JSONValue?) -> PaymentsInfo {
        let keys: [PublishedVoucherKey] = (v?["keys"]?.array ?? []).compactMap { k in
            guard let id = k["keyId"]?.string, let n = k["nHex"]?.string, let e = k["eHex"]?.string else { return nil }
            let key = VoucherPublicKey(keyId: id, nHex: n, eHex: e)
            guard Vouchers.isUsableKey(key) else { return nil }
            return PublishedVoucherKey(key: key, issueUntil: k["issueUntil"]?.time ?? 0, acceptUntil: k["acceptUntil"]?.time ?? 0,
                                       issuing: k["issuing"] == .bool(true))
        }
        return PaymentsInfo(config: PaymentsConfig.parse(v?["config"]), keys: keys, testIssue: v?["testIssue"] == .bool(true))
    }

    /// The key new vouchers are made under.
    public var issuingKey: VoucherPublicKey? { keys.first(where: { $0.issuing })?.key }
    public func key(_ id: String) -> VoucherPublicKey? { keys.first(where: { $0.key.keyId == id })?.key }
}
