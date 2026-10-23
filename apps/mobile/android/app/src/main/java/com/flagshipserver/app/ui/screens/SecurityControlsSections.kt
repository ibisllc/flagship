// The three owner controls from the 0.3 security work (core/SecurityControls.kt): restored permissions
// waiting for an admin, how an app takes updates, and letting one Remote browser session build one app.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.SecurityControlWords
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.RadioButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.CompanionDelegationViewModel
import com.flagshipserver.app.viewmodels.RestoredAccessViewModel
import com.flagshipserver.app.viewmodels.UpdateModeViewModel
import kotlinx.coroutines.launch

@Composable
fun RestoredAccessSection(serviceId: String, canApprove: Boolean) {
    val client = LocalScreensClient.current
    val scope = rememberCoroutineScope()
    val vm = remember(serviceId, client) { RestoredAccessViewModel(serviceId, client) }
    LaunchedEffect(vm) { vm.load() }
    val draft by vm.draft.collectAsState()
    val error by vm.error.collectAsState()
    val d = draft ?: return
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        FSSectionHeader(SecurityControlWords.RESTORED_TITLE)
        FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("service-detail-restored-access")) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Text(SecurityControlWords.RESTORED_INTRO, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                Text("${d.people} ${if (d.people == 1) "person" else "people"} on the old list.${if (d.mode == "open") " The app was open to all." else ""}", style = MaterialTheme.typography.bodyMedium)
                if (canApprove) {
                    FSPrimaryButton(SecurityControlWords.RESTORED_APPROVE, block = true, modifier = Modifier.testTag("restored-access-approve"), onClick = { scope.launch { vm.approve() } })
                    FSSecondaryButton(SecurityControlWords.RESTORED_DISCARD, block = true, modifier = Modifier.testTag("restored-access-discard"), onClick = { scope.launch { vm.discard() } })
                } else {
                    Text(SecurityControlWords.RESTORED_ADMIN_ONLY, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            }
        }
    }
}

@Composable
fun UpdateModeSection(serviceId: String, restricted: Boolean) {
    if (restricted) return
    val client = LocalScreensClient.current
    val scope = rememberCoroutineScope()
    val vm = remember(serviceId, client) { UpdateModeViewModel(serviceId, client) }
    LaunchedEffect(vm) { vm.load() }
    val state by vm.state.collectAsState()
    val error by vm.error.collectAsState()
    val s = state ?: return
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        FSSectionHeader(SecurityControlWords.UPDATES_TITLE)
        FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("service-detail-update-mode")) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                s.modes.filter { SecurityControlWords.updateLabel(it) != null }.forEach { m ->
                    Row(
                        Modifier.fillMaxWidth().clickable { scope.launch { vm.choose(m) } }.testTag("update-mode-$m"),
                        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
                        verticalAlignment = Alignment.Top,
                    ) {
                        RadioButton(selected = m == s.mode, onClick = { scope.launch { vm.choose(m) } })
                        Column {
                            Text(SecurityControlWords.updateLabel(m)!!, style = MaterialTheme.typography.titleSmall)
                            Text(SecurityControlWords.updateNote(m) ?: "", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            }
        }
    }
}

/** Under a docked browser session: what it may build now, and the way to let it change one more app. */
@Composable
fun CompanionDelegationRowSection(sessionId: String, canSign: Boolean) {
    val client = LocalScreensClient.current
    val scope = rememberCoroutineScope()
    val vm = remember(sessionId, client) { CompanionDelegationViewModel(sessionId, client) }
    LaunchedEffect(vm) { vm.load() }
    val rows by vm.rows.collectAsState()
    val error by vm.error.collectAsState()
    var choosing by remember { mutableStateOf(false) }
    var apps by remember { mutableStateOf(listOf<Pair<String, String>>()) }
    var picked by remember { mutableStateOf("") }
    var build by remember { mutableStateOf(true) }
    var deploy by remember { mutableStateOf(false) }
    var minutes by remember { mutableStateOf(60L) }

    Column(Modifier.padding(top = FS.space.s2), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        rows.forEach { r ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("May ${r.ops.joinToString(" and ")} ${r.serviceRef}", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                FSSecondaryButton(SecurityControlWords.DELEGATE_END, modifier = Modifier.testTag("delegation-end-${r.serviceRef}"), onClick = { scope.launch { vm.end(r.serviceRef) } })
            }
        }
        if (!canSign) {
            Text(SecurityControlWords.DELEGATE_ADMIN_ONLY, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        } else if (!choosing) {
            FSSecondaryButton(SecurityControlWords.DELEGATE_OPEN, block = true, modifier = Modifier.testTag("delegation-open"), onClick = {
                scope.launch {
                    apps = try { client.appsList().apps.map { it.serviceId to it.slug } } catch (_: Throwable) { emptyList() }
                    picked = apps.firstOrNull()?.first ?: ""
                    choosing = true
                }
            })
        } else {
            Text(SecurityControlWords.DELEGATE_TITLE, style = MaterialTheme.typography.titleSmall)
            Text(SecurityControlWords.DELEGATE_INTRO, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            apps.forEach { (id, slug) ->
                Row(Modifier.fillMaxWidth().clickable { picked = id }, verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = picked == id, onClick = { picked = id })
                    Text(slug)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(build, { build = it }); Text(SecurityControlWords.DELEGATE_BUILD) }
            Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(deploy, { deploy = it }); Text(SecurityControlWords.DELEGATE_DEPLOY) }
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                listOf(30L to "30 min", 60L to "1 hour", 240L to "4 hours", 1440L to "24 hours").forEach { (m, label) ->
                    FSSecondaryButton(if (minutes == m) "• $label" else label, onClick = { minutes = m })
                }
            }
            FSPrimaryButton(SecurityControlWords.DELEGATE_ALLOW, block = true, modifier = Modifier.testTag("delegation-allow"), onClick = {
                val ops = listOfNotNull("build".takeIf { build }, "deploy".takeIf { deploy })
                if (ops.isNotEmpty() && picked.isNotEmpty()) scope.launch { vm.allow(picked, ops, minutes * 60_000); choosing = false }
            })
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
}
