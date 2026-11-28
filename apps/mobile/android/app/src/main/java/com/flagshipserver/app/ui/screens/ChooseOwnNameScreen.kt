// "Choose your own account name" at sign-up (core/AccountNameChoice.kt has the flow). Opened from the suggestion
// screen's secondary action, or by a name-grant link (the name filled in, "This name has been set aside for you.").

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
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
        is NameChoiceNotice.Held -> held(n.domain, n.until, n.checked)
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

    /** The status line under the field for a held name. */
    fun held(domain: String, until: Long?, checked: Boolean): String = when {
        !checked -> FSStrings.get(R.string.choose_name_held_unchecked, domain)
        until == null -> FSStrings.get(R.string.choose_name_held_no_date, domain)
        else -> FSStrings.get(R.string.choose_name_held_until, domain, heldDate(until))
    }

    fun rule(until: Long?): String =
        if (until == null) FSStrings.get(R.string.choose_name_held_rule) else FSStrings.get(R.string.choose_name_held_rule_until, heldDate(until))

    /** "Email us": the name in the subject, and a body to fill in. */
    fun mailto(name: String): android.net.Uri {
        val subject = FSStrings.get(R.string.choose_name_held_mail_subject, name)
        val body = FSStrings.get(R.string.choose_name_held_mail_name, name) + "\n" + FSStrings.get(R.string.choose_name_held_mail_why) + "\n"
        return android.net.Uri.parse("mailto:$SUPPORT_EMAIL?subject=" + android.net.Uri.encode(subject) + "&body=" + android.net.Uri.encode(body))
    }

    /** The site's dibs page in the app's language (English at the root). */
    fun dibsPage(locale: java.util.Locale = java.util.Locale.getDefault()): String {
        val path = when {
            locale.language == "pt" -> "pt-br/"
            locale.language == "zh" -> "zh-hans/"
            locale.language in setOf("es", "fr", "de", "ja") -> "${locale.language}/"
            else -> ""
        }
        return "https://flagshipserver.com/${path}dibs"
    }

    const val SUPPORT_EMAIL = "support@flagshipserver.com"

    private fun heldDate(ms: Long): String =
        java.text.DateFormat.getDateInstance(java.text.DateFormat.LONG).format(java.util.Date(ms))
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun ChooseOwnNameScreen(
    suggested: String,
    ops: NameChoiceOps,
    grant: NameGrant?,
    onOpened: () -> Unit,
    onBack: () -> Unit,
    /** The pause after typing before `.com` is asked about the name. */
    precheckDelayMs: Long = 600,
) {
    val scope = rememberCoroutineScope()
    val flow = remember(suggested) { ChooseNameFlow(suggested, ops, grant = grant) }
    val phase by flow.phase.collectAsState()
    val notice by flow.notice.collectAsState()
    val account by flow.account.collectAsState()
    val check by flow.check.collectAsState()
    var name by remember { mutableStateOf(grant?.name ?: "") }
    var showCode by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf("") }
    var showWhy by remember { mutableStateOf(false) }
    val working = phase == ChooseNameFlow.Phase.Working
    val freeGrant = grant != null && grant.free && grant.name == name.trim().lowercase()
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    val statusInView = remember { BringIntoViewRequester() }
    val held = (check as? com.flagshipserver.app.core.NameCheck.Held)?.takeIf { it.name == name.trim().lowercase() }
    val checkRefusal = flow.refusedFor(name)
    // Close the keyboard first, so the answer under the field has room.
    val closeKeyboard = {
        keyboard?.hide()
        focus.clearFocus()
    }

    LaunchedEffect(phase) { if (phase == ChooseNameFlow.Phase.Opened) onOpened() }
    // Ask `.com` once typing pauses (a new keystroke cancels the wait).
    LaunchedEffect(name) {
        if (name.isBlank() || flow.problem(name) != null) return@LaunchedEffect
        delay(precheckDelayMs)
        flow.check(name)
    }
    LaunchedEffect(held) { if (held != null) statusInView.bringIntoView() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .imePadding()
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
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSField(
                value = name,
                onValueChange = { name = VoiciName.stripAddressPrefix(it).lowercase() },
                label = stringResource(R.string.choose_name_field),
                error = flow.problem(name)?.let(VoiciName::problemText) ?: checkRefusal?.let(NameChoiceCopy::text),
                enabled = !working,
                fieldTag = "choose-name-field",
                prefix = VoiciName.ADDRESS_PREFIX,
                imeAction = ImeAction.Done,
                onImeAction = {
                    closeKeyboard()
                    scope.launch { flow.check(name) }
                },
            )
            if (held != null) {
                HeldStatusLine(
                    held = held,
                    modifier = Modifier.bringIntoViewRequester(statusInView),
                    onWhy = {
                        closeKeyboard()
                        showWhy = true
                    },
                )
            }
        }
        if (held != null) {
            Text(
                stringResource(R.string.choose_name_held_pick_another),
                color = FS.colors.textMuted,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.testTag("choose-name-pick-another"),
            )
        }
        val canSubmit = !working && name.isNotBlank() && flow.problem(name) == null && held == null
        if (freeGrant) {
            FSPrimaryButton(
                label = stringResource(R.string.continue_label),
                onClick = { closeKeyboard(); scope.launch { flow.submit(name, NameChoicePayment.Granted) } },
                block = true,
                large = true,
                enabled = canSubmit,
            )
        } else {
            Text(stringResource(R.string.choose_name_price), color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium)
            FSPrimaryButton(
                label = stringResource(R.string.choose_name_pay),
                onClick = { closeKeyboard(); scope.launch { flow.submit(name, NameChoicePayment.Card) } },
                block = true,
                large = true,
                enabled = canSubmit,
                modifier = Modifier.testTag("choose-name-pay"),
            )
            if (!showCode) {
                FSSecondaryButton(
                    label = stringResource(R.string.choose_name_use_voucher),
                    onClick = { showCode = true },
                    block = true,
                    enabled = !working && held == null,
                    modifier = Modifier.testTag("choose-name-show-code"),
                )
            } else {
                FSField(
                    value = code,
                    onValueChange = { code = it },
                    label = stringResource(R.string.choose_name_voucher_code),
                    enabled = !working,
                    fieldTag = "choose-name-code",
                    imeAction = ImeAction.Done,
                    onImeAction = {
                        closeKeyboard()
                        if (canSubmit && code.isNotBlank()) scope.launch { flow.submit(name, NameChoicePayment.Code(code)) }
                    },
                )
                FSSecondaryButton(
                    label = stringResource(R.string.choose_name_use_voucher_button),
                    onClick = { closeKeyboard(); scope.launch { flow.submit(name, NameChoicePayment.Code(code)) } },
                    block = true,
                    enabled = canSubmit && code.isNotBlank(),
                )
            }
        }
        if (working) {
            Text(stringResource(R.string.choose_name_working), color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium)
        }
        notice?.let {
            Text(
                NameChoiceCopy.text(it),
                color = FS.colors.danger,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.testTag("choose-name-message").semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
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

    val why = held
    if (showWhy && why != null) {
        HeldNameWhySheet(name = why.name, domain = why.domain, until = why.until, onDismiss = { showWhy = false })
    }
}

/** "Held for the owner of {domain} until {date}." and Why? beside it, or under it at large text. */
@Composable
private fun HeldStatusLine(held: com.flagshipserver.app.core.NameCheck.Held, modifier: Modifier, onWhy: () -> Unit) {
    val status = NameChoiceCopy.held(held.domain, held.until, held.checked)
    val text = @Composable { m: Modifier ->
        Text(
            status,
            color = FS.colors.text,
            style = MaterialTheme.typography.bodyMedium,
            modifier = m.testTag("choose-name-status").semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
    val whyLabel = stringResource(R.string.choose_name_held_why_title, held.name)
    val why = @Composable {
        TextButton(
            onClick = onWhy,
            modifier = Modifier.heightIn(min = 48.dp).testTag("choose-name-why").semantics { contentDescription = whyLabel },
        ) { Text(stringResource(R.string.choose_name_held_why), color = FS.colors.accent, style = MaterialTheme.typography.bodyMedium) }
    }
    if (!held.checked) {
        Box(modifier) { text(Modifier) }
    } else if (LocalDensity.current.fontScale >= 1.5f) {
        Column(modifier) {
            text(Modifier)
            why()
        }
    } else {
        Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            text(Modifier.weight(1f))
            why()
        }
    }
}

/** "Why is {name} held?": how `.com` dibs works and who to write to. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HeldNameWhySheet(name: String, domain: String, until: Long?, onDismiss: () -> Unit) {
    val context = LocalContext.current
    com.flagshipserver.app.ui.components.ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.testTag("held-why"),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = FS.space.s6)
                .navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
        ) {
            Text(
                stringResource(R.string.choose_name_held_why_title, name),
                style = MaterialTheme.typography.titleLarge,
                color = FS.colors.text,
                modifier = Modifier.semantics { heading() }.testTag("held-why-title"),
            )
            Text(NameChoiceCopy.rule(until), style = MaterialTheme.typography.bodyLarge, color = FS.colors.text)
            Text(
                stringResource(R.string.choose_name_held_yours_title),
                style = MaterialTheme.typography.titleMedium,
                color = FS.colors.text,
                modifier = Modifier.semantics { heading() },
            )
            Text(stringResource(R.string.choose_name_held_yours, domain), style = MaterialTheme.typography.bodyLarge, color = FS.colors.textMuted)
            FSPrimaryButton(
                stringResource(R.string.choose_name_held_email_us),
                {
                    runCatching {
                        context.startActivity(android.content.Intent(android.content.Intent.ACTION_SENDTO, NameChoiceCopy.mailto(name)))
                    }
                },
                block = true,
                modifier = Modifier.testTag("held-why-email"),
            )
            FSSecondaryButton(
                stringResource(R.string.choose_name_held_how_dibs),
                {
                    runCatching {
                        context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(NameChoiceCopy.dibsPage())))
                    }
                },
                block = true,
                modifier = Modifier.testTag("held-why-dibs"),
            )
            FSGhostButton(stringResource(R.string.choose_name_held_ok), onDismiss, block = true, modifier = Modifier.testTag("held-why-ok"))
            Spacer(Modifier.size(FS.space.s4))
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
