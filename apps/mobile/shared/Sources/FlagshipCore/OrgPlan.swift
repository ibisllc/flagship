import Foundation

/// The Business plan for an org (docs/plans-and-backup-offer.md §3, §6). Swift twin of packages/protocol/src/orgPlan.ts,
/// pinned by test-vectors/org-plan/ (`state`, `spend`, `trickle`, `egress`). Every number comes from
/// `PaymentsConfig.business`.
///
///   status   trial   now < trialEndsAt
///            paid    paidSeats > 0 and now <= paidUntil + grace
///            lapsed  neither: no new seats, servers or connectors; everything that exists keeps working
///   spend    n vouchers for `seats` seats buy n × orgSeatUnitMs(seats); paid time starts when the trial ends; a
///            different seat count converts the time left at the ratio of the two unit lengths
public enum OrgPlanStatus: String, Sendable, Equatable, CaseIterable { case trial, paid, lapsed }

public struct OrgPlanTerms: Equatable, Sendable {
    public var trialEndsAt: Int64
    public var trialSeats: Int64
    /// Seats the vouchers spent so far pay for (0: none yet).
    public var paidSeats: Int64
    /// End of the paid time, epoch ms (0: none yet).
    public var paidUntil: Int64
    public init(trialEndsAt: Int64, trialSeats: Int64, paidSeats: Int64, paidUntil: Int64) {
        self.trialEndsAt = trialEndsAt; self.trialSeats = trialSeats; self.paidSeats = paidSeats; self.paidUntil = paidUntil
    }
}

public struct OrgPlanState: Equatable, Sendable {
    public var terms: OrgPlanTerms
    public var status: OrgPlanStatus
    /// How many live seats the org may hold now.
    public var seatLimit: Int64
    /// When the org lapses if nothing more is spent.
    public var coveredUntil: Int64
    public init(terms: OrgPlanTerms, status: OrgPlanStatus, seatLimit: Int64, coveredUntil: Int64) {
        self.terms = terms; self.status = status; self.seatLimit = seatLimit; self.coveredUntil = coveredUntil
    }
}

public enum OrgPlan {
    static let dayMs: Int64 = 86_400_000

    static func graceMs(_ cfg: PaymentsConfig) -> Int64 { cfg.graceHours * 3_600_000 }

    public static func state(_ cfg: PaymentsConfig, _ t: OrgPlanTerms, now: Int64) -> OrgPlanState {
        let inTrial = now < t.trialEndsAt
        let paid = t.paidSeats > 0 && t.paidUntil > 0 && now <= t.paidUntil + graceMs(cfg)
        let status: OrgPlanStatus = inTrial ? .trial : paid ? .paid : .lapsed
        let seatLimit = inTrial ? max(t.trialSeats, t.paidSeats) : t.paidSeats > 0 ? t.paidSeats : t.trialSeats
        let coveredUntil = max(t.trialEndsAt, t.paidSeats > 0 ? t.paidUntil : 0)
        return OrgPlanState(terms: t, status: status, seatLimit: seatLimit, coveredUntil: coveredUntil)
    }

    /// The org's new paid end after `n` vouchers for `seats` seats (n = 0: where a spend would start).
    public static func paidUntilAfterSpend(_ cfg: PaymentsConfig, _ t: OrgPlanTerms, seats: Int64, n: Int64, now: Int64) -> Int64 {
        let unit = cfg.orgSeatUnitMs(seats)
        let start = max(now, t.trialEndsAt)
        var base = start
        if t.paidSeats > 0, t.paidUntil > 0, t.paidUntil + graceMs(cfg) >= now {
            if t.paidSeats == seats {
                base = t.paidUntil
            } else if t.paidUntil > start {
                // As the TS Math.floor(((paidUntil - start) * unit) / unit(paidSeats)), in doubles.
                base = start + Int64((Double(t.paidUntil - start) * Double(unit) / Double(cfg.orgSeatUnitMs(t.paidSeats))).rounded(.down))
            }
        }
        return base + n * unit
    }

    /// How far ahead the org is covered for `seats` seats, the trial included.
    public static func aheadMs(_ cfg: PaymentsConfig, _ t: OrgPlanTerms, seats: Int64, now: Int64) -> Int64 {
        paidUntilAfterSpend(cfg, t, seats: seats, n: 0, now: now) - now
    }

    public struct TrickleInput: Equatable, Sendable {
        public var now: Int64
        public var enabled: Bool
        public var balance: Int64
        public var terms: OrgPlanTerms
        public var seats: Int64
        public var nextSpendAt: Int64
        public init(now: Int64, enabled: Bool, balance: Int64, terms: OrgPlanTerms, seats: Int64, nextSpendAt: Int64) {
            self.now = now; self.enabled = enabled; self.balance = balance; self.terms = terms; self.seats = seats; self.nextSpendAt = nextSpendAt
        }
    }

    /// One tick of the org wallet's trickle: the personal `trickleStep` with the org's unit length and lead.
    public static func trickleStep(_ cfg: PaymentsConfig, _ o: TrickleInput, rand: Double) -> (spend: Int64, nextSpendAt: Int64) {
        VoucherSpending.trickleStep(.init(
            now: o.now, enabled: o.enabled, balance: o.balance, aheadMs: aheadMs(cfg, o.terms, seats: o.seats, now: o.now), startAt: 0,
            nextSpendAt: o.nextSpendAt, unitMs: cfg.orgSeatUnitMs(o.seats), lowWaterMs: cfg.trickle.lowWaterDays * dayMs,
            highWaterMs: cfg.trickle.highWaterDays * dayMs, maxPerRequest: cfg.maxPerRequest), rand: rand)
    }

    /// The org's pooled public egress in GB while on trial or paid; nil when lapsed (the Free allowance).
    public static func egressGb(_ cfg: PaymentsConfig, _ st: OrgPlanState) -> Int64? {
        st.status == .lapsed ? nil : st.seatLimit * cfg.business.egressGbPerSeat
    }

    public static func trialTerms(_ cfg: PaymentsConfig, now: Int64) -> OrgPlanTerms {
        OrgPlanTerms(trialEndsAt: now + cfg.business.trialDays * dayMs, trialSeats: cfg.business.trialSeats, paidSeats: 0, paidUntil: 0)
    }

    /// About how many months a balance pays for at `seats` seats (`balance / (seats × unitsPerSeatMonth)`).
    public static func monthsCovered(_ cfg: PaymentsConfig, balance: Int64, seats: Int64) -> Double {
        let per = cfg.orgMonthlyUnits(max(1, seats))
        return per > 0 ? Double(balance) / Double(per) : 0
    }
}
