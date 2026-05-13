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
import androidx.compose.material3.Checkbox
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS

/**
 * App detail — the canonical surface for the FINAL DESIGN UX:
 *
 *   Where should it run?
 *     ☑ home box
 *     ☑ office box
 *     ☐ garage box
 *     ☐ run on all current and future boxes
 *
 *   Let instances talk to each other?
 *     ● Yes  ○ No
 *
 *   [ Save ]
 *
 * Plus a URL section listing each FQDN's kind / owner / claim controls.
 *
 * Toggling "let them talk" on a previously-deployed multi-pod app
 * triggers a vibe-code-session re-open with the existing files
 * preloaded plus the N0k system-prompt chapter — that is NOT a
 * runtime config change; it's a regenerate workflow.
 */
@Composable
fun AppDetailScreen(nav: NavController, appId: String) {
    val app = remember { sampleApp(appId) }
    val pods = remember { samplePods() }
    val urls = remember { sampleUrls() }
    var policy by remember { mutableStateOf(app.policy) }
    var siblingsEnabled by remember { mutableStateOf(app.siblingsEnabled) }

    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s10))
        Text(
            text = app.name,
            color = FS.colors.text,
            style = TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = "by ${app.creator}",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
        )

        Spacer(Modifier.height(FS.space.s8))

        // ── Where should it run?
        SectionHeader("Where should it run?")
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                pods.forEach { pod ->
                    val checked = policy.specificPods.contains(pod.podId)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = checked || policy.allCurrentAndFuture,
                            enabled = !policy.allCurrentAndFuture,
                            onCheckedChange = { on ->
                                policy = policy.copy(
                                    specificPods = if (on) policy.specificPods + pod.podId
                                    else policy.specificPods - pod.podId,
                                )
                            },
                        )
                        Spacer(Modifier.padding(start = FS.space.s2))
                        Column {
                            Text(text = pod.label, color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
                            Text(
                                text = pod.fqdn,
                                color = FS.colors.textMuted,
                                style = TextStyle(fontSize = 13.sp),
                            )
                        }
                    }
                }
                Spacer(Modifier.height(FS.space.s2))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(
                        checked = policy.allCurrentAndFuture,
                        onCheckedChange = { policy = policy.copy(allCurrentAndFuture = it) },
                    )
                    Spacer(Modifier.padding(start = FS.space.s2))
                    Text(
                        text = "Run on all current and future boxes",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 16.sp),
                    )
                }
            }
        }

        Spacer(Modifier.height(FS.space.s6))

        // ── Let instances talk?
        SectionHeader("Let instances talk to each other?")
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                RadioButton(
                    selected = siblingsEnabled,
                    onClick = { siblingsEnabled = true },
                )
                Spacer(Modifier.padding(start = FS.space.s2))
                Text(text = "Yes", color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
                Spacer(Modifier.padding(start = FS.space.s6))
                RadioButton(
                    selected = !siblingsEnabled,
                    onClick = { siblingsEnabled = false },
                )
                Spacer(Modifier.padding(start = FS.space.s2))
                Text(text = "No", color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
            }
            if (app.siblingsEnabled != siblingsEnabled) {
                Spacer(Modifier.height(FS.space.s2))
                Text(
                    text = if (siblingsEnabled)
                        "Saving will re-open vibe-code with this app's files. The AI will rewrite it to be sibling-aware."
                    else
                        "Saving will re-open vibe-code. The AI will rewrite it as per-pod independent state.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                )
            }
        }

        Spacer(Modifier.height(FS.space.s6))

        // ── URLs
        SectionHeader("URLs")
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            urls.forEach { url -> UrlRow(url) }
        }

        Spacer(Modifier.height(FS.space.s8))
        FSPrimaryButton(
            label = "Save",
            onClick = { /* TODO: persist policy + (re-open vibe-code if siblings toggled) */ },
            block = true,
        )
        Spacer(Modifier.height(FS.space.s4))
        FSGhostButton(
            label = "Uninstall",
            onClick = { /* TODO */ },
            block = true,
        )
        Spacer(Modifier.height(FS.space.s12))
    }
}

@Composable
private fun SectionHeader(label: String) {
    Text(
        text = label,
        color = FS.colors.text,
        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
        modifier = Modifier.padding(bottom = FS.space.s3),
    )
}

@Composable
private fun UrlRow(url: UrlEntry) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.fillMaxWidth().padding(end = FS.space.s2)) {
                Text(text = url.fqdn, color = FS.colors.text, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold))
                Spacer(Modifier.height(FS.space.s1))
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSPill(label = url.kind, kind = FSPillKind.Idle)
                    FSPill(
                        label = when (url.ownedBy) {
                            "self" -> "On this pod"
                            null -> "Unclaimed"
                            else -> "On ${url.ownedBy}"
                        },
                        kind = if (url.ownedBy == "self") FSPillKind.Online else FSPillKind.Idle,
                    )
                }
            }
            if (url.canClaim && url.ownedBy != "self") {
                FSGhostButton(label = "Claim", onClick = { /* TODO: POST /api/url/claim */ })
            } else if (url.ownedBy == "self" && url.kind != "canonical") {
                FSGhostButton(label = "Release", onClick = { /* TODO: POST /api/url/release */ })
            }
        }
    }
}

private fun sampleApp(appId: String) = AppDetail(
    appId = appId,
    name = "Notes",
    creator = "alice",
    siblingsEnabled = false,
    policy = InstallPolicy(specificPods = setOf("home"), allCurrentAndFuture = false),
)

private fun samplePods() = listOf(
    PodSummary("home", "Home box", "home.alice.flagship.services"),
    PodSummary("office", "Office box", "office.alice.flagship.services"),
    PodSummary("garage", "Garage box", "garage.alice.flagship.services"),
)

private fun sampleUrls() = listOf(
    UrlEntry("notes.home.alice.flagship.services", "canonical", "self", canClaim = false),
    UrlEntry("notes.alice.flagship.services", "alias", null, canClaim = true),
)

data class AppDetail(
    val appId: String,
    val name: String,
    val creator: String,
    val siblingsEnabled: Boolean,
    val policy: InstallPolicy,
)

data class InstallPolicy(
    val specificPods: Set<String>,
    val allCurrentAndFuture: Boolean,
)

data class PodSummary(val podId: String, val label: String, val fqdn: String)

data class UrlEntry(
    val fqdn: String,
    val kind: String,
    val ownedBy: String?,
    val canClaim: Boolean,
)
