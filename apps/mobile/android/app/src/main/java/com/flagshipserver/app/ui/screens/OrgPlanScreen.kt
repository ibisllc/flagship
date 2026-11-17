// An organization's Plan (docs/plans-and-backup-offer.md §3, §3.4, §6): Business per seat, paid from the org's own
// voucher wallet. Every seat sees the status and the seats; only org admins see the balance and act on it. Android
// imports voucher files (an invoiced batch bought on the web); batches themselves are bought on the web only.

package com.flagshipserver.app.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.core.payments.OrgPaymentsCenter
import com.flagshipserver.app.core.payments.OrgPlanNotice
import com.flagshipserver.app.core.payments.OrgPlanUi
import com.flagshipserver.app.core.payments.OrgPlans
import com.flagshipserver.app.core.payments.PaymentsCenter
import com.flagshipserver.app.core.payments.PlanFormat
import com.flagshipserver.app.core.payments.ShopUi
import com.flagshipserver.app.core.payments.VoucherShop
import com.flagshipserver.app.keystore.OrgSeatRecord
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.Switch
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.OrgPlanCenters
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import kotlin.math.floor

/** The sentences for the org plan's states and refusals (the codes are protocol, the sentences i18n). */
object OrgPlanCopy {
    fun status(s: OrgPlanUi, now: Long): String? {
        val p = s.served ?: return null
        return when (p.status) {
            OrgPlans.TRIAL -> {
                val days = PlanFormat.daysLeft(p.trialEndsAt, now)
                FSStrings.plural(R.plurals.org_plan_status_trial, days, days)
            }
            OrgPlans.PAID -> FSStrings.get(R.string.org_plan_status_paid, DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(p.paidUntil)))
            else -> FSStrings.get(R.string.org_plan_status_lapsed)
        }
    }

    fun error(code: String): String = when (code) {
        "locked" -> FSStrings.get(R.string.org_plan_error_locked)
        "org-seats-below-live" -> FSStrings.get(R.string.org_plan_error_below_live)
        "org-seats" -> FSStrings.get(R.string.org_plan_error_seats)
        "org-not-found" -> FSStrings.get(R.string.org_plan_error_not_found)
        "file-bad" -> FSStrings.get(R.string.org_plan_file_bad)
        "file-unknown-key" -> FSStrings.get(R.string.org_plan_file_unknown_key)
        "file-too-many" -> FSStrings.get(R.string.org_plan_file_too_many)
        else -> if (code.startsWith("org-")) FSStrings.get(R.string.org_plan_error_not_admin) else FSStrings.get(R.string.org_plan_error_generic)
    }
}

/** The Plan line on the org page: the status, and a way in. */
@Composable
fun OrgPlanEntry(seat: OrgSeatRecord, onOpen: () -> Unit) {
    val center = remember(seat.id) { OrgPlanCenters.get(seat) } ?: return
    val s by center.state.collectAsState()
    LaunchedEffect(seat.id) { center.refresh(interactive = false) }
    val now = System.currentTimeMillis()
    FSGroup(header = stringResource(R.string.org_plan_title)) {
        FSRow(
            title = OrgPlanCopy.status(s, now) ?: stringResource(R.string.org_plan_title),
            subtitle = if (s.served?.status == OrgPlans.LAPSED) stringResource(R.string.org_plan_lapsed_note) else null,
            onClick = onOpen,
            modifier = Modifier.testTag("org-open-plan"),
        )
    }
}

