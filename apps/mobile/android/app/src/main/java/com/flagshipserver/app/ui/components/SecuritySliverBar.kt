// The persistent security sliver: one row per issue, grown to fit, never merged or truncated. A waiting
// publisher key gets its own card with both fingerprints, the continuity status and the two choices.
// Mirror of FlagshipUI/SecuritySliverBar.swift and the webapp's lib/sliverUi.js.

package com.flagshipserver.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.SliverLine
import com.flagshipserver.app.core.SliverWords
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.SecuritySliverViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun SecuritySliverBar() {
    val client = LocalScreensClient.current
    val vm = remember(client) { SecuritySliverViewModel(client) }
    LaunchedEffect(vm) {
        while (true) {
            vm.refresh()
            delay(60_000)
        }
    }
    val lines by vm.lines.collectAsState()
    val lost by vm.lostHistory.collectAsState()
    val waiting by vm.waiting.collectAsState()
    val error by vm.error.collectAsState()
    val scope = rememberCoroutineScope()
    if (lines.isEmpty() && !lost) return

    Column(
        Modifier.fillMaxWidth().heightIn(max = 280.dp).verticalScroll(rememberScrollState()).testTag("security-sliver").semantics { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(FS.space.s2),
    ) {
        if (lost) {
            Surface(color = FS.colors.warnWash, modifier = Modifier.fillMaxWidth()) {
                Text(SliverWords.LOST_HISTORY, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(FS.space.s3))
            }
        }
        lines.forEach { l ->
            SliverRow(
                l,
                waiting = waiting[l.target].takeIf { l.kind == "publisher-key" && l.isActive },
                onTrust = { scope.launch { vm.trust(l.target) } },
                onReject = { scope.launch { vm.reject(l.target) } },
            )
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = FS.space.s3)) }
    }
}

@Composable
private fun SliverRow(l: SliverLine, waiting: com.flagshipserver.app.core.WaitingPublisherResponse.Waiting?, onTrust: () -> Unit, onReject: () -> Unit) {
    val tint = if (l.severity == "critical" || l.severity == "high") FS.colors.warning else FS.colors.accent
    Surface(color = FS.colors.surface, modifier = Modifier.fillMaxWidth().testTag("sliver-row-${l.issueKey}")) {
        Row(Modifier.fillMaxWidth().then(Modifier)) {
            Box(Modifier.width(4.dp).fillMaxHeight().background(tint))
            Column(Modifier.weight(1f).padding(FS.space.s3), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    "${SliverWords.severityLabel(l.severity)} · ${l.target} · ${if (l.isActive) "Active" else "Resolved"}",
                    style = MaterialTheme.typography.titleSmall,
                )
                Text(l.summary, style = MaterialTheme.typography.bodyMedium)
                val extra = listOf(SliverWords.remaining(l.remainingMs), if (l.isActive) (l.action ?: "") else "").filter { it.isNotEmpty() }.joinToString(" · ")
                if (extra.isNotEmpty()) Text(extra, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                if (waiting != null) {
                    Text("Old key ${waiting.oldFingerprint} → new key ${waiting.newFingerprint}", style = MaterialTheme.typography.titleSmall)
                    Text(if (waiting.continuity == "valid-chain") SliverWords.CHAIN else SliverWords.NO_CHAIN, style = MaterialTheme.typography.bodySmall)
                    Text(SliverWords.WARNING, style = MaterialTheme.typography.bodySmall)
                    FSPrimaryButton(SliverWords.TRUST, onClick = onTrust, modifier = Modifier.fillMaxWidth().testTag("sliver-trust-${l.target}"))
                    FSSecondaryButton(SliverWords.REJECT, block = true, modifier = Modifier.testTag("sliver-reject-${l.target}"), onClick = onReject)
                }
            }
        }
    }
}
