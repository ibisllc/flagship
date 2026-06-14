// P5 — dedicated, full-page audit-log viewer.
//
// Mirrors webapp `views/audit-log.js` + iOS
// FlagshipUI/Screens/AuditLogScreen.swift 1:1: a paginated list of every
// account-level audit event from flagshipserver.com, newest-first, with
// the kind→label mapping from docs/revocation-ui.md. The Worker's `since`
// is an EXCLUSIVE LOWER bound + `limit` is server-capped at 50, so paging
// here is window-grow rather than cursor-walk — see AuditLogViewModel.

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.AuditEvent
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.AuditLogPage
import com.flagshipserver.app.viewmodels.AuditLogViewModel
import com.flagshipserver.app.viewmodels.LoadingState
import com.flagshipserver.app.viewmodels.auditEventLabel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun AuditLogScreen(@Suppress("UNUSED_PARAMETER") nav: NavController) {
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

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    "Audit log",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
                )
                Text(
                    "Signed account-level actions, newest first.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 14.sp),
                )
            }
            FSGhostButton(label = "Refresh", onClick = { vm.load() })
        }
        Spacer(Modifier.height(FS.space.s4))

        when (val s = state) {
            is LoadingState.Loaded -> Body(s.value, onLoadMore = { vm.loadMore() })
            is LoadingState.Failed -> ErrorCard(s.message, onRetry = { vm.load() })
            else -> {
                ServerCardSkeleton()
                Spacer(Modifier.height(FS.space.s2))
                ServerCardSkeleton()
            }
        }
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun Body(page: AuditLogPage, onLoadMore: () -> Unit) {
    if (page.events.isEmpty()) {
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    "No account events yet.",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                )
                Text(
                    "Signed actions — disconnecting a device, rotating recovery, renaming an app URL — land here so you have one place to review your account history.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
            }
        }
        return
    }

    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .semantics { testTag = "audit-log-list" },
        ) {
            page.events.forEachIndexed { i, e ->
                EventRow(e)
                if (i < page.events.size - 1) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(0.5.dp)
                            .background(FS.colors.border),
                    )
                    Spacer(Modifier.height(FS.space.s2))
                }
            }
        }
    }

    if (page.canLoadMore) {
        Spacer(Modifier.height(FS.space.s3))
        FSSecondaryButton(
            label = if (page.loadingMore) "Loading…" else "Load more",
            onClick = onLoadMore,
            enabled = !page.loadingMore,
            block = true,
            modifier = Modifier.semantics { testTag = "audit-log-load-more" },
        )
    }
}

@Composable
private fun EventRow(e: AuditEvent) {
    val fmt = SimpleDateFormat("MMM d, HH:mm", Locale.getDefault())
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = FS.space.s2),
        verticalAlignment = Alignment.Top,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                auditEventLabel(e.eventKind),
                color = colorFor(e.eventKind),
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
            )
            if (e.detail.isNotEmpty()) {
                Text(
                    e.detail,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp),
                )
            }
        }
        Spacer(Modifier.width(FS.space.s2))
        Text(
            fmt.format(Date(e.postedAt)),
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 11.sp),
        )
    }
}

@Composable
private fun colorFor(kind: String): Color = when (kind) {
    "wipe-restart", "device-disconnected" -> FS.colors.danger
    "device-replaced", "app-renamed", "server-created" -> FS.colors.primary
    "server-online"                       -> FS.colors.success
    else                                  -> FS.colors.text  // primary label tone; subtitle is textMuted
}
