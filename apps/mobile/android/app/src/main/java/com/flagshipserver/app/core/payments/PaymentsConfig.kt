// Every payment number in one place: the Kotlin twin of packages/protocol/src/paymentsConfig.ts. The app reads the
// live copy from `GET /api/payments/config` and falls back to these defaults (the vectors pin them).

package com.flagshipserver.app.core.payments

import com.flagshipserver.app.core.voici.VoiciJs
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.floor

data class PlanNumbers(val unitsPerMonth: Long, val includedGb: Long)

data class OverageNumbers(val blockUnits: Long, val blockGb: Long, val defaultCapUnits: Long, val maxCapUnits: Long, val buyBelowGb: Long)

data class PaymentsConfig(
    val unitUsd: Long = 1,
    val monthDays: Long = 30,
    val plans: Map<String, PlanNumbers> = mapOf(PRO to PlanNumbers(10, 250), PRO_MAX to PlanNumbers(20, 500)),
    val overage: OverageNumbers = OverageNumbers(5, 100, 10, 100, 10),
    val graceHours: Long = 72,
    val maxAheadDays: Long = 35,
    val lowWaterDays: Long = 3,
    val highWaterDays: Long = 10,
    val activationDelayMaxHours: Long = 24,
    val packs: List<Long> = listOf(10, 30, 120),
    val maxPerRequest: Long = 30,
) {
    fun plan(p: String): PlanNumbers = plans[p] ?: plans.getValue(PRO)

    /** How long one voucher keeps [p] running (Pro 3 days, Pro Max 36 hours). */
    fun unitMs(p: String): Long = floor((monthDays * DAY_MS).toDouble() / plan(p).unitsPerMonth.toDouble()).toLong()

    fun toJson(): JsonObject {
        fun n(v: Long) = JsonPrimitive(v)
        fun planJson(p: PlanNumbers) = JsonObject(mapOf("unitsPerMonth" to n(p.unitsPerMonth), "includedGb" to n(p.includedGb)))
        return JsonObject(
            mapOf(
                "v" to n(1),
                "unitUsd" to n(unitUsd),
                "monthDays" to n(monthDays),
                "plans" to JsonObject(mapOf(PRO to planJson(plan(PRO)), PRO_MAX to planJson(plan(PRO_MAX)))),
                "overage" to JsonObject(
                    mapOf(
                        "blockUnits" to n(overage.blockUnits), "blockGb" to n(overage.blockGb), "defaultCapUnits" to n(overage.defaultCapUnits),
                        "maxCapUnits" to n(overage.maxCapUnits), "buyBelowGb" to n(overage.buyBelowGb),
                    ),
                ),
                "graceHours" to n(graceHours),
                "maxAheadDays" to n(maxAheadDays),
                "trickle" to JsonObject(mapOf("lowWaterDays" to n(lowWaterDays), "highWaterDays" to n(highWaterDays))),
                "activationDelayMaxHours" to n(activationDelayMaxHours),
                "packs" to JsonArray(packs.map(::n)),
                "maxPerRequest" to n(maxPerRequest),
            ),
        )
    }

    companion object {
        const val PRO = "pro"
        const val PRO_MAX = "pro-max"
        val PAID_PLANS = listOf(PRO, PRO_MAX)
        const val DAY_MS = 86_400_000L
        val DEFAULT = PaymentsConfig()

        fun isPaidPlan(p: String?) = p == PRO || p == PRO_MAX

        /** The plan for a `.com` tier (hobby = Pro, maker = Pro Max), or null for free. */
        fun planOfTier(tier: String?): String? = when (tier) { "hobby" -> PRO; "maker" -> PRO_MAX; else -> null }

        /** The defaults with any valid overrides from [raw]; invalid fields keep the default. graceHours is fixed. */
        fun merge(raw: JsonElement?): PaymentsConfig {
            val d = DEFAULT
            val o = VoiciJs.obj(raw) ?: return d
            fun num(v: JsonElement?, fallback: Long, max: Long = 1_000_000): Long = VoiciJs.safeInt(v)?.takeIf { it in 1..max } ?: fallback
            val plans = VoiciJs.obj(o["plans"])
            fun plan(p: String): PlanNumbers {
                val x = VoiciJs.obj(plans?.get(p))
                return PlanNumbers(num(x?.get("unitsPerMonth"), d.plan(p).unitsPerMonth, 1000), num(x?.get("includedGb"), d.plan(p).includedGb))
            }
            val ov = VoiciJs.obj(o["overage"])
            val tr = VoiciJs.obj(o["trickle"])
            val packsArr = VoiciJs.arr(o["packs"])
            val packs = packsArr?.takeIf { a -> a.size in 1..6 && a.all { VoiciJs.safeInt(it)?.let { n -> n in 1..1000 } == true } }
                ?.map { VoiciJs.safeInt(it)!! } ?: d.packs
            var out = PaymentsConfig(
                unitUsd = num(o["unitUsd"], d.unitUsd, 100),
                monthDays = num(o["monthDays"], d.monthDays, 31),
                plans = mapOf(PRO to plan(PRO), PRO_MAX to plan(PRO_MAX)),
                overage = OverageNumbers(
                    num(ov?.get("blockUnits"), d.overage.blockUnits, 100),
                    num(ov?.get("blockGb"), d.overage.blockGb),
                    num(ov?.get("defaultCapUnits"), d.overage.defaultCapUnits, 1000),
                    num(ov?.get("maxCapUnits"), d.overage.maxCapUnits, 10_000),
                    num(ov?.get("buyBelowGb"), d.overage.buyBelowGb),
                ),
                graceHours = d.graceHours,
                maxAheadDays = num(o["maxAheadDays"], d.maxAheadDays, 400),
                lowWaterDays = num(tr?.get("lowWaterDays"), d.lowWaterDays, 60),
                highWaterDays = num(tr?.get("highWaterDays"), d.highWaterDays, 120),
                activationDelayMaxHours = num(o["activationDelayMaxHours"], d.activationDelayMaxHours, 24 * 7),
                packs = packs.sorted(),
                maxPerRequest = num(o["maxPerRequest"], d.maxPerRequest, 200),
            )
            if (out.highWaterDays <= out.lowWaterDays || out.maxAheadDays <= out.highWaterDays) out = out.copy(lowWaterDays = d.lowWaterDays, highWaterDays = d.highWaterDays)
            if (out.maxAheadDays <= out.highWaterDays) out = out.copy(maxAheadDays = d.maxAheadDays)
            return out
        }
    }
}
