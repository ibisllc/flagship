// Social → Conversations you started (docs/voici-calls.md, release-manager decisions 2026-11-16): the conversations this
// account started on other people's pages, as their pseudonymous visitor. Each opens its thread (the account's own
// messages and the owner's replies, opened with its thread key), with Call / Video call and Settings: "Show <name> who
// I am" (a reveal signed with this account's own page key, sent inside the sealed conversation), call-backs, and delete.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.flagshipserver.app.R
import com.flagshipserver.app.calls.VoiciCallTarget
import com.flagshipserver.app.calls.VoiciOutgoingCalls
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.voici.VoiciCenter
import androidx.fragment.app.FragmentActivity
import com.flagshipserver.app.ui.shell.confirmConversationDelete
import com.flagshipserver.app.core.voici.VoiciCopy
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.Switch
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

@Composable
fun VisitorConversationsScreen(nav: NavController) {
    val center = LocalVoiciCenter.current ?: return
    val pages = remember { center.callablePages() }
    FSScreen(title = stringResource(R.string.voici_my_conversations), onBack = { nav.popBackStack() }, titleTag = "visitor-convs-title") {
        if (pages.isEmpty()) {
            FSEmptyState(title = stringResource(R.string.voici_my_conversations_empty), icon = Icons.Outlined.ChatBubbleOutline, modifier = Modifier.testTag("visitor-convs-empty"))
        } else {
            FSGroup {
                pages.forEachIndexed { i, p ->
                    FSRow(
                        title = stringResource(R.string.voici_calls_peer_page, p.username),
                        icon = Icons.Outlined.Public,
                        onClick = { nav.navigate("visitor/${p.username}/${p.pageId}") },
                        modifier = Modifier.testTag("visitor-conv-row"),
                    )
                    if (i < pages.size - 1) FSDivider(0.dp)
                }
            }
        }
    }
}

@Composable
fun VisitorThreadScreen(nav: NavController, username: String, pageId: String) {
    val center = LocalVoiciCenter.current ?: return
    val target = remember(username, pageId) { VoiciCallTarget(username, pageId) }
    val scope = rememberCoroutineScope()
    val toasts = LocalToastCenter.current
    var thread by remember { mutableStateOf<VoiciCenter.VisitorThread?>(null) }
    var draft by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var settings by remember { mutableStateOf(false) }
    val reload: () -> Unit = { scope.launch { thread = runCatching { center.visitorThread(target, VoiciOutgoingCalls.integrity) }.getOrNull() } }
    LaunchedEffect(target) { reload() }
    val name = thread?.displayName ?: stringResource(R.string.voici_calls_peer_page, username)
    FSScreen(
        title = name,
        onBack = { nav.popBackStack() },
        titleTag = "visitor-thread-title",
        actions = {
            IconButton(onClick = { settings = true }, modifier = Modifier.testTag("visitor-thread-settings")) {
                Icon(Icons.Outlined.Settings, contentDescription = stringResource(R.string.voici_visitor_settings))
            }
        },
        bottomBar = {
            Row(Modifier.fillMaxWidth().padding(FS.space.s3), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { if (it.codePointCount(0, it.length) <= 2000) draft = it },
                    placeholder = { Text(stringResource(R.string.voici_compose_hint)) },
                    modifier = Modifier.weight(1f).testTag("visitor-thread-compose"),
                    maxLines = 5,
                )
                IconButton(
                    enabled = draft.isNotBlank() && !sending,
                    onClick = {
                        sending = true
                        scope.launch {
                            val err = center.sendAsVisitor(target, draft.trim(), VoiciOutgoingCalls.integrity)
                            sending = false
                            if (err == null) { draft = ""; reload() } else toasts.error(VoiciCopy.sendError(err))
                        }
                    },
                    modifier = Modifier.testTag("visitor-thread-send"),
                ) { Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = stringResource(R.string.voici_send)) }
            }
        },
    ) {
        VoiciCallButtons(target, "visitor-thread-call")
        val msgs = thread?.messages.orEmpty()
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.testTag("visitor-thread-list")) {
            msgs.forEach { m ->
                Text(
                    m.text,
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (m.mine) FS.colors.accent else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.fillMaxWidth().testTag(if (m.mine) "visitor-msg-mine" else "visitor-msg-theirs"),
                )
            }
        }
    }
    if (settings) VisitorSettingsDialog(center, target, name, onDeleted = { settings = false; nav.popBackStack() }) { settings = false }
}

