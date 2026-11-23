// "Choose your own account name" at sign-up (core/AccountNameChoice.kt has the flow). Opened from the suggestion
// screen's secondary action, or by a name-grant link (the name filled in, "This name has been set aside for you.").

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.flagshipserver.app.R
import com.flagshipserver.app.core.ChooseNameFlow
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.NameChoiceNotice
import com.flagshipserver.app.core.NameChoiceOps
import com.flagshipserver.app.core.NameChoicePayment
import com.flagshipserver.app.core.NameGrant
import com.flagshipserver.app.core.UserErrorText
import com.flagshipserver.app.core.VoiciName
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

/** The sentence for each notice (the same words as iOS and the webapp). */
object NameChoiceCopy {
    fun text(n: NameChoiceNotice): String = when (n) {
        is NameChoiceNotice.Problem -> VoiciName.problemText(n.problem)
        NameChoiceNotice.Taken -> VoiciName.takenText()
        is NameChoiceNotice.Held -> FSStrings.get(R.string.choose_name_held, n.name, heldDate(n.until))
        NameChoiceNotice.CodeInvalid -> FSStrings.get(R.string.choose_name_code_invalid)
        NameChoiceNotice.CodeUsed -> FSStrings.get(R.string.choose_name_code_used)
        is NameChoiceNotice.PaymentCancelled -> FSStrings.get(R.string.choose_name_payment_cancelled, n.kept)
        is NameChoiceNotice.PaymentFailed -> FSStrings.get(R.string.choose_name_payment_failed, n.kept)
        is NameChoiceNotice.FailedVouchers -> FSStrings.get(R.string.choose_name_failed_vouchers, n.kept)
        is NameChoiceNotice.FailedCode -> FSStrings.get(R.string.choose_name_failed_code, n.kept)
        NameChoiceNotice.GrantExpired -> FSStrings.get(R.string.choose_name_grant_expired)
        NameChoiceNotice.GrantInvalid -> FSStrings.get(R.string.choose_name_grant_invalid)
        is NameChoiceNotice.CreateFailed -> UserErrorText.of(n.error, FSStrings.get(R.string.couldnt_open_your_account_try_again))
    }

    private fun heldDate(ms: Long): String =
        java.text.DateFormat.getDateInstance(java.text.DateFormat.LONG).format(java.util.Date(ms))
}

@Composable
fun ChooseOwnNameScreen(
    suggested: String,
    ops: NameChoiceOps,
    grant: NameGrant?,
    onOpened: () -> Unit,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val flow = remember(suggested) { ChooseNameFlow(suggested, ops, grant = grant) }
    val phase by flow.phase.collectAsState()
    val notice by flow.notice.collectAsState()
    val account by flow.account.collectAsState()
    var name by remember { mutableStateOf(grant?.name ?: "") }
    var showCode by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf("") }
    val working = phase == ChooseNameFlow.Phase.Working
    val freeGrant = grant != null && grant.free && grant.name == name.trim().lowercase()

    LaunchedEffect(phase) { if (phase == ChooseNameFlow.Phase.Opened) onOpened() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12)
            .semantics { contentDescription = "choose-own-name" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s5),
    ) {
        Text(stringResource(R.string.choose_name_action), color = FS.colors.text, style = MaterialTheme.typography.headlineMedium)
        val done = phase as? ChooseNameFlow.Phase.Done
        if (done != null) {
            Text(fsString(R.string.choose_name_done, done.name), color = FS.colors.text, style = MaterialTheme.typography.bodyLarge)
            FSPrimaryButton(
                label = stringResource(R.string.continue_label),
                onClick = { scope.launch { flow.open() } },
                block = true,
                large = true,
            )
            return@Column
        }
        if (grant != null) {
            Text(stringResource(R.string.choose_name_set_aside), color = FS.colors.textMuted, style = MaterialTheme.typography.bodyLarge)
        }
        FSField(
            value = name,
            onValueChange = { name = VoiciName.stripAddressPrefix(it).lowercase() },
            label = stringResource(R.string.choose_name_field),
            error = flow.problem(name)?.let(VoiciName::problemText),
            enabled = !working,
            fieldTag = "choose-name-field",
            prefix = VoiciName.ADDRESS_PREFIX,
        )
        val canSubmit = !working && name.isNotBlank() && flow.problem(name) == null
        if (freeGrant) {
            FSPrimaryButton(
                label = stringResource(R.string.continue_label),
                onClick = { scope.launch { flow.submit(name, NameChoicePayment.Granted) } },
                block = true,
                large = true,
                enabled = canSubmit,
            )
        } else {
            Text(stringResource(R.string.choose_name_price), color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium)
            FSPrimaryButton(
                label = stringResource(R.string.choose_name_pay),
                onClick = { scope.launch { flow.submit(name, NameChoicePayment.Card) } },
                block = true,
                large = true,
                enabled = canSubmit,
            )
            if (!showCode) {
                FSSecondaryButton(
                    label = stringResource(R.string.choose_name_use_voucher),
                    onClick = { showCode = true },
                    block = true,
                    enabled = !working,
                )
            } else {
                FSField(
                    value = code,
                    onValueChange = { code = it },
                    label = stringResource(R.string.choose_name_voucher_code),
                    enabled = !working,
                    fieldTag = "choose-name-code",
                )
                FSSecondaryButton(
                    label = stringResource(R.string.choose_name_use_voucher_button),
                    onClick = { scope.launch { flow.submit(name, NameChoicePayment.Code(code)) } },
                    block = true,
                    enabled = canSubmit && code.isNotBlank(),
                )
            }
        }
        if (working) {
            Text(stringResource(R.string.choose_name_working), color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium)
        }
        notice?.let { Text(NameChoiceCopy.text(it), color = FS.colors.danger, style = MaterialTheme.typography.bodyMedium) }
        // Once the account exists it can't go back to another suggestion: it keeps this name or gets the chosen one.
        val existing = account
        if (existing != null) {
            FSGhostButton(
                label = fsString(R.string.choose_name_keep, existing.username),
                onClick = { scope.launch { flow.open() } },
                block = true,
                enabled = !working,
            )
        } else {
            FSGhostButton(label = stringResource(R.string.back), onClick = onBack, block = true, enabled = !working)
        }
    }
}

/** Above everything while a choice a crash left behind is finished at an unlock. */
@Composable
fun NameChoiceFinishingScreen() {
    androidx.compose.foundation.layout.Box(
        Modifier
            .fillMaxSize()
            .background(FS.colors.bg),
        contentAlignment = androidx.compose.ui.Alignment.Center,
    ) {
        Text(stringResource(R.string.choose_name_finishing), color = FS.colors.text, style = MaterialTheme.typography.bodyLarge)
    }
}
