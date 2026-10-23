// "Access & permissions" on an app's page: what can act for the app now, and a way to end it.
// A box without the page (or a restricted device) shows no section.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.PermissionWords
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSCardDivider
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.ServicePermissionsViewModel
import kotlinx.coroutines.launch

@Composable
fun ServicePermissionsSection(serviceId: String, restricted: Boolean) {
    if (restricted) return
    val client = LocalScreensClient.current
    val scope = rememberCoroutineScope()
    val vm = remember(serviceId, client) { ServicePermissionsViewModel(serviceId, client) }
    LaunchedEffect(vm) { vm.load() }
    val permissions by vm.permissions.collectAsState()
    val busy by vm.busy.collectAsState()
    val notice by vm.notice.collectAsState()
    val error by vm.error.collectAsState()
    val p = permissions ?: return

    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        FSSectionHeader(PermissionWords.TITLE)
        FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("service-detail-permissions")) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                if (p.grants.isEmpty()) {
                    Text(PermissionWords.NONE, style = MaterialTheme.typography.bodyMedium)
                }
                p.grants.forEachIndexed { idx, g ->
                    if (idx > 0) FSCardDivider()
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                        Text("${PermissionWords.kindLabel(g.kind)} · ${g.capability}", style = MaterialTheme.typography.titleSmall)
                        if (g.secretAccess) Text("Can read secrets", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                        g.openWork.forEach {
                            Text("Running: $it", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                        }
                        FSSecondaryButton(
                            label = PermissionWords.REVOKE,
                            block = true,
                            enabled = !busy,
                            modifier = Modifier.testTag("service-permission-revoke-${g.id}"),
                            onClick = { scope.launch { vm.revoke(g.id) } },
                        )
                    }
                }
                p.pendingOperations.forEach {
                    Text("Waiting: ${it.kind} (${it.state})", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                }
                if (p.grants.size > 1) {
                    FSSecondaryButton(
                        label = PermissionWords.REVOKE_ALL,
                        block = true,
                        enabled = !busy,
                        modifier = Modifier.testTag("service-permission-revoke-all"),
                        onClick = { scope.launch { vm.revoke(null) } },
                    )
                }
                notice?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            }
        }
    }
}
