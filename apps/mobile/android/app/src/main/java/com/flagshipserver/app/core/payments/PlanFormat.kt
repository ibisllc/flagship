// What the Plan screen shows, as plain values (unit-tested; the screen only lays them out). Money is shown as round
// amounts in dollars, never as a count of vouchers.

package com.flagshipserver.app.core.payments

import java.text.NumberFormat
import java.util.Currency
import java.util.Locale
import kotlin.math.ceil

object PlanFormat {
    /** "$30" for 30 units of $1 (whole dollars, the locale's currency format). */
    fun usd(units: Long, cfg: PaymentsConfig, locale: Locale = Locale.getDefault()): String {
        val f = NumberFormat.getCurrencyInstance(locale)
        f.currency = Currency.getInstance("USD")
        f.maximumFractionDigits = 0
        f.minimumFractionDigits = 0
        return f.format(units * cfg.unitUsd)
    }

    /** Whole days left on the plan (0 when ended). */
    fun daysLeft(paidUntil: Long, now: Long): Int = if (paidUntil <= now) 0 else ceil((paidUntil - now).toDouble() / PaymentsConfig.DAY_MS).toInt()

    /** The plan has ended but is inside the grace period (it keeps running while a phone pays). */
    fun inGrace(paidUntil: Long, now: Long, cfg: PaymentsConfig): Boolean = paidUntil in 1 until now && paidUntil + cfg.graceHours * 3_600_000L >= now

    /** Whole months of [plan] the balance buys. */
    fun months(balance: Int, plan: String, cfg: PaymentsConfig): Long = VoucherWallets.monthsOfPlan(cfg, plan, balance)

    /** The overage limits offered: off, then one block at a time up to the maximum. */
    fun capOptions(cfg: PaymentsConfig): List<Long> {
        val step = cfg.overage.blockUnits
        return (0..(cfg.overage.maxCapUnits / step)).map { it * step }.take(21)
    }

    /** Gigabytes a limit of [units] buys. */
    fun capGb(units: Long, cfg: PaymentsConfig): Long = units / cfg.overage.blockUnits * cfg.overage.blockGb

    /** Units spent on overage in the month of [now]. */
    fun overageThisMonth(w: VoucherWallet?, now: Long): Long =
        if (w != null && w.overagePeriod == VoucherWallets.overagePeriod(now)) w.overageUnits else 0
}
