// P6 — per-app collaborator-invite manage screen. Mirrors
// FlagshipUI/Screens/InviteManageScreen.swift 1:1 and the canonical
// webapp `views/invite-manage.js`.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.AppInviteAccessSummary
import com.flagshipserver.app.api.AppInvitePendingSummary
import com.flagshipserver.app.core.LocalInviteLabelBook
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.InviteManageViewModel
import com.flagshipserver.app.viewmodels.LoadingState
import java.text.DateFormat
import java.util.Date
import java.util.Locale

@Composable
fun InviteManageScreen(
    nav: NavController,
    serviceId: String,
) {
    val client = LocalScreensClient.current
    val book = LocalInviteLabelBook.current
    val vm = remember(serviceId) { InviteManageViewModel(serviceId, client, book) }
    val state by vm.state.collectAsState()
    val revokePending by vm.revokePending.collectAsState()
    val outcome by vm.lastRevokeOutcome.collectAsState()

    LaunchedEffect(serviceId) { vm.load() }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Text(
            "Collaborators",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "Invite collaborators by sharing a link. Names you type stay on this device — the server only sees the random handle.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
        )
        Spacer(Modifier.height(FS.space.s4))

        IssueButton(onClick = { nav.navigate("invite-issue/$serviceId") })

        Spacer(Modifier.height(FS.space.s4))
        when (val s = state) {
            is LoadingState.Loaded -> Body(
                snapshot = s.value,
                resolveLabel = { tag -> vm.label(tag)?.displayName ?: "unknown" },
                revokePending = revokePending,
                onRevokeInvite = { inv -> vm.revokeInvite(inv.inviteId, inv.opaqueTag) },
                onRevokeAccess = { a -> vm.revokeAccess(a.irkPubHex, a.opaqueTag) },
            )
            is LoadingState.Failed -> ErrorCard(s.message, onRetry = { vm.load() })
            else -> {
                ServerCardSkeleton()
                Spacer(Modifier.height(FS.space.s2))
                ServerCardSkeleton()
            }
        }

        outcome?.let {
            Spacer(Modifier.height(FS.space.s2))
            Text(it, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun IssueButton(onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text("+ Issue invite")
    }
}

@Composable
private fun Body(
    snapshot: InviteManageViewModel.Snapshot,
    resolveLabel: (String) -> String,
    revokePending: Boolean,
    onRevokeInvite: (AppInvitePendingSummary) -> Unit,
    onRevokeAccess: (AppInviteAccessSummary) -> Unit,
) {
    SectionHeader("PENDING INVITES")
    Spacer(Modifier.height(FS.space.s2))
    if (snapshot.pending.isEmpty()) {
        PlaceholderCard("No pending invites yet.")
    } else {
        snapshot.pending.forEach { inv ->
            PendingRow(inv, resolveLabel(inv.opaqueTag), revokePending) { onRevokeInvite(inv) }
            Spacer(Modifier.height(FS.space.s2))
        }
    }

    Spacer(Modifier.height(FS.space.s4))
    SectionHeader("ACTIVE ACCESS")
    Spacer(Modifier.height(FS.space.s2))
    if (snapshot.access.isEmpty()) {
        PlaceholderCard("No active access yet.")
    } else {
        snapshot.access.forEach { row ->
            AccessRow(row, resolveLabel(row.opaqueTag), revokePending) { onRevokeAccess(row) }
            Spacer(Modifier.height(FS.space.s2))
        }
    }
}

@Composable
private fun PendingRow(
    inv: AppInvitePendingSummary,
    labelText: String,
    revokePending: Boolean,
    onRevoke: () -> Unit,
) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(
                    labelText,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                )
                Text(
                    "role: ${inv.role} · expires ${fmtDate(inv.expiresAt)}",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
                Text(
                    "tag ${inv.opaqueTag.take(12)}…",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp, fontFamily = FontFamily.Monospace),
                )
            }
            OutlinedButton(
                onClick = onRevoke,
                enabled = !revokePending,
            ) {
                Text("Revoke")
            }
        }
    }
}

@Composable
private fun AccessRow(
    row: AppInviteAccessSummary,
    labelText: String,
    revokePending: Boolean,
    onRevoke: () -> Unit,
) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(
                    labelText,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                )
                Text(
                    "role: ${row.role} · since ${fmtDate(row.grantedAt)}",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
                Text(
                    "IRK ${row.irkPubHex.take(12)}…",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp, fontFamily = FontFamily.Monospace),
                )
            }
            OutlinedButton(
                onClick = onRevoke,
                enabled = !revokePending,
            ) {
                Text("Revoke")
            }
        }
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(
        title,
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
    )
}

@Composable
private fun PlaceholderCard(text: String) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Text(text, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
    }
}

private fun fmtDate(ms: Long): String {
    if (ms <= 0L) return "—"
    val fmt = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT, Locale.US)
    return fmt.format(Date(ms))
}