@Composable
private fun VisitorSettingsDialog(center: VoiciCenter, target: VoiciCallTarget, name: String, onDeleted: () -> Unit, onDismiss: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    val toasts = LocalToastCenter.current
    var revealed by remember { mutableStateOf(target.pageId in center.revealedTo()) }
    var callBacks by remember { mutableStateOf(target.pageId in center.callBackPages()) }
    var confirmOff by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    fun setReveal(on: Boolean) {
        busy = true
        scope.launch {
            val err = center.setReveal(target, on, VoiciOutgoingCalls.integrity)
            busy = false
            if (err == null) revealed = on else toasts.error(if (err == "no-page") com.flagshipserver.app.core.FSStrings.get(R.string.voici_reveal_needs_page) else VoiciCopy.sendError(err))
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.voici_visitor_settings)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSRow(
                    title = stringResource(R.string.voici_reveal_switch, name),
                    subtitle = stringResource(R.string.voici_reveal_footer, name),
                    enabled = !busy,
                    trailing = {
                        Switch(checked = revealed, enabled = !busy, onCheckedChange = { on -> if (on) setReveal(true) else confirmOff = true }, modifier = Modifier.testTag("visitor-reveal"))
                    },
                )
                FSRow(
                    title = stringResource(if (callBacks) R.string.voici_call_backs_stop else R.string.voici_call_backs_allow),
                    subtitle = stringResource(R.string.voici_call_backs_footer, name),
                    enabled = !busy,
                    onClick = {
                        busy = true
                        scope.launch {
                            val err = center.setCallBack(target.pageId, !callBacks)
                            busy = false
                            if (err == null) callBacks = !callBacks else toasts.error(VoiciCopy.callFailure(err))
                        }
                    },
                    modifier = Modifier.testTag("visitor-call-backs"),
                )
                FSGhostButton(stringResource(R.string.voici_menu_delete), { confirmDelete = true }, modifier = Modifier.testTag("visitor-delete"))
            }
        },
        confirmButton = { FSGhostButton(stringResource(R.string.voici_call_close), onDismiss, modifier = Modifier.testTag("visitor-settings-close")) },
    )
    if (confirmOff) AlertDialog(
        onDismissRequest = { confirmOff = false },
        text = { Text(stringResource(R.string.voici_reveal_off_warning, name)) },
        confirmButton = { FSGhostButton(stringResource(R.string.voici_reveal_turn_off), { confirmOff = false; setReveal(false) }, modifier = Modifier.testTag("visitor-reveal-off-confirm")) },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), { confirmOff = false }) },
    )
    if (confirmDelete) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        title = { Text(stringResource(R.string.voici_delete_title)) },
        text = { Text(stringResource(R.string.voici_delete_forget_body, name)) },
        confirmButton = {
            FSGhostButton(stringResource(R.string.voici_delete), {
                confirmDelete = false
                scope.launch {
                    val err = center.deleteVisitorConversation(target) { confirmConversationDelete(context as? FragmentActivity) { toasts.error(it) } }
                    if (err == null) onDeleted() else if (err != VoiciCenter.DELETE_NOT_CONFIRMED) toasts.error(VoiciCopy.sendError(err))
                }
            }, modifier = Modifier.testTag("visitor-delete-confirm"))
        },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), { confirmDelete = false }) },
    )
}
