// P5 — dedicated, full-page audit-log viewer.
//
// Mirrors webapp `views/audit-log.js` + iOS
// FlagshipUI/Screens/AuditLogScreen.swift 1:1: a paginated list of every
// account-level audit event from flagshipserver.com, newest-first, with
// the kind→label mapping from docs/revocation-ui.md. The Worker's `since`
// is an EXCLUSIVE LOWER bound + `limit` is server-capped at 50, so paging
// here is window-grow rather than cursor-walk — see AuditLogViewModel.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AddCircleOutline
import androidx.compose.material.icons.outlined.Autorenew
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.GppMaybe
import androidx.compose.material.icons.outlined.HighlightOff
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.LockOpen
import androidx.compose.material.icons.outlined.Password
import androidx.compose.material.icons.outlined.PersonAddAlt
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.Verified
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.navigation.NavController
import com.flagshipserver.app.api.AuditEvent
import com.flagshipserver.app.core.FlagshipDateFormat
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.ui.components.FSBarAction
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.AuditLogPage
import com.flagshipserver.app.viewmodels.AuditLogViewModel
import com.flagshipserver.app.viewmodels.LoadingState
import com.flagshipserver.app.viewmodels.auditEventDisplayDetail
import com.flagshipserver.app.viewmodels.auditEventLabel

@Composable
fun AuditLogScreen(nav: NavController) {
    val client = LocalFlagshipServerClient.current
    val app = LocalAppState.current
    val vm = remember {
        AuditLogViewModel(
            client = client,
            username = { app.currentUser.value },
        )
    }
    val state by vm.state.collectAsState()

    LaunchedEffect(Unit) { vm.load() }

    FSScreen(
        title = stringResource(R.string.audit_log),
        onBack = { nav.popBackStack() },
        subtitle = stringResource(R.string.signed_account_level_actions_newest_first),
        onRefresh = { vm.load() },
        refreshing = state is LoadingState.Loading,
        actions = { FSBarAction(Icons.Outlined.Refresh, stringResource(R.string.refresh), onClick = { vm.load() }) },
    ) {
        when (val s = state) {
            is LoadingState.Loaded -> Body(s.value, onLoadMore = { vm.loadMore() })
            is LoadingState.Failed -> ErrorCard(s.message, onRetry = { vm.load() })
            else -> {
                ServerCardSkeleton()
                ServerCardSkeleton()
            }
        }
    }
}

@Composable
private fun Body(page: AuditLogPage, onLoadMore: () -> Unit) {
    if (page.events.isEmpty()) {
        FSEmptyState(
            title = stringResource(R.string.no_account_events_yet),
            message = stringResource(R.string.signed_actions_disconnecting_a_device),
            icon = Icons.Outlined.History,
        )
        return
    }

    FSGroup(modifier = Modifier.testTag("audit-log-list")) {
        page.events.forEachIndexed { i, e ->
            EventRow(e)
            if (i < page.events.size - 1) FSDivider()
        }
    }

    if (page.canLoadMore) {
        FSSecondaryButton(
            label = if (page.loadingMore) stringResource(R.string.loading) else stringResource(R.string.load_more),
            onClick = onLoadMore,
            enabled = !page.loadingMore,
            block = true,
            modifier = Modifier.testTag("audit-log-load-more"),
        )
    }
}

@Composable
private fun EventRow(e: AuditEvent) {
    FSRow(
        title = auditEventLabel(e.eventKind),
        subtitle = auditEventDisplayDetail(e),
        icon = iconFor(e.eventKind),
        iconTint = colorFor(e.eventKind),
        trailing = {
            Text(
                FlagshipDateFormat.format(e.postedAt, includeTime = true),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelSmall,
            )
        },
    )
}

private fun iconFor(kind: String): ImageVector = when (kind) {
    "device-disconnected" -> Icons.Outlined.LockOpen
    "device-replaced" -> Icons.Outlined.SwapHoriz
    "device-added" -> Icons.Outlined.AddCircleOutline
    "server-migration-started", "server-migration-taken-over" -> Icons.Outlined.Inventory2
    "server-migration-aborted", "server-unrevoked" -> Icons.AutoMirrored.Outlined.Undo
    "wipe-restart" -> Icons.Outlined.Delete
    "recovery-set-up" -> Icons.Outlined.Key
    "recovery-rotated" -> Icons.Outlined.Autorenew
    "app-renamed" -> Icons.Outlined.Link
    "invite-created" -> Icons.Outlined.PersonAddAlt
    "server-created", "demo-vps-provisioned" -> Icons.Outlined.Dns
    "server-online" -> Icons.Outlined.Verified
    "server-revoked" -> Icons.Outlined.HighlightOff
    "totp-enrolled", "totp-disabled", "totp-failed-rate" -> Icons.Outlined.Password
    "ct-unexpected-cert" -> Icons.Outlined.GppMaybe
    else -> Icons.Outlined.Circle
}

@Composable
private fun colorFor(kind: String): Color = when (kind) {
    "wipe-restart", "device-disconnected", "server-revoked" -> FS.colors.danger
    "device-replaced", "app-renamed", "server-created", "invite-created" -> FS.colors.primary
    "server-online", "server-unrevoked" -> FS.colors.success
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}
