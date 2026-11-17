#if DEBUG
import Foundation
import Security
import FlagshipAPI

/// Gym and unit tests only: an in-memory `.com` for the payment routes, with the same checks and refusal codes as
/// packages/control-plane/src/blindVouchers.ts. Its signing key is a fresh RSA-2048 key in the Security framework,
/// which signs blind with a raw private-key operation.
public final class MockPaymentsComClient: PaymentsComClient, @unchecked Sendable {
    private let lock = NSLock()
    public var config = PaymentsConfig.defaults
    public var testIssueOn = true
    public var wallets: [String: JSONValue] = [:]
    public private(set) var nullifiers: Set<String> = []
    public var plans: [String: AccountPlanState] = [:]
    public var usedBytes: [String: Int64] = [:]
    public private(set) var topUps: [String: Int64] = [:]
    public private(set) var redeems: [(username: String, what: String, count: Int)] = []
    /// Refuse every call with this code (the network is down: "network").
    public var failAll: String?
    public var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }

    private static let signer: (priv: SecKey, key: VoucherPublicKey)? = {
        let attrs: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits as String: 2048]
        guard let priv = SecKeyCreateRandomKey(attrs as CFDictionary, nil), let pub = SecKeyCopyPublicKey(priv),
              let der = SecKeyCopyExternalRepresentation(pub, nil) as Data?, let (n, e) = rsaPublicNumbers(Array(der)) else { return nil }
        let nHex = CanonicalJson.hex(n), eHex = CanonicalJson.hex(e)
        return (priv, VoucherPublicKey(keyId: Vouchers.keyId(nHex: nHex, eHex: eHex), nHex: nHex, eHex: eHex))
    }()

    /// n and e of a PKCS#1 RSAPublicKey, leading zero bytes stripped.
    static func rsaPublicNumbers(_ der: [UInt8]) -> ([UInt8], [UInt8])? {
        var i = 0
        func length() -> Int? {
            guard i < der.count else { return nil }
            let b = Int(der[i]); i += 1
            if b < 0x80 { return b }
            let count = b & 0x7f
            var n = 0
            for _ in 0..<count { guard i < der.count else { return nil }; n = n << 8 | Int(der[i]); i += 1 }
            return n
        }
        func integer() -> [UInt8]? {
            guard i < der.count, der[i] == 0x02 else { return nil }
            i += 1
            guard let len = length(), i + len <= der.count else { return nil }
            var v = Array(der[i..<(i + len)])
            i += len
            while v.count > 1, v[0] == 0 { v.removeFirst() }
            return v
        }
        guard der.first == 0x30 else { return nil }
        i = 1
        guard length() != nil, let n = integer(), let e = integer() else { return nil }
        return (n, e)
    }

    public static var key: VoucherPublicKey? { signer?.key }

    public init() {}

    private func locked<T>(_ f: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try f() }
    private func failIfAsked() throws { if let c = failAll { throw PaymentsComError(status: 0, code: c) } }

    /// Sign blinded requests directly (gym seeding).
    public func sign(_ blinded: [String]) throws -> [String] {
        guard let s = Self.signer else { throw PaymentsComError(status: 503, code: "no-key") }
        return try blinded.map { b in
            guard let bytes = CanonicalJson.b64Decode(b),
                  let out = SecKeyCreateDecryptedData(s.priv, .rsaEncryptionRaw, Data(bytes) as CFData, nil) as Data? else {
                throw PaymentsComError(status: 400, code: "malformed")
            }
            return CanonicalJson.b64Encode(Array(out))
        }
    }

    /// `n` ready vouchers (gym seeding).
    public func makeVouchers(_ n: Int) throws -> [Voucher] {
        guard let key = Self.key else { return [] }
        let reqs = try (0..<n).map { _ in try Vouchers.newRequest(key: key) }
        let sigs = try sign(reqs.map(\.blinded))
        return try zip(reqs, sigs).map { try Vouchers.finalize(key: key, pending: $0.pending, blindSig: $1) }
    }

    public func paymentsInfo() async throws -> PaymentsInfo {
        try failIfAsked()
        let keys = Self.key.map { [PublishedVoucherKey(key: $0, issueUntil: 0, acceptUntil: 0, issuing: true)] } ?? []
        return locked { PaymentsInfo(config: config, keys: keys, testIssue: testIssueOn) }
    }

    public func wallet(username: String) async throws -> JSONValue? {
        try failIfAsked()
        return locked { wallets[username.lowercased()] }
    }

    public func putWallet(username: String, sealed: JSONValue, device: VoiciDeviceSigner) async throws {
        try failIfAsked()
        let u = username.lowercased()
        guard await device("PUT", "/api/accounts/\(u)/voucher-wallet") != nil else { throw PaymentsComError(status: 403, code: "forbidden") }
        try locked {
            let stored = wallets[u]
            guard let v = sealed["version"]?.time, v == VoucherWalletSync.version(stored) + 1 else {
                throw PaymentsComError(status: 409, code: "version-conflict", stored: stored)
            }
            wallets[u] = sealed
        }
    }

    public func testIssue(keyId: String, blinded: [String]) async throws -> [String] {
        try failIfAsked()
        guard testIssueOn else { throw PaymentsComError(status: 404, code: "issue-off") }
        guard keyId == Self.key?.keyId else { throw PaymentsComError(status: 409, code: "no-key") }
        guard !blinded.isEmpty else { throw PaymentsComError(status: 400, code: "malformed") }
        guard blinded.count <= min(30, Int(config.maxPerRequest)) else { throw PaymentsComError(status: 400, code: "too-many") }
        return try sign(blinded)
    }

    private func current(_ u: String, now: Int64) -> AccountPlanState {
        guard let p = plans[u], p.plan != nil, p.paidUntil + config.graceHours * 3_600_000 >= now else { return .free }
        return p
    }

    /// planEndAfterSpend in blindVouchers.ts.
    static func planEnd(_ cfg: PaymentsConfig, current: AccountPlanState?, plan: PaidPlan, n: Int64, now: Int64) -> Int64 {
        let unit = cfg.unitMs(plan)
        var base = now
        if let c = current, let cp = c.plan, c.paidUntil > 0, c.paidUntil + cfg.graceHours * 3_600_000 >= now {
            if cp == plan { base = c.paidUntil } else if c.paidUntil > now {
                base = now + Int64((Double(c.paidUntil - now) * Double(unit) / Double(cfg.unitMs(cp))).rounded(.down))
            }
        }
        return base + n * unit
    }

    public func redeem(username: String, for what: String, vouchers: [Voucher]) async throws -> VoucherRedeemResult {
        try failIfAsked()
        let u = username.lowercased(), now = self.now()
        return try locked {
            guard !vouchers.isEmpty, what == "overage" || PaidPlan(rawValue: what) != nil else { throw PaymentsComError(status: 400, code: "malformed") }
            guard vouchers.count <= Int(config.maxPerRequest) else { throw PaymentsComError(status: 400, code: "too-many") }
            var seen = Set<String>()
            for v in vouchers {
                let nf = Vouchers.nullifier(v)
                guard let key = Self.key, Vouchers.verify(key: key, voucher: v) else { throw PaymentsComError(status: 400, code: "bad-voucher", nullifier: nf) }
                guard seen.insert(nf).inserted else { throw PaymentsComError(status: 400, code: "malformed") }
            }
            let rec = plans[u]
            let active = rec?.plan != nil && (rec?.paidUntil ?? 0) + config.graceHours * 3_600_000 >= now
            if what == "overage" {
                guard active else { throw PaymentsComError(status: 409, code: "overage-needs-plan") }
                guard vouchers.count == Int(config.overage.blockUnits) else { throw PaymentsComError(status: 400, code: "overage-block-size") }
            } else if Self.planEnd(config, current: rec, plan: PaidPlan(rawValue: what)!, n: 0, now: now) - now > config.maxAheadDays * 86_400_000 {
                throw PaymentsComError(status: 409, code: "plan-paid-ahead")
            }
            let all = vouchers.map(Vouchers.nullifier)
            let spent = all.filter { nullifiers.contains($0) }
            let fresh = all.filter { !nullifiers.contains($0) }
            if what == "overage" {
                guard spent.isEmpty else { throw PaymentsComError(status: 409, code: "voucher-spent", spent: spent) }
                nullifiers.formUnion(fresh)
                topUps[u, default: 0] += config.overage.blockGb * 1_073_741_824
                redeems.append((u, what, fresh.count))
                return VoucherRedeemResult(credited: Int64(fresh.count), spent: [], topUpBytes: topUps[u])
            }
            guard !fresh.isEmpty else { throw PaymentsComError(status: 409, code: "voucher-spent", spent: spent) }
            nullifiers.formUnion(fresh)
            let plan = PaidPlan(rawValue: what)!
            let end = Self.planEnd(config, current: rec, plan: plan, n: Int64(fresh.count), now: now)
            plans[u] = AccountPlanState(tier: plan == .pro ? "hobby" : "maker", paidUntil: end)
            redeems.append((u, what, fresh.count))
            return VoucherRedeemResult(credited: Int64(fresh.count), spent: spent, paidUntil: end)
        }
    }

    public func plan(username: String) async throws -> AccountPlanState {
        try failIfAsked()
        let now = self.now()
        return locked {
            let u = username.lowercased()
            let c = current(u, now: now)
            return c.plan == nil ? .free : c
        }
    }

    public func allowance(username: String) async throws -> AccountAllowance {
        try failIfAsked()
        let now = self.now()
        return locked {
            let u = username.lowercased()
            let c = current(u, now: now)
            let gb: Int64 = 1_073_741_824
            let included = (c.plan.map { config.plan($0).includedGb } ?? 25) * gb
            let quota = included + (c.plan == nil ? 0 : topUps[u] ?? 0)
            let used = usedBytes[u] ?? 0
            return AccountAllowance(tier: c.tier, usedBytes: used, quotaBytes: quota, remainingBytes: max(0, quota - used))
        }
    }
}
#endif
