// A voucher link opened on this phone (docs/anonymous-vouchers.md "Voucher links"): "Add N vouchers ($N) to this
// account's wallet?", or why nothing can be added. Checked and added here alone; the spend happens later through the
// normal trickle, so the time of the purchase doesn't tie it to the account. This screen only receives vouchers: it
// never links or points to the web shop (Play's payments policy).

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.payments.PaymentsCenter
import com.flagshipserver.app.core.payments.PlanFormat
import com.flagshipserver.app.core.payments.VoucherLinkCopy
import com.flagshipserver.app.core.payments.VoucherLinkPreview
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

@Composable
fun VoucherLinkDialog(rawLink: String, onDismiss: () -> Unit, center: PaymentsCenter? = PaymentsCenter.shared) {
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    // Looked at again once Plan's numbers load (a cold start opened by the link): the keys this phone holds may arrive.
    val ui = center?.state?.collectAsState()?.value
    var preview by remember(rawLink) { mutableStateOf(center?.previewLink(rawLink) ?: VoucherLinkPreview.Refused("signed-out")) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(ui?.loaded, ui?.keys) {
        if (!busy && center != null && preview !is VoucherLinkPreview.Ask) preview = center.previewLink(rawLink)
    }
    when (val p = preview) {
        is VoucherLinkPreview.Refused -> AlertDialog(
            onDismissRequest = onDismiss,
            text = { Text(VoucherLinkCopy.refusal(p.code), Modifier.testTag("voucher-link-refused")) },
            confirmButton = { TextButton(onDismiss, Modifier.testTag("voucher-link-close")) { Text(stringResource(R.string.close)) } },
        )
        is VoucherLinkPreview.Ask -> {
            val cfg = center?.state?.value?.config ?: com.flagshipserver.app.core.payments.PaymentsConfig.DEFAULT
            AlertDialog(
                onDismissRequest = { if (!busy) onDismiss() },
                title = { Text(VoucherLinkCopy.question(p.plan, cfg), Modifier.testTag("voucher-link-question")) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        VoucherLinkCopy.details(p).forEach { Text(it, Modifier.testTag("voucher-link-detail")) }
                        Text(stringResource(R.string.voucher_link_privacy))
                    }
                },
                confirmButton = {
                    TextButton(enabled = !busy, onClick = {
                        busy = true
                        scope.launch {
                            val ok = center?.addFromLink(p.plan) == true
                            busy = false
                            if (ok) {
                                toasts.success(FSStrings.get(R.string.payments_shop_added, PlanFormat.usd(p.plan.add.size.toLong(), cfg)))
                                onDismiss()
                            } else {
                                // Nothing changed this phone's wallet: say why, from a fresh look (e.g. another tap added them).
                                preview = center?.previewLink(rawLink)?.takeIf { it is VoucherLinkPreview.Refused } ?: VoucherLinkPreview.Refused("signed-out")
                            }
                        }
                    }, modifier = Modifier.testTag("voucher-link-add")) { Text(stringResource(R.string.add)) }
                },
                dismissButton = { TextButton(onDismiss, enabled = !busy, modifier = Modifier.testTag("voucher-link-cancel")) { Text(stringResource(R.string.cancel)) } },
            )
        }
    }
}
