// "Your server is being installed" detail screen for a demo server still
// provisioning. Mirror of iOS DemoInstallProgressScreen.swift. Shows the
// determinate progress bar, the four named steps with per-step state, the
// device-identifying info block. Demo servers are operator-provisioned and the
// Worker exposes no public cancel, so there is nothing to offer here.

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
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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
import com.flagshipserver.app.core.ProvisionProgress
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.theme.FS

/** Thin determinate progress bar (Material's linear indicator). `failed`
 *  renders in the error colour; the detail page frames it as "retrying"
 *  because the daemon retries. */
@Composable
fun DemoProgressBar(fraction: Double, failed: Boolean, modifier: Modifier = Modifier) {
    val f = fraction.coerceIn(0.0, 1.0).toFloat()
    LinearProgressIndicator(
        progress = { f },
        modifier = modifier.fillMaxWidth(),
        color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
        trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
    )
}

@Composable
fun DemoInstallProgressScreen(podId: String, onAfterCancel: () -> Unit) {
    val app = LocalAppState.current
    val backDispatcher = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher

    val pods by app.pods.collectAsState()
    val pod = pods.firstOrNull { it.podId == podId }
    if (pod == null) {
        // Pod gone — bounce.
        onAfterCancel()
        return
    }
    val block = pod.demoServer

    FSScreen(
        title = pod.name,
        onBack = { backDispatcher?.onBackPressed() },
        subtitle = "Your server is being installed",
    ) {
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                DemoProgressBar(
                    fraction = ProvisionProgress.fraction(block?.phase),
                    failed = block?.phase == "error",
                    modifier = Modifier.testTag("install-progress-bar"),
                )
                StepList(block)
            }
        }

        DeviceInfo(block)
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
                            MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    val detail = step.detail
                    if (detail != null) {
                        if (step.state == ProvisionProgress.StepState.FAILED) {
                            Text(
                                "Retrying. Last error: $detail",
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        } else {
                            Text(
                                detail,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodyMedium,
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
    Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
        when (state) {
            ProvisionProgress.StepState.DONE ->
                Icon(Icons.Filled.CheckCircle, contentDescription = "Done", tint = FS.colors.success)
            ProvisionProgress.StepState.ACTIVE ->
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.primary)
            ProvisionProgress.StepState.FAILED ->
                Icon(Icons.Filled.Warning, contentDescription = "Failed", tint = MaterialTheme.colorScheme.error)
            ProvisionProgress.StepState.PENDING ->
                Icon(Icons.Outlined.RadioButtonUnchecked, contentDescription = null, tint = MaterialTheme.colorScheme.outline)
        }
    }
}

@Composable
private fun DeviceInfo(block: DemoServerBlock?) {
    if (block == null) return
    if (block.ip == null && block.region == null && block.image == null && block.serverType == null) return
    FSGroup(header = "This device", modifier = Modifier.testTag("install-device-info")) {
        val rows = listOfNotNull(
            block.ip?.let { Triple("IP", it, true) },
            block.region?.let { Triple("Location", it, false) },
            block.image?.let { Triple("OS", it, false) },
            block.serverType?.let { Triple("Size", it, false) },
        )
        rows.forEachIndexed { i, (label, value, mono) ->
            if (i > 0) FSDivider(inset = FS.space.s4)
            InfoRow(label, value, mono)
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String, mono: Boolean) {
    FSRow(
        title = label,
        trailing = {
            Text(
                value,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = if (mono) MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace)
                        else MaterialTheme.typography.bodyMedium,
            )
        },
    )
}
