// Compact pod-context switcher — the Android mirror of iOS
// FlagshipUI/Components/PodSwitcher.swift.
//
// Shown on per-pod-scoped surfaces (the Services list, the Activity feed)
// when the user owns more than one pod: a pill that reads the current
// context, tapping it opens a menu of pods with the leader marked. When
// `allLabel` is set the menu prepends an "All <thing>" entry mapping to
// `currentPodId == null`, so the switcher doubles as a server filter ("All
// servers" = every app regardless of which pod runs it) — exactly the iOS
// V8 Apps-tab variant.

package com.flagshipserver.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.Canvas
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.ui.theme.FS

/**
 * Pure display + filtering logic for [PodSwitcher], kept Compose-free so it's
 * unit-testable (the same split as [PodStatusStyle]). Byte-for-byte parity
 * with iOS PodSwitcher's `currentName` + the ServicesListViewModel pod-name
 * URL match.
 */
object PodSwitcherModel {
    /** The label the trigger pill shows: the "all" label when nothing is
     *  selected (filter mode), else the selected pod's name, else a dash. */
    fun currentName(pods: List<PodInfo>, currentPodId: String?, allLabel: String?): String {
        if (currentPodId == null && allLabel != null) return allLabel
        return pods.firstOrNull { it.podId == currentPodId }?.name ?: "—"
    }

    /** Whether the trigger shows the leader flag — only when a concrete pod
     *  is selected AND it is the leader (never in the "All" state). */
    fun showsLeaderFlag(currentPodId: String?, leaderPodId: String?): Boolean =
        currentPodId != null && currentPodId == leaderPodId

    /** Whether an app whose canonical URL is [canonicalUrl] belongs to the pod
     *  named [podName]. Mirrors iOS ServicesListViewModel.filteredApps: the
     *  daemon URL has the shape `https://<label>.<server>.<user>...`, so the
     *  pod name appears as a `.<pod>.` subdomain segment. A stable
     *  approximation until a real `installedOn` field lands. */
    fun matchesPod(canonicalUrl: String?, podName: String): Boolean {
        val needle = podName.lowercase()
        if (needle.isEmpty()) return false
        return canonicalUrl?.lowercase()?.contains(".$needle.") == true
    }
}

/**
 * A small stylized leader flag — the functional "this is your main server"
 * marker that replaces the old 👑 crown emoji. Drawn on a [Canvas] from a
 * 0..24 viewBox: a rounded vertical pole at x=6 (y 3..21) and a filled flag
 * with a triangular swallowtail notch cut into its right edge.
 *
 * NOTE: unrelated to the retired brand "flag-on-mast pennant" LOGO — this is
 * a tiny inline status glyph requested for the switcher.
 */
@Composable
fun LeaderFlag(tint: Color, size: Dp = 12.dp) {
    Canvas(modifier = Modifier.size(size).testTag("leader-flag")) {
        val s = this.size.minDimension / 24f
        fun x(v: Float) = v * s
        fun y(v: Float) = v * s

        // Filled flag: rectangle 6.8..19 with a swallowtail notch to x=15.
        val flag = Path().apply {
            moveTo(x(6.8f), y(4f))
            lineTo(x(19f), y(4f))
            lineTo(x(15f), y(8.5f))
            lineTo(x(19f), y(13f))
            lineTo(x(6.8f), y(13f))
            close()
        }
        drawPath(flag, color = tint)

        // Pole: vertical line at x=6 from y=3 to y=21, rounded cap.
        drawLine(
            color = tint,
            start = Offset(x(6f), y(3f)),
            end = Offset(x(6f), y(21f)),
            strokeWidth = 1.8f * s,
            cap = StrokeCap.Round,
        )
    }
}

@Composable
fun PodSwitcher(
    pods: List<PodInfo>,
    currentPodId: String?,
    leaderPodId: String?,
    onPick: (PodInfo) -> Unit,
    modifier: Modifier = Modifier,
    allLabel: String? = null,
    onPickAll: (() -> Unit)? = null,
) {
    var open by remember { mutableStateOf(false) }
    val c = FS.colors
    val showAll = allLabel != null && onPickAll != null

    // Info-leak guard: the dropdown renders in its own Popup window that sits
    // ABOVE the biometric lock cover, so an open menu would leak server names
    // over the lock screen. Force it shut whenever the app locks. (Self-
    // contained — reads the same isUnlocked latch the lock gate uses.)
    val isUnlocked by LocalAppState.current.isUnlocked.collectAsState()
    LaunchedEffect(isUnlocked) {
        if (!isUnlocked) open = false
    }

    Box(modifier) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier
                .clip(CircleShape)
                .background(c.surface)
                .border(1.dp, c.border, CircleShape)
                .clickable { open = true }
                .testTag("pod-switcher")
                .padding(horizontal = 10.dp, vertical = 6.dp),
        ) {
            Text("🖥", style = TextStyle(fontSize = 12.sp)) // 🖥 server
            Text(
                text = PodSwitcherModel.currentName(pods, currentPodId, allLabel),
                color = c.text,
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
            )
            val currentPod = pods.firstOrNull { it.podId == currentPodId }
            if (PodSwitcherModel.showsLeaderFlag(currentPodId, leaderPodId) &&
                currentPod?.cameOnline == true && currentPod.status != PodInfo.Status.PENDING) {
                LeaderFlag(tint = c.primary, size = 12.dp)
            }
            Text("▾", color = c.textMuted, style = TextStyle(fontSize = 11.sp)) // ▾
        }

        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (showAll) {
                val selected = currentPodId == null
                DropdownMenuItem(
                    text = {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(allLabel!!, color = c.text)
                            Spacer(Modifier.weight(1f))
                        }
                    },
                    modifier = Modifier.then(
                        if (selected) Modifier.background(c.primary.copy(alpha = 0.16f)) else Modifier
                    ),
                    onClick = { open = false; onPickAll!!() },
                )
            }
            pods.forEach { pod ->
                val selected = pod.podId == currentPodId
                DropdownMenuItem(
                    text = {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(pod.name, color = c.text)
                            if (pod.podId == leaderPodId && pod.cameOnline && pod.status != PodInfo.Status.PENDING) {
                                Spacer(Modifier.size(4.dp))
                                LeaderFlag(tint = c.primary, size = 12.dp)
                            }
                            Spacer(Modifier.weight(1f))
                        }
                    },
                    modifier = Modifier
                        .testTag("pod-switcher-item-${pod.podId}")
                        .then(
                            if (selected) Modifier.background(c.primary.copy(alpha = 0.16f)) else Modifier
                        ),
                    onClick = { open = false; onPick(pod) },
                )
            }
        }
    }
}
