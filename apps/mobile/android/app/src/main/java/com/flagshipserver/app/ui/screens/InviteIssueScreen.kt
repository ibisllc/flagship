// P6 — per-app invite issuance form. Mirrors
// FlagshipUI/Screens/InviteIssueScreen.swift 1:1 and the canonical
// webapp `views/invite-issue.js`.

package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalInviteLabelBook
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.InviteIssueViewModel

private val CHANNEL_OPTIONS: List<Pair<String, String>> = listOf(
    "imessage" to "iMessage",
    "whatsapp" to "WhatsApp",
    "signal" to "Signal",
    "telegram" to "Telegram",
    "email" to "Email",
    "qr" to "QR",
    "airdrop" to "AirDrop",
    "manual" to "Manual",
    "other" to "Other",
)

private val ROLE_OPTIONS: List<String> = listOf("member", "admin", "reader")

@Composable
fun InviteIssueScreen(nav: NavController, serviceId: String) {
    val client = LocalScreensClient.current
    val book = LocalInviteLabelBook.current
    val ctx = LocalContext.current
    val resolvedAppUrl by produceState<String?>(initialValue = null, serviceId) {
        value = resolveAppShareUrl(serviceId, client)
    }
    val appUrl = resolvedAppUrl ?: run {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }
    val vm = remember(serviceId, appUrl) {
        InviteIssueViewModel(
            serviceId = serviceId,
            appUrl = appUrl,
            client = client,
            labelBook = book,
        )
    }
    val phase by vm.phase.collectAsState()
    val displayName by vm.displayName.collectAsState()
    val role by vm.role.collectAsState()
    val channel by vm.channel.collectAsState()
    val sentTo by vm.sentTo.collectAsState()
    val contextNote by vm.contextNote.collectAsState()

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Text(
            "Issue invite",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "Invites are share-links — anyone with the link can claim access. Your server expires them after 24 hours by default. Names you type stay on this device.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
        )
        Spacer(Modifier.height(FS.space.s4))

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                OutlinedTextField(
                    value = displayName,
                    onValueChange = { vm.displayName.value = it },
                    label = { Text("Label (visible only to you)") },
                    placeholder = { Text("John (work)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )

                Text("Role", color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    ROLE_OPTIONS.forEach { r ->
                        RadioButton(
                            selected = role == r,
                            onClick = { vm.role.value = r },
                        )
                        Text(r, color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
                        Spacer(Modifier.padding(start = FS.space.s2))
                    }
                }

                ChannelDropdown(
                    selected = channel,
                    onSelect = { vm.channel.value = it },
                )

                OutlinedTextField(
                    value = sentTo,
                    onValueChange = { vm.sentTo.value = it },
                    label = { Text("Sent to (memo)") },
                    placeholder = { Text("+1 555 0142") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )

                OutlinedTextField(
                    value = contextNote,
                    onValueChange = { vm.contextNote.value = it },
                    label = { Text("Context note (shown to invitee)") },
                    placeholder = { Text("from harry's phone — work") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )

                Button(
                    onClick = { vm.issue() },
                    enabled = phase !is InviteIssueViewModel.Phase.Issuing,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(buttonLabel(phase))
                }
                if (phase is InviteIssueViewModel.Phase.Failed) {
                    Text(
                        (phase as InviteIssueViewModel.Phase.Failed).message,
                        color = FS.colors.danger,
                        style = TextStyle(fontSize = 13.sp),
                    )
                }
            }
        }

        Spacer(Modifier.height(FS.space.s4))
        if (phase is InviteIssueViewModel.Phase.Issued) {
            val issued = phase as InviteIssueViewModel.Phase.Issued
            ResultCard(
                shareUrl = issued.shareUrl,
                expiresAt = issued.expiresAt,
                onShare = { shareViaSystemSheet(ctx, issued.shareUrl) },
                onCopy = { copyToClipboard(ctx, issued.shareUrl) },
            )
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun ChannelDropdown(selected: String, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val labelFor = CHANNEL_OPTIONS.firstOrNull { it.first == selected }?.second ?: "Other"
    Column {
        Text("Channel", color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
        OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) {
            Text(labelFor)
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            CHANNEL_OPTIONS.forEach { (key, label) ->
                DropdownMenuItem(
                    text = { Text(label) },
                    onClick = {
                        onSelect(key)
                        expanded = false
                    },
                )
            }
        }
    }
}

@Composable
private fun ResultCard(
    shareUrl: String,
    expiresAt: Long,
    onShare: () -> Unit,
    onCopy: () -> Unit,
) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text("Shareable link", color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
            Text(
                shareUrl,
                color = FS.colors.text,
                style = TextStyle(fontSize = 13.sp, fontFamily = FontFamily.Monospace),
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Expires ${fmtExpires(expiresAt)}",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = onShare) { Text("Share…") }
                Spacer(Modifier.padding(start = FS.space.s2))
                TextButton(onClick = onCopy) { Text("Copy link") }
            }
        }
    }
}

private fun buttonLabel(phase: InviteIssueViewModel.Phase): String = when (phase) {
    is InviteIssueViewModel.Phase.Issuing -> "Issuing…"
    is InviteIssueViewModel.Phase.Issued -> "Issue another"
    else -> "Issue invite"
}

private fun shareViaSystemSheet(ctx: Context, url: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, url)
    }
    val chooser = Intent.createChooser(send, "Share invite")
    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    ctx.startActivity(chooser)
}

private fun copyToClipboard(ctx: Context, url: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("Flagship invite", url))
}

private fun fmtExpires(ms: Long): String =
    com.flagshipserver.app.core.FlagshipDateFormat.format(ms, includeTime = true)

/** Share-URL root for an installed app — the tier-1 canonical URL of THIS
 *  box's instance (`https://<urlLabel>.<server>.<user>.flagship.services`),
 *  the only form the box's per-box wildcard cert covers (model A′). The
 *  daemon's app-detail response carries it as `app.url`; we never derive a
 *  `<slug>.<creator>` (tier-2) form locally — that name has no valid cert
 *  until the shared service-cert phase ships. Last-resort fallback (detail
 *  fetch failed) keeps the URL syntactically valid for the share sheet.
 *  Mirrors iOS ServicesTab.resolveAppShareUrl. */
private suspend fun resolveAppShareUrl(
    serviceId: String,
    client: com.flagshipserver.app.api.ScreensClient,
): String =
    runCatching { client.appDetail(serviceId).app.url }
        .getOrElse { "https://$serviceId.${com.flagshipserver.app.core.Endpoints.dataApex}" }
