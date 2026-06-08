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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.ProvisionStatusPhase
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.ProvisionProgress
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.delay

@Composable
fun InstallProgressScreen(
    serial: String,
    onFinish: (resolvedFqdn: String?) -> Unit,
) {
    val flagshipServer = LocalFlagshipServerClient.current
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
                if (ProvisionStatusPhase.fromWire(rec.phase).isTerminal) break
            }
            delay(2000)
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Text(
            "Provisioning",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "Watching the new box come online. Don't put your phone away — it's almost done.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 15.sp),
        )
        Spacer(Modifier.height(FS.space.s4))

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                if (!hadFirstReport) {
                    Text("Waiting for the box to phone home…", color = FS.colors.textMuted)
                }
                val steps = ProvisionProgress.stepStates(phase, detail, prevPhase)
                for (step in steps) {
                    InstallStepRow(step)
                }
            }
        }

        Spacer(Modifier.height(FS.space.s6))

        val isLive = phase == "live"
        FSGhostButton(
            label = if (isLive) "Continue" else "Run in background",
            onClick = { onFinish(resolvedFqdn) },
            block = true,
        )
    }
}

@Composable
private fun InstallStepRow(step: ProvisionProgress.StepView) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.size(18.dp), contentAlignment = Alignment.Center) {
            when (step.state) {
                ProvisionProgress.StepState.DONE ->
                    Text("✓", color = FS.colors.success, style = TextStyle(fontWeight = FontWeight.Bold))
                ProvisionProgress.StepState.ACTIVE ->
                    CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp, color = FS.colors.primary)
                ProvisionProgress.StepState.FAILED ->
                    Text("!", color = FS.colors.danger, style = TextStyle(fontWeight = FontWeight.Bold))
                ProvisionProgress.StepState.PENDING ->
                    Text("○", color = FS.colors.textMuted)
            }
        }
        Column {
            Text(
                step.label,
                color = if (step.state == ProvisionProgress.StepState.PENDING)
                    FS.colors.textMuted else FS.colors.text,
                style = TextStyle(fontSize = 15.sp),
            )
            val d = step.detail
            if (d != null) {
                if (step.state == ProvisionProgress.StepState.FAILED) {
                    Text("Failed — $d", color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
                } else {
                    Text(d, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
                }
            }
        }
    }
}
