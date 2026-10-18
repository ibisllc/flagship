// Live install progress — polls the ONE canonical provisioning channel
// (GET /api/order/<serial>/status on flagshipserver.com) and renders the
// unified grouped checklist (ProvisionProgress). The pod flips ONLINE when
// the canonical phase reaches `live`. Replaces the retired install-events
// SSE consumer; push is wake-only (the foregrounded screen drives the UI
// via this poll).

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.ProvisionStatusPhase
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.ProvisionProgress
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun InstallProgressScreen(
    serial: String,
    onFinish: (resolvedFqdn: String?, live: Boolean) -> Unit,
    /** The new server's name, shown on the ongoing setup notification. */
    podName: String? = null,
) {
    val flagshipServer = LocalFlagshipServerClient.current
    val context = androidx.compose.ui.platform.LocalContext.current
    // Raw canonical phase wire string (null until the box reports), the
    // latest history-derived prev phase for error attribution, the latest
    // detail, and the resolved serverDomain once registration lands.
    var phase by remember { mutableStateOf<String?>(null) }
    var prevPhase by remember { mutableStateOf<String?>(null) }
    var detail by remember { mutableStateOf<String?>(null) }
    var resolvedFqdn by remember { mutableStateOf<String?>(null) }
    var hadFirstReport by remember { mutableStateOf(false) }

    LaunchedEffect(serial) {
        // Poll the ONE canonical channel until a terminal phase
        // (live / error). 404 → null → keep showing the booting lead-in.
        while (true) {
            val rec = runCatching { flagshipServer.fetchProvisionStatus(serial) }.getOrNull()
            if (rec != null) {
                hadFirstReport = true
                // The phase BEFORE the latest is the error-attribution
                // hint; the canonical history is oldest-first.
                prevPhase = rec.history.dropLast(1).lastOrNull()?.phase
                phase = rec.phase
                detail = rec.detail
                if (rec.serverDomain != null) resolvedFqdn = rec.serverDomain
                com.flagshipserver.app.companion.ProvisionProgressCenter.report(
                    context,
                    com.flagshipserver.app.companion.ProvisionUpdate(
                        key = serial, serial = serial, podName = podName?.takeIf { it.isNotBlank() },
                        phase = rec.phase, detail = rec.detail, serverDomain = rec.serverDomain,
                    ),
                )
                if (ProvisionStatusPhase.fromWire(rec.phase).isTerminal) break
            }
            delay(2000)
        }
    }

    val isLive = phase == "live"
    FSScreen(
        title = "Provisioning",
        onBack = { onFinish(resolvedFqdn, isLive) },
        subtitle = "Watching the new server come online. Don't put your phone away, it's almost done.",
    ) {
        FSCard(padding = PaddingValues(vertical = FS.space.s2)) {
            if (!hadFirstReport) {
                Text(
                    "Waiting for the server to phone home…",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(horizontal = FS.space.s4, vertical = FS.space.s2),
                )
            }
            val steps = ProvisionProgress.stepStates(phase, detail, prevPhase)
            for (step in steps) {
                InstallStepRow(step)
            }
        }

        if (phase == "error") {
            SetupStoppedCard(serial = serial, step = ProvisionProgress.failureDetail(detail), onStartedOver = { onFinish(null, false) })
        }

        if (isLive) {
            FSPrimaryButton(
                label = "Continue",
                onClick = { onFinish(resolvedFqdn, isLive) },
                block = true,
            )
        } else {
            FSSecondaryButton(
                label = "Run in background",
                onClick = { onFinish(resolvedFqdn, isLive) },
                block = true,
            )
        }
    }
}

