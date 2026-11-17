// Settings → Plan and payments (docs/payments-privacy-and-rails.md §6 and "As built"), the Android port in spirit of
// iOS PlanScreen: the plan and time left, the prepaid balance in round amounts, the plan choice with the optional
// random start, automatic paying, the monthly limit for extra traffic, and the shop, whose rails are placeholders until
// later steps fill them in. Never a code field, a scan or a file import for vouchers.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.core.payments.PaymentsCenter
import com.flagshipserver.app.core.payments.PaymentsConfig
import com.flagshipserver.app.core.payments.PaymentsUi
import com.flagshipserver.app.core.payments.PlanFormat
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.Switch
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

/** The refusal sentence for a `.com` code (the codes are protocol, the sentences i18n). */
object PaymentsCopy {
    fun error(code: String): String = when (code) {
        "overage-needs-plan" -> FSStrings.get(R.string.payments_error_overage_needs_plan)
        "no-key", "issue-off" -> FSStrings.get(R.string.payments_error_not_available)
        "unavailable" -> FSStrings.get(R.string.payments_error_unavailable)
        else -> FSStrings.get(R.string.payments_error_generic)
    }

    fun planName(plan: String?): String = when (plan) {
        PaymentsConfig.PRO -> FSStrings.get(R.string.payments_plan_pro)
        PaymentsConfig.PRO_MAX -> FSStrings.get(R.string.payments_plan_pro_max)
        else -> FSStrings.get(R.string.payments_plan_free)
    }
}

@Composable
fun PlanScreen(nav: NavController) {
    val center = PaymentsCenter.shared
    if (center == null) {
        FSScreen(title = stringResource(R.string.payments_title), onBack = { nav.popBackStack() }) {
            Text(stringResource(R.string.payments_error_not_available), modifier = Modifier.testTag("plan-unavailable"))
        }
        return
    }
    val s by center.state.collectAsState()
    LaunchedEffect(Unit) {
        center.refresh()
        center.tick()
    }
    FSScreen(
        title = stringResource(R.string.payments_title),
        titleTag = "plan-title",
        onBack = { nav.popBackStack() },
    ) {
        PlanBody(center, s)
    }
}

