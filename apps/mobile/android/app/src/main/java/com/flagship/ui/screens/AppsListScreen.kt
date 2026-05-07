package com.flagship.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagship.ui.components.FSCard
import com.flagship.ui.components.FSGhostButton
import com.flagship.ui.components.FSPill
import com.flagship.ui.components.FSPillKind
import com.flagship.ui.components.FSPrimaryButton
import com.flagship.ui.theme.FS

/**
 * Apps list — every app the user has installed across all their pods.
 * Tap a row to open the detail screen (where to run, let-instances-talk,
 * URL claims).
 */
@Composable
fun AppsListScreen(nav: NavController) {
    val apps by remember { mutableStateOf(sampleApps()) }

    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s10))
        Text(
            text = "Apps",
            color = FS.colors.text,
            style = TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = if (apps.isEmpty()) "Nothing installed yet." else "${apps.size} installed",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
        )
        Spacer(Modifier.height(FS.space.s8))

        if (apps.isEmpty()) {
            FSCard(padding = PaddingValues(FS.space.s6)) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Text(
                        text = "Build your first app",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
                    )
                    Text(
                        text = "Describe what you want in plain English. The AI writes it; the daemon runs it.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
                    )
                    FSPrimaryButton(
                        label = "Vibe-code an app",
                        onClick = { nav.navigate("vibe-code/describe") },
                        block = true,
                    )
                    FSGhostButton(
                        label = "Browse marketplace",
                        onClick = { nav.navigate("marketplace") },
                        block = true,
                    )
                }
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                apps.forEach { app ->
                    AppRow(app, onClick = { nav.navigate("apps/${app.appId}") })
                }
            }
        }
    }
}

@Composable
private fun AppRow(app: AppSummary, onClick: () -> Unit) {
    FSCard(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        padding = PaddingValues(FS.space.s4),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.fillMaxWidth().padding(end = FS.space.s4)) {
                Text(
                    text = app.name,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
                )
                Spacer(Modifier.height(FS.space.s1))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    FSPill(
                        label = if (app.runningPodCount > 0) "Running on ${app.runningPodCount}" else "Stopped",
                        kind = if (app.runningPodCount > 0) FSPillKind.Online else FSPillKind.Idle,
                    )
                    if (app.siblingsEnabled) {
                        FSPill(label = "Siblings on", kind = FSPillKind.Provisioning)
                    }
                }
            }
        }
    }
}

private fun sampleApps(): List<AppSummary> = emptyList()

data class AppSummary(
    val appId: String,
    val name: String,
    val runningPodCount: Int,
    val siblingsEnabled: Boolean,
)