// Shared with PendingServerScreen — both render the same canonical ladder:
// one list row per step with a Material status icon (iOS ProvisionTimelineView).
@Composable
internal fun InstallStepRow(
    step: ProvisionProgress.StepView,
    /** The row's side inset: a card's own gutter when it sits in a padded card. */
    horizontalPadding: androidx.compose.ui.unit.Dp = FS.space.s4,
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(FS.space.s4),
        verticalAlignment = Alignment.Top,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 40.dp)
            .padding(horizontal = horizontalPadding, vertical = FS.space.s2),
    ) {
        Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
            when (step.state) {
                ProvisionProgress.StepState.DONE ->
                    Icon(Icons.Filled.CheckCircle, contentDescription = "Done", tint = FS.colors.success)
                ProvisionProgress.StepState.ACTIVE ->
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.primary)
                ProvisionProgress.StepState.FAILED ->
                    Icon(Icons.Filled.Error, contentDescription = "Failed", tint = MaterialTheme.colorScheme.error)
                ProvisionProgress.StepState.PENDING ->
                    Icon(Icons.Outlined.RadioButtonUnchecked, contentDescription = null, tint = MaterialTheme.colorScheme.outline)
            }
        }
        Column(Modifier.padding(top = 2.dp)) {
            Text(
                step.label,
                color = if (step.state == ProvisionProgress.StepState.PENDING)
                    MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.bodyLarge,
            )
            val d = step.detail
            if (d != null) {
                if (step.state == ProvisionProgress.StepState.FAILED) {
                    Text("Failed: $d", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                } else {
                    Text(d, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

/**
 * What a person can do when the install stopped: cancel the order and make the
 * server again, or write to support with the order number. Replaces a bare
 * "Failed: ..." line whose only button was "Run in background".
 */
@Composable
internal fun SetupStoppedCard(
    serial: String,
    step: String?,
    onStartedOver: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val app = com.flagshipserver.app.core.LocalAppState.current
    val flagshipServer = LocalFlagshipServerClient.current
    val toasts = com.flagshipserver.app.core.LocalToastCenter.current
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    FSCard(modifier = modifier.testTag("setup-stopped"), padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text("Setup stopped", color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleMedium)
            Text(
                "This server didn't finish installing" + (step?.takeIf { it.isNotBlank() }?.let { ". $it" } ?: "") + ". " +
                    "Cancel this order to free the name and create the server again, or contact us and we'll look at it.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
            FSPrimaryButton(
                label = if (working) "Cancelling…" else if (error != null) "Try again" else "Cancel order and start again",
                enabled = !working,
                onClick = {
                    val user = app.currentUser.value
                    val pod = app.pods.value.firstOrNull { it.pendingAuthCodeSerial == serial }
                    if (user == null || pod == null) { onStartedOver(); return@FSPrimaryButton }
                    scope.launch {
                        working = true
                        error = null
                        when (val out = com.flagshipserver.app.core.CancelPendingOrder.run(pod, user, flagshipServer)) {
                            is com.flagshipserver.app.core.CancelPendingOrder.Outcome.Cancelled -> {
                                com.flagshipserver.app.core.PendingRckStore.from(context).clear(pod.fqdn)
                                app.removePod(pod.podId)
                                toasts.success("Order cancelled. You can create the server again.")
                                onStartedOver()
                            }
                            is com.flagshipserver.app.core.CancelPendingOrder.Outcome.Failed -> error = out.message
                        }
                        working = false
                    }
                },
                block = true,
                modifier = Modifier.testTag("setup-stopped-start-again"),
            )
            FSSecondaryButton(
                label = "Contact us",
                onClick = {
                    val body = "My server's setup stopped.\nOrder: $serial\nStep: ${step.orEmpty()}\n"
                    val uri = android.net.Uri.parse(
                        "mailto:support@flagshipserver.com?subject=" + android.net.Uri.encode("Server setup stopped") +
                            "&body=" + android.net.Uri.encode(body),
                    )
                    runCatching {
                        context.startActivity(
                            android.content.Intent(android.content.Intent.ACTION_SENDTO, uri)
                                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                },
                block = true,
                modifier = Modifier.testTag("setup-stopped-contact"),
            )
        }
    }
}
