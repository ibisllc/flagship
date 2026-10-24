// App chat between owners (N08): the dialog raised for each held request, and Activity's App
// chat requests list with every waiting request and every Always allow. Driven by
// [ChatRequestCenter]; wording follows the webapp's lib/chatAlerts.js.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
import com.flagshipserver.app.core.ChatAlwaysItem
import com.flagshipserver.app.core.ChatApproval
import com.flagshipserver.app.core.ChatItem
import com.flagshipserver.app.core.ChatRequestCenter
import com.flagshipserver.app.core.ChatText
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.ui.components.AlertDialog
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.TextButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

private fun tagOf(item: ChatItem) = item.requestId.replace(Regex("[^A-Za-z0-9_-]"), "")

/** One dialog per held request. Allow / Always allow (incoming only) / Deny / Not now. */
@Composable
fun ChatRequestDialogHost(center: ChatRequestCenter) {
    val shown by center.shown.collectAsState()
    val scope = rememberCoroutineScope()
    val s = shown ?: return
    val item = s.item
    when (val phase = s.phase) {
        is ChatRequestCenter.Phase.Done -> AlertDialog(
            onDismissRequest = { scope.launch { center.close() } },
            title = { Text(phase.message, modifier = Modifier.testTag("chat-alert-done-title")) },
            confirmButton = {
                TextButton(onClick = { scope.launch { center.close() } }, modifier = Modifier.testTag("chat-alert-close")) {
                    Text(stringResource(R.string.close))
                }
            },
            modifier = Modifier.testTag("chat-alert-done"),
        )
        else -> {
            val sending = phase as? ChatRequestCenter.Phase.Sending
            AlertDialog(
                onDismissRequest = { if (sending == null) scope.launch { center.notNow() } },
                title = { Text(ChatText.title(item), modifier = Modifier.testTag("chat-alert-title")) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        ChatText.notes(item).forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
                        if (item.kind == ChatApproval.Kind.INCOMING) {
                            Text(
                                ChatText.alwaysNote(item),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                        (phase as? ChatRequestCenter.Phase.Failed)?.let {
                            Text(
                                it.message,
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.testTag("chat-alert-error"),
                            )
                        }
                        if (item.kind == ChatApproval.Kind.INCOMING) {
                            TextButton(
                                enabled = sending == null,
                                onClick = { scope.launch { center.answerShown(ChatApproval.Decision.ALWAYS) } },
                                modifier = Modifier.testTag("chat-alert-always"),
                            ) { Text(stringResource(R.string.chat_always_allow)) }
                        }
                    }
                },
                confirmButton = {
                    Row {
                        TextButton(
                            enabled = sending == null,
                            onClick = { scope.launch { center.answerShown(ChatApproval.Decision.DENY) } },
                            modifier = Modifier.testTag("chat-alert-deny"),
                        ) { Text(stringResource(R.string.deny)) }
                        TextButton(
                            enabled = sending == null,
                            onClick = { scope.launch { center.answerShown(ChatApproval.Decision.ALLOW) } },
                            modifier = Modifier.testTag("chat-alert-allow"),
                        ) { Text(stringResource(R.string.allow)) }
                    }
                },
                dismissButton = {
                    TextButton(
                        enabled = sending == null,
                        onClick = { scope.launch { center.notNow() } },
                        modifier = Modifier.testTag("chat-alert-not-now"),
                    ) { Text(stringResource(R.string.not_now)) }
                },
                modifier = Modifier.testTag("chat-alert"),
            )
        }
    }
}

/** Activity → App chat requests: what waits, then the apps that take chats without asking. */
@Composable
fun ChatRequestsList(center: ChatRequestCenter) {
    val listing by center.listing.collectAsState()
    val busy by center.busy.collectAsState()
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    val canAnswer = center.canAnswerHere()
    val multi = (listing.requests.map { it.box.fqdn } + listing.always.map { it.box.fqdn }).toSet().size > 1
    Column(Modifier.fillMaxWidth().testTag("activity-chat-list"), verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        if (listing.requests.isEmpty()) {
            Text(stringResource(R.string.chat_requests_none_waiting), color = FS.colors.textMuted, modifier = Modifier.testTag("activity-chat-empty"))
        }
        listing.requests.forEach { r ->
            ChatRequestCard(r, canAnswer, multi, busy = r.key in busy) { decision ->
                scope.launch {
                    val failure = center.answer(r, decision)
                    if (failure == null) toasts.success(ChatText.answered(r, decision)) else toasts.error(failure)
                }
            }
        }
        if (listing.always.isNotEmpty()) {
            Spacer(Modifier.height(FS.space.s2))
            Text(stringResource(R.string.chat_always_heading), style = MaterialTheme.typography.titleSmall, modifier = Modifier.testTag("activity-chat-always-heading"))
            listing.always.forEach { a ->
                ChatAlwaysCard(a, multi, busy = a.key in busy) {
                    scope.launch {
                        val failure = center.revoke(a)
                        if (failure == null) toasts.success(FSStrings.get(R.string.chat_always_ended_sender, a.sender.author, a.sender.slug, a.app.slug)) else toasts.error(failure)
                    }
                }
            }
        }
    }
}

@Composable
private fun ChatRequestCard(r: ChatItem, canAnswer: Boolean, multi: Boolean, busy: Boolean, onAnswer: (ChatApproval.Decision) -> Unit) {
    val t = tagOf(r)
    FSCard(modifier = Modifier.testTag("chat-request-$t")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(ChatText.title(r), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("chat-request-title-$t"))
            if (multi) Text(r.box.fqdn.substringBefore('.'), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            ChatText.notes(r).forEach { Text(it, color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium) }
            if (!canAnswer) {
                Text(stringResource(R.string.chat_request_admin_only), color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("chat-request-admin-only"))
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSSecondaryButton(
                        stringResource(R.string.deny),
                        onClick = { onAnswer(ChatApproval.Decision.DENY) },
                        enabled = !busy,
                        modifier = Modifier.weight(1f).testTag("chat-request-deny-$t"),
                    )
                    FSPrimaryButton(
                        stringResource(R.string.allow),
                        onClick = { onAnswer(ChatApproval.Decision.ALLOW) },
                        enabled = !busy,
                        modifier = Modifier.weight(1f).testTag("chat-request-allow-$t"),
                    )
                }
                if (r.kind == ChatApproval.Kind.INCOMING) {
                    FSSecondaryButton(
                        stringResource(R.string.chat_always_allow),
                        onClick = { onAnswer(ChatApproval.Decision.ALWAYS) },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth().testTag("chat-request-always-$t"),
                    )
                }
            }
        }
    }
}

@Composable
private fun ChatAlwaysCard(a: ChatAlwaysItem, multi: Boolean, busy: Boolean, onRevoke: () -> Unit) {
    val t = "${a.sender.author}-${a.sender.slug}--${a.app.author}-${a.app.slug}"
    FSCard(modifier = Modifier.testTag("chat-always-$t")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(ChatText.alwaysTitle(a), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("chat-always-title-$t"))
            Text(ChatText.alwaysLine(a), color = FS.colors.textMuted, style = MaterialTheme.typography.bodyMedium)
            if (multi) Text(a.box.fqdn.substringBefore('.'), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            FSSecondaryButton(
                stringResource(R.string.chat_ask_me_each_time),
                onClick = onRevoke,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().testTag("chat-always-revoke-$t"),
            )
        }
    }
}