/** Settings → Organizations → an org → Plan. */
@Composable
fun OrgPlanScreen(seat: OrgSeatRecord, nav: NavController) {
    val center = remember(seat.id) { OrgPlanCenters.get(seat) }
    FSScreen(title = stringResource(R.string.org_plan_title), titleTag = "org-plan-title", onBack = { nav.popBackStack() }) {
        if (center == null) {
            Text(stringResource(R.string.org_plan_error_generic), modifier = Modifier.testTag("org-plan-unavailable"))
            return@FSScreen
        }
        val s by center.state.collectAsState()
        val shop = VoucherShop.shared
        val shopUi by (shop?.state ?: remember { kotlinx.coroutines.flow.MutableStateFlow(ShopUi()) }).collectAsState()
        LaunchedEffect(seat.id) {
            runCatching { PaymentsCenter.shared?.refresh() }
            center.refresh(interactive = !seat.memberOnly)
            center.tick()
            shop?.load()
        }
        OrgPlanBody(seat, center, s, shop, shopUi)
    }
}

@Composable
private fun OrgPlanBody(seat: OrgSeatRecord, center: OrgPaymentsCenter, s: OrgPlanUi, shop: VoucherShop?, shopUi: ShopUi) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val now = System.currentTimeMillis()
    val cfg = s.config
    val p = s.served
    if (!s.loaded) {
        CircularProgressIndicator()
        return
    }
    val usd = { units: Long -> PlanFormat.usd(units, cfg.copy(unitUsd = s.unitUsd)) }

    FSCard(modifier = Modifier.testTag("org-plan-current")) {
        Text(OrgPlanCopy.status(s, now) ?: stringResource(R.string.org_plan_error_generic), style = MaterialTheme.typography.titleLarge, modifier = Modifier.testTag("org-plan-status"))
        when (p?.status) {
            OrgPlans.TRIAL -> Text(stringResource(R.string.org_plan_trial_note), style = MaterialTheme.typography.bodyMedium, color = FS.colors.textMuted, modifier = Modifier.testTag("org-plan-trial-note"))
            OrgPlans.LAPSED -> Text(stringResource(R.string.org_plan_lapsed_note), style = MaterialTheme.typography.bodyMedium, color = FS.colors.warning, modifier = Modifier.testTag("org-plan-lapsed"))
            else -> Unit
        }
    }

    FSGroup(header = stringResource(R.string.org_plan_seats_title)) {
        if (p != null) {
            FSRow(title = fsString(R.string.org_plan_seats_used, p.liveSeats, p.seatLimit), modifier = Modifier.testTag("org-plan-seats-used"))
            FSDivider(0.dp)
        }
        val editable = s.canPay && !s.busy
        FSRow(
            title = fsString(R.string.org_plan_seats_paid, s.seats),
            subtitle = fsString(R.string.org_plan_price, usd(s.unitsPerSeatMonth), usd(s.seats * s.unitsPerSeatMonth)),
            modifier = Modifier.testTag("org-plan-seats"),
            trailing = {
                if (s.isAdmin) {
                    Row {
                        TextButton(
                            onClick = { scope.launch { center.setSeats(s.seats - 1) } },
                            enabled = editable && s.seats > s.minSeats,
                            modifier = Modifier.testTag("org-plan-seats-less"),
                        ) { Icon(Icons.Outlined.Remove, contentDescription = stringResource(R.string.org_plan_seats_less)) }
                        TextButton(
                            onClick = { scope.launch { center.setSeats(s.seats + 1) } },
                            enabled = editable && s.seats < s.maxSeats,
                            modifier = Modifier.testTag("org-plan-seats-more"),
                        ) { Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.org_plan_seats_more)) }
                    }
                }
            },
        )
    }

    if (!s.isAdmin) {
        Text(stringResource(R.string.org_plan_admins_only), style = MaterialTheme.typography.bodySmall, color = FS.colors.textMuted, modifier = Modifier.testTag("org-plan-read-only"))
        s.error?.let { Text(OrgPlanCopy.error(it), color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("org-plan-error")) }
        return
    }

    FSGroup(header = stringResource(R.string.org_plan_balance_title)) {
        when {
            !s.canOpen -> FSRow(
                title = stringResource(R.string.org_plan_locked),
                onClick = { scope.launch { center.refresh(interactive = true) } },
                modifier = Modifier.testTag("org-plan-balance-locked"),
            )
            s.balance == 0 -> FSRow(title = stringResource(R.string.org_plan_balance_empty), modifier = Modifier.testTag("org-plan-balance"))
            else -> {
                val months = floor(s.monthsCovered).toInt()
                FSRow(
                    title = usd(s.balance.toLong()),
                    subtitle = if (months < 1) fsString(R.string.org_plan_balance_under_month, s.seats)
                    else FSStrings.plural(R.plurals.org_plan_balance_months, months, months, s.seats),
                    modifier = Modifier.testTag("org-plan-balance"),
                )
            }
        }
        if (s.canOpen) {
            FSDivider(0.dp)
            FSRow(
                title = stringResource(R.string.org_plan_autopay),
                subtitle = stringResource(R.string.org_plan_autopay_note),
                enabled = s.canPay && !s.busy,
                trailing = {
                    Switch(
                        checked = s.wallet?.settings?.autoPay ?: true,
                        onCheckedChange = { on -> scope.launch { center.setAutoPay(on) } },
                        enabled = s.canPay && !s.busy,
                        modifier = Modifier.testTag("org-plan-autopay"),
                    )
                },
            )
        }
    }

    if (s.canPay) {
        val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri == null) return@rememberLauncherForActivityResult
            scope.launch {
                val text = runCatching {
                    context.contentResolver.openInputStream(uri)?.use { input ->
                        val out = java.io.ByteArrayOutputStream()
                        val buf = ByteArray(64 * 1024)
                        while (out.size() <= MAX_FILE_BYTES) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                        }
                        if (out.size() > MAX_FILE_BYTES) null else out.toByteArray().toString(Charsets.UTF_8)
                    }
                }.getOrNull()
                if (text == null) center.refuse("file-bad") else center.importFile(text)
            }
        }
        FSGroup(header = stringResource(R.string.org_plan_buy_title)) {
            if (shop != null && shopUi.available) {
                shopUi.products.forEachIndexed { i, prod ->
                    if (i > 0) FSDivider(0.dp)
                    FSRow(
                        title = fsString(R.string.org_plan_pack_add, usd(prod.units)),
                        subtitle = prod.price,
                        enabled = !shopUi.working && !s.busy,
                        onClick = { scope.launch { shop.buy(prod, org = seat.orgId) } },
                        modifier = Modifier.testTag("org-plan-pack-${prod.units}"),
                    )
                }
            } else {
                FSRow(title = stringResource(R.string.org_plan_buy_unavailable), enabled = false, modifier = Modifier.testTag("org-plan-shop-unavailable"))
            }
            FSDivider(0.dp)
            FSRow(
                title = stringResource(R.string.org_plan_import),
                enabled = !s.busy,
                onClick = { picker.launch(arrayOf("application/json", "application/octet-stream", "text/plain")) },
                modifier = Modifier.testTag("org-plan-import"),
            )
        }
        Text(stringResource(R.string.org_plan_batch_note), style = MaterialTheme.typography.bodySmall, color = FS.colors.textMuted, modifier = Modifier.padding(horizontal = FS.space.s4).testTag("org-plan-batch-note"))
    }

    s.notice?.let { n ->
        val line = when (n) {
            is OrgPlanNotice.Added -> fsString(R.string.org_plan_added, usd(n.count.toLong()))
            is OrgPlanNotice.Refused -> OrgPlanCopy.error(n.code)
        }
        Text(
            line,
            style = MaterialTheme.typography.bodyMedium,
            color = if (n is OrgPlanNotice.Added) FS.colors.textMuted else MaterialTheme.colorScheme.error,
            modifier = Modifier.padding(horizontal = FS.space.s4).testTag("org-plan-notice"),
        )
    }
    s.error?.let { Column { Text(OrgPlanCopy.error(it), color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("org-plan-error")) } }
}

private const val MAX_FILE_BYTES = 3_000_000
