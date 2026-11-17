#if DEBUG
import Foundation

/// Gym and unit tests only: an in-memory `.com` for the org payment routes, with the refusal codes of the real ones.
/// It signs with `MockPaymentsComClient`'s key, so vouchers bought through the personal mock spend here too.
public final class MockOrgPaymentsComClient: OrgPaymentsComClient, @unchecked Sendable {
    public struct Org {
        public var terms: OrgPlanTerms
        public var liveSeats: Int64
        public var wallet: JSONValue?
        public init(terms: OrgPlanTerms, liveSeats: Int64, wallet: JSONValue? = nil) { self.terms = terms; self.liveSeats = liveSeats; self.wallet = wallet }
    }

    private let lock = NSLock()
    public let payments: MockPaymentsComClient
    public var orgs: [String: Org] = [:]
    public private(set) var nullifiers: Set<String> = []
    /// Every stored write: the org, the write order and the approval it came with.
    public private(set) var writes: [(orgId: String, write: OrgWalletWrite, approval: JSONValue)] = []
    public private(set) var redeems: [(orgId: String, what: String, seats: Int64?, count: Int)] = []
    public private(set) var exchanges: Int = 0
    /// Refuse every wallet write with this code (a signer who isn't an org admin: "org-not-admin").
    public var refuseWrites: String?
    public var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }

    public init(payments: MockPaymentsComClient = MockPaymentsComClient()) { self.payments = payments }

    private func locked<T>(_ f: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try f() }

    public func paymentsInfo() async throws -> PaymentsInfo { try await payments.paymentsInfo() }

    public func paidIssue(rail: String, proof: JSONValue, keyId: String, blinded: [String]) async throws -> PaidIssueResult {
        try await payments.paidIssue(rail: rail, proof: proof, keyId: keyId, blinded: blinded)
    }

    private var config: PaymentsConfig { payments.config }

    public func orgPlan(orgId: String) async throws -> OrgPlanServed {
        let now = self.now()
        return try locked {
            guard let o = orgs[orgId] else { throw PaymentsComError(status: 404, code: "org-not-found") }
            let st = OrgPlan.state(config, o.terms, now: now)
            let b = config.business
            return OrgPlanServed(orgId: orgId, status: st.status, seatLimit: st.seatLimit, paidSeats: o.terms.paidSeats, paidUntil: o.terms.paidUntil,
                                 trialEndsAt: o.terms.trialEndsAt, coveredUntil: st.coveredUntil, liveSeats: o.liveSeats,
                                 unitsPerSeatMonth: b.unitsPerSeatMonth, minSeats: b.minSeats, maxSeats: b.maxSeats, unitUsd: config.unitUsd)
        }
    }

    public func orgWallet(orgId: String) async throws -> JSONValue? {
        try locked {
            guard let o = orgs[orgId] else { throw PaymentsComError(status: 404, code: "org-not-found") }
            return o.wallet
        }
    }

    public func putOrgWallet(orgId: String, blob: SealedOrgVoucherWallet, write: OrgWalletWrite, approval: JSONValue) async throws {
        try locked {
            if let c = refuseWrites { throw PaymentsComError(status: 403, code: c) }
            guard var o = orgs[orgId] else { throw PaymentsComError(status: 404, code: "org-not-found") }
            guard write == OrgWalletSync.writeFor(orgId: orgId, blob: blob, issuedAt: write.issuedAt), approval.object != nil else {
                throw PaymentsComError(status: 400, code: "malformed")
            }
            guard blob.version == (OrgWalletSync.parseSealed(o.wallet)?.version ?? 0) + 1 else {
                throw PaymentsComError(status: 409, code: "version-conflict", stored: o.wallet)
            }
            o.wallet = blob.json
            orgs[orgId] = o
            writes.append((orgId, write, approval))
        }
    }

    private func check(_ vouchers: [Voucher]) throws -> [String] {
        guard !vouchers.isEmpty, vouchers.count <= Int(config.maxPerRequest) else { throw PaymentsComError(status: 400, code: "too-many") }
        var seen = Set<String>()
        for v in vouchers {
            let nf = Vouchers.nullifier(v)
            guard let key = MockPaymentsComClient.key, Vouchers.verify(key: key, voucher: v) else { throw PaymentsComError(status: 400, code: "bad-voucher", nullifier: nf) }
            guard seen.insert(nf).inserted else { throw PaymentsComError(status: 400, code: "malformed") }
        }
        let all = vouchers.map(Vouchers.nullifier)
        let spent = all.filter { nullifiers.contains($0) }
        guard spent.isEmpty else { throw PaymentsComError(status: 409, code: "voucher-spent", spent: spent) }
        return all
    }

    public func redeemOrg(orgId: String, for what: String, seats: Int64?, vouchers: [Voucher], route: SpendRoute) async throws -> OrgRedeemResult {
        let now = self.now()
        return try locked {
            guard var o = orgs[orgId] else { throw PaymentsComError(status: 404, code: "org-not-found") }
            let cfg = config
            if what == "overage" {
                guard OrgPlan.state(cfg, o.terms, now: now).status != .lapsed else { throw PaymentsComError(status: 409, code: "overage-needs-plan") }
                nullifiers.formUnion(try check(vouchers))
                redeems.append((orgId, what, nil, vouchers.count))
                return OrgRedeemResult(credited: Int64(vouchers.count), spent: [])
            }
            guard what == "business", let seats else { throw PaymentsComError(status: 400, code: "malformed") }
            guard cfg.isOrgSeatCount(seats) else {
                var e = PaymentsComError(status: 400, code: "org-seats"); e.minSeats = cfg.business.minSeats; e.maxSeats = cfg.business.maxSeats; throw e
            }
            guard seats >= o.liveSeats else { var e = PaymentsComError(status: 409, code: "org-seats-below-live"); e.liveSeats = o.liveSeats; throw e }
            guard OrgPlan.aheadMs(cfg, o.terms, seats: seats, now: now) <= cfg.maxAheadDays * 86_400_000 else {
                throw PaymentsComError(status: 409, code: "plan-paid-ahead")
            }
            let fresh = try check(vouchers)
            nullifiers.formUnion(fresh)
            let end = OrgPlan.paidUntilAfterSpend(cfg, o.terms, seats: seats, n: Int64(fresh.count), now: now)
            o.terms.paidSeats = seats
            o.terms.paidUntil = end
            orgs[orgId] = o
            redeems.append((orgId, what, seats, fresh.count))
            return OrgRedeemResult(credited: Int64(fresh.count), spent: [], seats: seats, paidUntil: end, status: OrgPlan.state(cfg, o.terms, now: now).status)
        }
    }

    public func exchange(keyId: String, vouchers: [Voucher], blinded: [String], route: SpendRoute) async throws -> PaidIssueResult {
        try locked {
            guard keyId == MockPaymentsComClient.key?.keyId else { throw PaymentsComError(status: 409, code: "no-key") }
            guard blinded.count == vouchers.count else { throw PaymentsComError(status: 400, code: "malformed") }
            let all = try check(vouchers)
            let sigs = try payments.sign(blinded)
            nullifiers.formUnion(all)
            exchanges += 1
            return PaidIssueResult(k: keyId, sigs: sigs, units: Int64(sigs.count))
        }
    }

    /// A gym org: trial, paid or lapsed at `now`, with `liveSeats` people.
    public func seed(orgId: String, state: OrgPlanStatus, liveSeats: Int64, now: Int64) {
        let day: Int64 = 86_400_000
        let b = config.business
        let terms: OrgPlanTerms
        switch state {
        case .trial: terms = OrgPlanTerms(trialEndsAt: now + 12 * day, trialSeats: b.trialSeats, paidSeats: 0, paidUntil: 0)
        case .paid: terms = OrgPlanTerms(trialEndsAt: now - 40 * day, trialSeats: b.trialSeats, paidSeats: max(b.minSeats, liveSeats), paidUntil: now + 20 * day)
        case .lapsed: terms = OrgPlanTerms(trialEndsAt: now - 40 * day, trialSeats: b.trialSeats, paidSeats: 0, paidUntil: 0)
        }
        locked { orgs[orgId] = Org(terms: terms, liveSeats: liveSeats) }
    }
}
#endif
