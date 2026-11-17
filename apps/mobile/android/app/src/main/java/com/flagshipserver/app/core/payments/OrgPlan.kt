// The Business plan for an org: the Kotlin twin of packages/protocol/src/orgPlan.ts (vectors:
// test-vectors/org-plan `state`, `spend`, `trickle`, `egress`). An org pays per seat in the same $1 vouchers, from its
// own wallet (OrgWallet.kt); every number comes from PaymentsConfig.business.

package com.flagshipserver.app.core.payments

import kotlin.math.floor

data class OrgPlanTerms(val trialEndsAt: Long, val trialSeats: Long, val paidSeats: Long, val paidUntil: Long)

data class OrgPlanState(val terms: OrgPlanTerms, val status: String, val seatLimit: Long, val coveredUntil: Long)

data class OrgTrickleInput(val now: Long, val enabled: Boolean, val balance: Long, val terms: OrgPlanTerms, val seats: Long, val nextSpendAt: Long)

object OrgPlans {
    const val TRIAL = "trial"
    const val PAID = "paid"
    const val LAPSED = "lapsed"
    val STATUSES = listOf(TRIAL, PAID, LAPSED)

    private fun graceMs(cfg: PaymentsConfig) = cfg.graceHours * 3_600_000L

    fun state(cfg: PaymentsConfig, t: OrgPlanTerms, now: Long): OrgPlanState {
        val inTrial = now < t.trialEndsAt
        val paid = t.paidSeats > 0 && t.paidUntil > 0 && now <= t.paidUntil + graceMs(cfg)
        val status = if (inTrial) TRIAL else if (paid) PAID else LAPSED
        val seatLimit = if (inTrial) maxOf(t.trialSeats, t.paidSeats) else if (t.paidSeats > 0) t.paidSeats else t.trialSeats
        val coveredUntil = maxOf(t.trialEndsAt, if (t.paidSeats > 0) t.paidUntil else 0)
        return OrgPlanState(t, status, seatLimit, coveredUntil)
    }

    /** The paid end after [n] vouchers for [seats] seats (n = 0: where a spend would start). Doubles, as the TS does. */
    fun paidUntilAfterSpend(cfg: PaymentsConfig, t: OrgPlanTerms, seats: Long, n: Long, now: Long): Long {
        val unit = cfg.orgSeatUnitMs(seats)
        val start = maxOf(now, t.trialEndsAt)
        var base = start
        if (t.paidSeats > 0 && t.paidUntil > 0 && t.paidUntil + graceMs(cfg) >= now) {
            if (t.paidSeats == seats) {
                base = t.paidUntil
            } else if (t.paidUntil > start) {
                base = start + floor(((t.paidUntil - start).toDouble() * unit.toDouble()) / cfg.orgSeatUnitMs(t.paidSeats).toDouble()).toLong()
            }
        }
        return base + n * unit
    }

    fun aheadMs(cfg: PaymentsConfig, t: OrgPlanTerms, seats: Long, now: Long): Long = paidUntilAfterSpend(cfg, t, seats, 0, now) - now

    fun trickleStep(cfg: PaymentsConfig, o: OrgTrickleInput, rand: Double): TrickleOut = VoucherWallets.trickleStep(
        TrickleInput(
            now = o.now,
            enabled = o.enabled,
            balance = o.balance,
            aheadMs = aheadMs(cfg, o.terms, o.seats, o.now),
            startAt = 0,
            nextSpendAt = o.nextSpendAt,
            unitMs = cfg.orgSeatUnitMs(o.seats),
            lowWaterMs = cfg.lowWaterDays * PaymentsConfig.DAY_MS,
            highWaterMs = cfg.highWaterDays * PaymentsConfig.DAY_MS,
            maxPerRequest = cfg.maxPerRequest,
        ),
        rand,
    )

    /** The org's pooled public egress in GB while on trial or paid (lapsed: null, the Free allowance). */
    fun egressGb(cfg: PaymentsConfig, status: String, seatLimit: Long): Long? =
        if (status == LAPSED) null else seatLimit * cfg.business.egressGbPerSeat

    fun trialTerms(cfg: PaymentsConfig, now: Long) =
        OrgPlanTerms(now + cfg.business.trialDays * PaymentsConfig.DAY_MS, cfg.business.trialSeats, 0, 0)
}
