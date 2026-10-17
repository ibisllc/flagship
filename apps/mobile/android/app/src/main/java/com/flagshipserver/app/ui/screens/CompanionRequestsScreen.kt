// P14 Phase 2 — Settings → Companion requests inbox.
//
// Lists pending unsigned write-requests that remote browsers
// have forwarded to the owner. Approve IRK-signs + dispatches the
// destination call (release-server / revoke-server); Deny just records
// the outcome on the daemon. Approve uses the same 1.5s hold-to-confirm
// gesture as the per-server kill-switch surface.
//
// Mirrors FlagshipUI/Screens/CompanionRequestsScreen.swift + the
// canonical webapp `views/companion-requests.js`.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.CompanionPendingWrite
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.ui.components.FSBarAction
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.CompanionRequestsViewModel
import com.flagshipserver.app.viewmodels.LoadingState
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.text.DateFormat
import java.util.Date
import java.util.Locale

@Composable
fun CompanionRequestsScreen(nav: NavController) {
    val client = LocalScreensClient.current
    val server = LocalFlagshipServerClient.current
    val app = LocalAppState.current
    val currentUser by app.currentUser.collectAsState()
    val vm = remember {
        CompanionRequestsViewModel(
            client = client,
            server = server,
            username = { currentUser },
        )
    }
    val state by vm.state.collectAsState()
    val resolvePending by vm.resolvePending.collectAsState()
    val rowError by vm.rowError.collectAsState()

    // First load flashes the spinner; then poll silently every 10s while the
    // inbox is mounted (mirrors iOS startPolling + the webapp pollPending).
    DisposableEffect(Unit) {
        vm.load()
        vm.startPolling()
        onDispose { vm.stopPolling() }
    }

    FSScreen(
        title = "Companion requests",
        onBack = { nav.popBackStack() },
        subtitle = "Review writes from remote browsers. Your phone signs approved requests; browsers never receive your account key.",
        actions = { FSBarAction(Icons.Outlined.Refresh, "Refresh", onClick = { vm.load() }) },
    ) {
        when (val s = state) {
            is LoadingState.Loaded -> {
                if (s.value.isEmpty()) {
                    FSEmptyState(
                        title = "No pending requests",
                        message = "A remote browser can forward writes here once you've connected one.",
                        icon = Icons.Outlined.Inbox,
                    )
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                        for (row in s.value) {
                            RequestCard(
                                row = row,
                                pending = resolvePending.contains(row.requestId),
                                error = rowError[row.requestId],
                                onApprove = { vm.approve(row) },
                                onDeny = { vm.deny(row) },
                            )
                        }
                    }
                }
            }
            is LoadingState.Failed -> {
                FSCard {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                        Text("Couldn't load companion requests", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.titleSmall)
                        Text(s.message, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
            else -> ServerCardSkeleton()
        }
    }
}

@Composable
private fun RequestCard(
    row: CompanionPendingWrite,
    pending: Boolean,
    error: String?,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
) {
    val supported = row.kind == "release-server" || row.kind == "revoke-server"
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                title(row),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.semantics { contentDescription = "companion-req-title-${row.requestId}" },
            )
            Text(
                subtitle(row),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                queuedLabel(row),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
            if (!supported) {
                Text(
                    "Unsupported request kind — open your browser to handle",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.semantics {
                        contentDescription = "companion-req-unsupported-${row.requestId}"
                    },
                )
            }
            if (!error.isNullOrEmpty()) {
                Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
                modifier = Modifier.padding(top = FS.space.s2),
            ) {
                Box(modifier = Modifier.weight(1f)) {
                    HoldToApproveButton(
                        enabled = supported && !pending,
                        pending = pending,
                        onConfirm = onApprove,
                        description = "companion-req-approve-${row.requestId}",
                    )
                }
                Box(modifier = Modifier.weight(1f)) {
                    FSDangerButton(
                        label = if (pending) "Denying…" else "Deny",
                        onClick = { if (!pending) onDeny() },
                        enabled = !pending,
                        block = true,
                    )
                }
            }
        }
    }
}

private fun title(row: CompanionPendingWrite): String {
    val who = row.companionTokenPrefix
    return when (row.kind) {
        "release-server" -> "Release server name — from $who"
        "revoke-server" -> "Revoke server — from $who"
        else -> "Request from $who"
    }
}

private fun subtitle(row: CompanionPendingWrite): String = when (row.kind) {
    "release-server" -> stringField(row.intent, "serverDomain") ?: "(missing serverDomain)"
    "revoke-server" -> {
        val id = stringField(row.intent, "revokedServerId") ?: "(missing serverId)"
        val reason = stringField(row.intent, "reason") ?: "(missing reason)"
        "$id · reason: $reason"
    }
    else -> row.kind
}

private fun queuedLabel(row: CompanionPendingWrite): String {
    val fmt = DateFormat.getTimeInstance(DateFormat.SHORT, Locale.getDefault())
    val q = fmt.format(Date(row.queuedAt))
    val remainingMs = row.expiresAt - System.currentTimeMillis()
    val tail = when {
        remainingMs <= 0 -> "expired"
        remainingMs >= 60_000 -> "expires in ${remainingMs / 60_000}m"
        else -> "expires in ${remainingMs / 1000}s"
    }
    return "queued $q · $tail"
}

private fun stringField(intent: JsonObject, key: String): String? {
    val v = intent[key] ?: return null
    return (v as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
}

/** 1.5s hold-to-confirm button. Mirrors `RevokeServerSheet`'s pattern —
 *  the label flips while the user holds, a short tap does nothing. */
@Composable
private fun HoldToApproveButton(
    enabled: Boolean,
    pending: Boolean,
    onConfirm: () -> Unit,
    description: String,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var holding by remember { mutableStateOf(false) }
    val tag = description
    Box(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(CircleShape)
            .pointerInput(enabled) {
                detectTapGestures(
                    onPress = {
                        if (!enabled) return@detectTapGestures
                        holding = true
                        var fired = false
                        try {
                            kotlinx.coroutines.withTimeout(COMPANION_APPROVE_HOLD_MS) {
                                tryAwaitRelease()
                            }
                        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
                            fired = true
                        }
                        holding = false
                        if (fired) scope.launch { onConfirm() }
                    },
                )
            }
            .semantics { contentDescription = tag },
        contentAlignment = Alignment.Center,
    ) {
        val label = when {
            pending -> "Approving…"
            holding -> "Hold to confirm…"
            else -> "Hold to approve"
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clip(CircleShape)
                .background(
                    if (enabled) FS.colors.fill
                    else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f),
                )
                .padding(horizontal = FS.space.s5, vertical = FS.space.s2),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = label,
                color = if (enabled) FS.colors.onAccent else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f),
                style = MaterialTheme.typography.labelLarge,
            )
        }
    }
}

private const val COMPANION_APPROVE_HOLD_MS = 1500L
