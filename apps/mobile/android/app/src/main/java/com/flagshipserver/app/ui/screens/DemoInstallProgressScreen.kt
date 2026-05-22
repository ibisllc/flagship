// "Your server is being installed" detail screen for a demo server still
// provisioning. Mirror of iOS DemoInstallProgressScreen.swift. Shows the
// determinate progress bar, the four named steps with per-step state, the
// device-identifying info block, and a "Cancel this device" action.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.DemoServerBlock
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalDemoConnectClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.ProvisionProgress
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

/** Thin determinate progress bar. `failed` renders in the danger colour;
 *  the detail page frames it as "retrying" because the daemon retries. */
@Composable
fun DemoProgressBar(fraction: Double, failed: Boolean, modifier: Modifier = Modifier) {
    val f = fraction.coerceIn(0.0, 1.0).toFloat()
    Box(
        modifier
            .fillMaxWidth()
            .height(4.dp)
            .clip(RoundedCornerShape(2.dp))
            .background(FS.colors.border.copy(alpha = 0.5f)),
    ) {
        Box(
            Modifier
                .fillMaxWidth(f)
                .height(4.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(if (failed) FS.colors.danger else FS.colors.primary),
        )
    }
}

@Composable
fun DemoInstallProgressScreen(podId: String, onAfterCancel: () -> Unit) {
    val app = LocalAppState.current
    val demo = LocalDemoConnectClient.current
    val toasts = LocalToastCenter.current
    val scope = rememberCoroutineScope()
    var cancelling by remember { mutableStateOf(false) }

    val pods by app.pods.collectAsState()
    val pod = pods.firstOrNull { it.podId == podId }
    if (pod == null) {
        // Pod gone (cancelled) — bounce.
        onAfterCancel()
        return
    }
    val block = pod.demoServer

    Column(
        Modifier
            .fillMaxSize()
            .background(FS.colors.bg)
            .verticalScroll(rememberScrollState())
            .padding(FS.space.s4),
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            pod.name,
            color = FS.colors.text,
            style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
        )
        Text(
            "Your server is being installed",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 15.sp),
        )

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                DemoProgressBar(
                    fraction = ProvisionProgress.fraction(block?.phase),
                    failed = block?.phase == "failed",
                    modifier = Modifier.testTag("install-progress-bar"),
                )
                StepList(block)
            }
        }

        DeviceInfo(block)

        FSDangerButton(
            label = if (cancelling) "Cancelling…" else "Cancel this device",
            onClick = {
                if (cancelling) return@FSDangerButton
                cancelling = true
                scope.launch {
                    val user = app.currentUser.value
                    if (user == null) {
                        cancelling = false
                        return@launch
                    }
                    try {
                        demo.cancel(user)
                        app.removePod(pod.podId)
                        toasts.success("Device cancelled.")
                        onAfterCancel()
                    } catch (e: Exception) {
                        toasts.warning("Couldn't cancel — try again in a moment.")
                        cancelling = false
                    }
                }
            },
            modifier = Modifier.testTag("install-cancel-device-button"),
        )
        Spacer(Modifier.height(FS.space.s8))
    }
}

@Composable
private fun StepList(block: DemoServerBlock?) {
    val steps = ProvisionProgress.stepStates(block?.phase, block?.lastError)
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        for (step in steps) {
            Row(
                Modifier.testTag("install-step-${step.key.name.lowercase()}"),
                horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
                verticalAlignment = Alignment.Top,
            ) {
                StepIcon(step.state)
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        step.label,
                        color = if (step.state == ProvisionProgress.StepState.PENDING)
                            FS.colors.textMuted else FS.colors.text,
                        style = TextStyle(fontSize = 15.sp),
                    )
                    val detail = step.detail
                    if (detail != null) {
                        if (step.state == ProvisionProgress.StepState.FAILED) {
                            Text(
                                "Retrying — last error: $detail",
                                color = FS.colors.danger,
                                style = TextStyle(fontSize = 13.sp),
                            )
                        } else {
                            Text(
                                detail,
                                color = FS.colors.textMuted,
                                style = TextStyle(fontSize = 13.sp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun StepIcon(state: ProvisionProgress.StepState) {
    Box(Modifier.size(18.dp), contentAlignment = Alignment.Center) {
        when (state) {
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
}

@Composable
private fun DeviceInfo(block: DemoServerBlock?) {
    if (block == null) return
    if (block.ip == null && block.region == null && block.image == null && block.serverType == null) return
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                "THIS DEVICE",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
            )
            block.ip?.let { InfoRow("IP", it) }
            block.region?.let { InfoRow("Location", it) }
            block.image?.let { InfoRow("OS", it) }
            block.serverType?.let { InfoRow("Size", it) }
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp))
        Text(value, color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
    }
}