@Composable
private fun PlanBody(center: PaymentsCenter, s: PaymentsUi) {
    val scope = rememberCoroutineScope()
    val now = System.currentTimeMillis()
    val cfg = s.config
    var delay by remember(s.wallet?.settings?.delayStart) { mutableStateOf(s.wallet?.settings?.delayStart ?: false) }
    val editable = s.canSpend && !s.busy

    // Current plan and time left.
    FSCard(modifier = Modifier.testTag("plan-current")) {
        Text(PaymentsCopy.planName(s.plan), style = MaterialTheme.typography.titleLarge)
        val line = when {
            s.plan == null -> stringResource(R.string.payments_current_free)
            PlanFormat.inGrace(s.paidUntil, now, cfg) -> stringResource(R.string.payments_in_grace)
            else -> {
                val days = PlanFormat.daysLeft(s.paidUntil, now)
                FSStrings.plural(R.plurals.payments_days_left, days, days, DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(s.paidUntil)))
            }
        }
        Text(line, style = MaterialTheme.typography.bodyMedium, color = FS.colors.textMuted, modifier = Modifier.testTag("plan-time-left"))
    }

    // Balance, as round amounts.
    FSGroup(header = stringResource(R.string.payments_balance_title)) {
        when {
            !s.canOpen -> FSRow(title = stringResource(R.string.payments_locked), modifier = Modifier.testTag("plan-balance-locked"))
            s.balance == 0 -> FSRow(title = stringResource(R.string.payments_balance_empty), modifier = Modifier.testTag("plan-balance"))
            else -> {
                val plan = s.chosenPlan ?: s.plan ?: PaymentsConfig.PRO
                val months = PlanFormat.months(s.balance, plan, cfg).toInt()
                FSRow(
                    title = PlanFormat.usd(s.balance.toLong(), cfg),
                    subtitle = FSStrings.plural(R.plurals.payments_balance_months, months, months, PaymentsCopy.planName(plan)),
                    modifier = Modifier.testTag("plan-balance"),
                )
            }
        }
    }

    // Choose the plan.
    FSGroup(header = stringResource(R.string.payments_choose_title)) {
        val chosen = s.chosenPlan
        val options = listOf<String?>(null, PaymentsConfig.PRO, PaymentsConfig.PRO_MAX)
        options.forEachIndexed { i, p ->
            if (i > 0) FSDivider(0.dp)
            val subtitle = if (p == null) stringResource(R.string.payments_plan_free_note)
            else fsString(R.string.payments_plan_price, PlanFormat.usd(cfg.plan(p).unitsPerMonth, cfg), cfg.plan(p).includedGb)
            FSRow(
                title = PaymentsCopy.planName(p),
                subtitle = subtitle,
                enabled = editable,
                modifier = Modifier
                    .selectable(selected = chosen == p, enabled = editable, onClick = {
                        scope.launch { center.choosePlan(p, delay, FSStrings.get(R.string.payments_confirm_reason)) }
                    })
                    .testTag("plan-choose-${p ?: "free"}"),
                trailing = { RadioButton(selected = chosen == p, onClick = null, enabled = editable) },
            )
        }
        FSDivider(0.dp)
        FSRow(
            title = fsString(R.string.payments_delay_start, cfg.activationDelayMaxHours),
            subtitle = stringResource(R.string.payments_delay_note),
            enabled = editable,
            trailing = { Switch(checked = delay, onCheckedChange = { delay = it }, enabled = editable, modifier = Modifier.testTag("plan-delay-start")) },
        )
        FSDivider(0.dp)
        FSRow(
            title = stringResource(R.string.payments_autopay),
            subtitle = stringResource(R.string.payments_autopay_note),
            enabled = editable,
            trailing = {
                Switch(
                    checked = s.wallet?.settings?.autoPay ?: true,
                    onCheckedChange = { on -> scope.launch { center.setAutoPay(on) } },
                    enabled = editable,
                    modifier = Modifier.testTag("plan-autopay"),
                )
            },
        )
    }

    // Extra traffic: prepaid blocks within a monthly limit, then slowed.
    FSGroup(header = stringResource(R.string.payments_overage_title)) {
        val cap = s.wallet?.settings?.overageCapUnits ?: cfg.overage.defaultCapUnits
        val opts = PlanFormat.capOptions(cfg)
        val idx = opts.indexOf(cap).coerceAtLeast(0)
        FSRow(
            title = stringResource(R.string.payments_overage_cap),
            subtitle = if (cap == 0L) stringResource(R.string.payments_overage_cap_off)
            else fsString(R.string.payments_overage_cap_value, PlanFormat.usd(cap, cfg), PlanFormat.capGb(cap, cfg)),
            enabled = editable,
            modifier = Modifier.testTag("plan-overage-cap"),
            trailing = {
                androidx.compose.foundation.layout.Row {
                    androidx.compose.material3.TextButton(
                        onClick = { scope.launch { center.setOverageCap(opts[idx - 1]) } },
                        enabled = editable && idx > 0,
                        modifier = Modifier.testTag("plan-overage-less"),
                    ) { androidx.compose.material3.Icon(androidx.compose.material.icons.Icons.Outlined.Remove, contentDescription = stringResource(R.string.payments_overage_less)) }
                    androidx.compose.material3.TextButton(
                        onClick = { scope.launch { center.setOverageCap(opts[idx + 1]) } },
                        enabled = editable && idx < opts.size - 1,
                        modifier = Modifier.testTag("plan-overage-more"),
                    ) { androidx.compose.material3.Icon(androidx.compose.material.icons.Icons.Outlined.Add, contentDescription = stringResource(R.string.payments_overage_more)) }
                }
            },
        )
        FSDivider(0.dp)
        FSRow(
            title = fsString(R.string.payments_overage_this_month, PlanFormat.usd(PlanFormat.overageThisMonth(s.wallet, now), cfg)),
            subtitle = fsString(R.string.payments_overage_note, cfg.overage.blockGb, PlanFormat.usd(cfg.overage.blockUnits, cfg)),
        )
    }

    // The shop: placeholders until the rails land.
    FSGroup(header = stringResource(R.string.payments_buy_title)) {
        cfg.packs.forEachIndexed { i, units ->
            if (i > 0) FSDivider(0.dp)
            FSRow(
                title = fsString(R.string.payments_pack_add, PlanFormat.usd(units, cfg)),
                subtitle = stringResource(R.string.payments_buy_not_yet),
                enabled = false,
                modifier = Modifier.testTag("plan-pack-$units"),
            )
        }
        for ((res, tag) in listOf(R.string.payments_rail_play to "play", R.string.payments_rail_card to "card", R.string.payments_rail_monero to "monero")) {
            FSDivider(0.dp)
            FSRow(title = stringResource(res), subtitle = stringResource(R.string.payments_buy_not_yet), enabled = false, modifier = Modifier.testTag("plan-rail-$tag"))
        }
    }
    Text(stringResource(R.string.payments_buy_note), style = MaterialTheme.typography.bodySmall, color = FS.colors.textMuted, modifier = Modifier.padding(horizontal = FS.space.s4))

    if (s.testIssue && s.canSpend) {
        FSSecondaryButton(
            label = stringResource(R.string.payments_test_add),
            onClick = { scope.launch { center.addTestVouchers() } },
            enabled = !s.busy,
            modifier = Modifier.testTag("plan-test-add"),
        )
    }
    if (!s.isAdmin) {
        Text(stringResource(R.string.payments_read_only), style = MaterialTheme.typography.bodySmall, color = FS.colors.textMuted, modifier = Modifier.testTag("plan-read-only"))
    }
    s.error?.let { Text(PaymentsCopy.error(it), color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("plan-error")) }
}
