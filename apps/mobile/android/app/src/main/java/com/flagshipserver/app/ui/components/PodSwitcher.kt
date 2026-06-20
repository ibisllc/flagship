// Compact pod-context switcher — the Android mirror of iOS
// FlagshipUI/Components/PodSwitcher.swift.
//
// Shown on per-pod-scoped surfaces (the Services list) when the user owns
// more than one pod: a pill that reads the current context, tapping it
// opens a menu of pods with the leader marked. When `allLabel` is set the
// menu prepends an "All <thing>" entry mapping to `currentPodId == null`,
// so the switcher doubles as a server filter ("All servers" = every app
// regardless of which pod runs it) — exactly the iOS V8 Apps-tab variant.

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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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

    /** Whether the trigger shows the leader crown — only when a concrete pod
     *  is selected AND it is the leader (never in the "All" state). */
    fun showsLeaderCrown(currentPodId: String?, leaderPodId: String?): Boolean =
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
            if (PodSwitcherModel.showsLeaderCrown(currentPodId, leaderPodId)) {
                Text("👑", style = TextStyle(fontSize = 10.sp)) // 👑 leader
            }
            Text("▾", color = c.textMuted, style = TextStyle(fontSize = 11.sp)) // ▾
        }

        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (showAll) {
                DropdownMenuItem(
                    text = {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(allLabel!!, color = c.text)
                            Spacer(Modifier.weight(1f))
                            if (currentPodId == null) Text("✓", color = c.primary) // ✓
                        }
                    },
                    onClick = { open = false; onPickAll!!() },
                )
            }
            pods.forEach { pod ->
                DropdownMenuItem(
                    text = {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(pod.name, color = c.text)
                            if (pod.podId == leaderPodId) Text(" 👑") // 👑
                            Spacer(Modifier.weight(1f))
                            if (pod.podId == currentPodId) Text("✓", color = c.primary) // ✓
                        }
                    },
                    modifier = Modifier.testTag("pod-switcher-item-${pod.podId}"),
                    onClick = { open = false; onPick(pod) },
                )
            }
        }
    }
}
