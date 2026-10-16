// Co-manager invites on a shared server's app (docs/service-access-gating.md
// "Co-manager invites"), at Can manage: "Invite people" opens the panel to add
// a person or a group at Member, list your own invites and withdraw them.
// Mirror of iOS CoInviteSection; strings from ShareCoInviteCopy.

package com.flagshipserver.app.ui.screens

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.ShareCoInvite
import com.flagshipserver.app.core.ShareCoInviteCopy
import com.flagshipserver.app.core.ShareCoInviteState
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.CoInviteUi
import com.flagshipserver.app.viewmodels.CoInviteViewModel
import kotlinx.coroutines.launch

@Composable
fun CoInviteSection(vm: CoInviteViewModel) {
    val ui by vm.ui.collectAsState()
    val scope = rememberCoroutineScope()
    val toasts = LocalToastCenter.current
    var confirm by remember { mutableStateOf<ShareCoInvite?>(null) }

    Spacer(Modifier.height(FS.space.s6))
    Text(
        "INVITE PEOPLE",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
    )
    Spacer(Modifier.height(FS.space.s3))
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("co-invite-section")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            FSSecondaryButton(
                label = ShareCoInviteCopy.OPEN,
                onClick = { scope.launch { vm.toggle() } },
                block = true,
                modifier = Modifier.testTag("co-invite-open"),
            )
            val state = ui.state
            when {
                !ui.open -> Unit
                ui.loading -> CircularProgressIndicator()
                ui.failed != null && state == null -> Danger(ui.failed!!, "co-invite-error")
                state != null -> Panel(
                    vm = vm,
                    ui = ui,
                    state = state,
                    onCreated = { toasts.success(ShareCoInviteCopy.CREATED) },
                    onWithdraw = { confirm = it },
                )
            }
        }
    }

    confirm?.let { inv ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text(ShareCoInviteCopy.WITHDRAW_TITLE) },
            text = { Text(ShareCoInviteCopy.withdrawMessage(vm.appName)) },
            confirmButton = {
                TextButton(onClick = {
                    confirm = null
                    scope.launch { if (vm.withdraw(inv.inviteId)) toasts.success(ShareCoInviteCopy.WITHDRAWN) }
                }, modifier = Modifier.testTag("co-invite-withdraw-confirm")) {
                    Text(ShareCoInviteCopy.WITHDRAW, color = FS.colors.danger)
                }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun Panel(
    vm: CoInviteViewModel,
    ui: CoInviteUi,
    state: ShareCoInviteState,
    onCreated: () -> Unit,
    onWithdraw: (ShareCoInvite) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val toasts = LocalToastCenter.current
    var name by remember { mutableStateOf("") }
    var maxUses by remember { mutableStateOf("10") }
    var days by remember { mutableStateOf("") }

    if (state.canInvite) {
        Muted(ShareCoInviteCopy.LINE, "co-invite-line")
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
            FSSecondaryButton(
                label = ShareCoInviteCopy.ADD_PERSON,
                onClick = { name = ""; vm.startAdding(CoInviteUi.Kind.Person) },
                modifier = Modifier.weight(1f).testTag("co-invite-add-person"),
            )
            FSSecondaryButton(
                label = ShareCoInviteCopy.ADD_GROUP,
                onClick = { name = ""; maxUses = "10"; days = ""; vm.startAdding(CoInviteUi.Kind.Group) },
                modifier = Modifier.weight(1f).testTag("co-invite-add-group"),
            )
        }
        ui.adding?.let { kind ->
            val group = kind == CoInviteUi.Kind.Group
            FSField(
                value = name,
                onValueChange = { name = it },
                label = "${if (group) ShareCoInviteCopy.GROUP_NAME_LABEL else ShareCoInviteCopy.NAME_LABEL} (${ShareCoInviteCopy.NAME_HINT})",
                placeholder = if (group) ShareCoInviteCopy.GROUP_NAME_PLACEHOLDER else ShareCoInviteCopy.NAME_PLACEHOLDER,
                fieldTag = "co-invite-name",
            )
            if (group) {
                FSField(
                    value = maxUses,
                    onValueChange = { maxUses = it },
                    label = "${ShareCoInviteCopy.MAX_USES_LABEL} (${ShareCoInviteCopy.MAX_USES_HINT})",
                    placeholder = "10",
                    keyboardType = KeyboardType.Number,
                    fieldTag = "co-invite-max-uses",
                )
                FSField(
                    value = days,
                    onValueChange = { days = it },
                    label = "${ShareCoInviteCopy.DAYS_LABEL} (${ShareCoInviteCopy.DAYS_HINT})",
                    placeholder = "30",
                    keyboardType = KeyboardType.Number,
                    fieldTag = "co-invite-days",
                )
            }
            Muted(ShareCoInviteCopy.RANK_LINE)
            FSPrimaryButton(
                label = if (ui.busy) "Creating…" else ShareCoInviteCopy.CREATE,
                onClick = {
                    scope.launch {
                        if (vm.create(name, maxUses, days)) {
                            name = ""
                            onCreated()
                        }
                    }
                },
                enabled = !ui.busy,
                block = true,
                modifier = Modifier.testTag("co-invite-create"),
            )
        }
        ui.lastLink?.let { link ->
            SelectionContainer {
                Text(
                    link,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 11.sp, fontFamily = FontFamily.Monospace),
                    modifier = Modifier.testTag("co-invite-link"),
                )
            }
            Muted(ShareCoInviteCopy.LINK_LINE)
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), modifier = Modifier.fillMaxWidth()) {
                FSPrimaryButton(label = "Share…", onClick = { shareInviteLink(ctx, link) }, modifier = Modifier.weight(1f))
                FSSecondaryButton(
                    label = ShareCoInviteCopy.COPY_LINK,
                    onClick = {
                        clipboard.setText(AnnotatedString(link))
                        toasts.success(ShareCoInviteCopy.LINK_COPIED)
                    },
                    modifier = Modifier.weight(1f).testTag("co-invite-copy"),
                )
            }
        }
    } else {
        Muted(state.whyText, "co-invite-why")
    }
    ui.error?.let { Danger(it, "co-invite-error") }
    Text(ShareCoInviteCopy.YOURS, color = FS.colors.text, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold))
    if (state.invites.isEmpty()) {
        Muted(ShareCoInviteCopy.NONE, "co-invite-none")
    } else {
        state.invites.forEach { inv ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text(
                    "${inv.displayName} · ${ShareCoInviteCopy.statusText(inv)}",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 14.sp),
                    modifier = Modifier.weight(1f).testTag("co-invite-row-${inv.inviteId}"),
                )
                if (state.canInvite) {
                    TextButton(
                        onClick = { onWithdraw(inv) },
                        enabled = ui.withdrawing == null,
                        modifier = Modifier.testTag("co-invite-withdraw-${inv.inviteId}"),
                    ) { Text(ShareCoInviteCopy.WITHDRAW, color = FS.colors.danger) }
                }
            }
        }
    }
}

@Composable
private fun Muted(text: String, tag: String? = null) {
    Text(
        text,
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        modifier = if (tag != null) Modifier.testTag(tag) else Modifier,
    )
}

@Composable
private fun Danger(text: String, tag: String) {
    Text(text, color = FS.colors.danger, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp), modifier = Modifier.testTag(tag))
}

private fun shareInviteLink(ctx: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    ctx.startActivity(Intent.createChooser(send, "Share invite link").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}
