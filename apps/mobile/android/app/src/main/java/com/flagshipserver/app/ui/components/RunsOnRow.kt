// "Runs on: <server>" on every creation flow (docs/app-placement.md §2), with
// a picker of the account's servers. Fixed (no picker) when the flow was
// started from a server's page, or once the request has gone out.

package com.flagshipserver.app.ui.components

import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import com.flagshipserver.app.ui.components.RadioButton
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.CreationPlacement
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalPodClients
import com.flagshipserver.app.core.LocalPodScope
import com.flagshipserver.app.ui.theme.FS

@Composable
fun RunsOnRow(modifier: Modifier = Modifier, locked: Boolean = false) {
    val scope = LocalPodScope.current ?: return
    if (!scope.creation) return
    val app = LocalAppState.current
    val podClients = LocalPodClients.current
    val pods by app.pods.collectAsState()
    val leaderId by app.leaderPodId.collectAsState()
    val options = CreationPlacement.options(pods) { podClients.screens(it) != null }
    val canPick = !locked && CreationPlacement.showsPicker(scope, options)
    var open by remember { mutableStateOf(false) }

    Row(
        modifier = modifier.fillMaxWidth().testTag("runs-on-row"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("Runs on", color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Medium))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    scope.pod.name,
                    color = FS.colors.text,
                    style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
                    modifier = Modifier.testTag("runs-on-name"),
                )
                if (scope.pod.podId == leaderId) {
                    Spacer(Modifier.width(FS.space.s2))
                    FSPill(label = "Preferred", kind = FSPillKind.Idle)
                }
            }
        }
        if (canPick) {
            TextButton(onClick = { open = true }, modifier = Modifier.testTag("runs-on-change")) { Text("Change") }
        }
    }

    if (open && canPick) {
        AlertDialog(
            onDismissRequest = { open = false },
            title = { Text("Where should it run?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                    options.forEach { opt ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable(enabled = opt.available) {
                                    scope.choose?.invoke(opt.pod.podId)
                                    open = false
                                }
                                .padding(vertical = FS.space.s1)
                                .testTag("runs-on-option-${opt.pod.podId}"),
                        ) {
                            RadioButton(
                                selected = opt.pod.podId == scope.pod.podId,
                                enabled = opt.available,
                                onClick = {
                                    scope.choose?.invoke(opt.pod.podId)
                                    open = false
                                },
                            )
                            Column(Modifier.weight(1f)) {
                                Text(
                                    opt.pod.name + if (opt.pod.podId == leaderId) " (preferred)" else "",
                                    color = if (opt.available) FS.colors.text else FS.colors.textMuted,
                                    style = MaterialTheme.typography.bodyLarge,
                                )
                                Text(
                                    if (opt.available) opt.pod.fqdn else CreationPlacement.UNAVAILABLE,
                                    color = FS.colors.textMuted,
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { open = false }) { Text("Done") } },
        )
    }
}
