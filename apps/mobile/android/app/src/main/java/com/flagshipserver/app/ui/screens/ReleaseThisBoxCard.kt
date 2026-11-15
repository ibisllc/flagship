// The server page's "Release this box" on a retail box (docs/retail-box-setup.md §8.2). Mirrors iOS.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import com.flagshipserver.app.R
import com.flagshipserver.app.ui.components.AlertDialog
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.TextButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.ReleaseThisBoxViewModel
import kotlinx.coroutines.launch

@Composable
internal fun ReleaseThisBoxCard(vm: ReleaseThisBoxViewModel) {
    val state by vm.state.collectAsState()
    val scope = rememberCoroutineScope()
    var confirm by remember { mutableStateOf(false) }

    com.flagshipserver.app.ui.components.FSSectionHeader(stringResource(R.string.release_box_title))
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(stringResource(R.string.release_box_warning), color = FS.colors.text, style = MaterialTheme.typography.bodySmall)
            Text(stringResource(R.string.release_box_suggestion), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            when {
                state.released -> Text(
                    stringResource(R.string.release_box_done),
                    color = FS.colors.text,
                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
                    modifier = Modifier.testTag("sd-release-done"),
                )
                vm.canRelease -> FSDangerButton(
                    label = if (state.busy) stringResource(R.string.release_box_busy) else stringResource(R.string.release_box_title),
                    onClick = { confirm = true },
                    enabled = !state.busy,
                    modifier = Modifier.testTag("sd-release-button"),
                )
                else -> Text(stringResource(R.string.release_box_admin_only), color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            }
            state.error?.let {
                Text(it, color = FS.colors.danger, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("sd-release-error"))
            }
        }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(stringResource(R.string.release_box_confirm_title)) },
            text = { Text(stringResource(R.string.release_box_warning)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirm = false
                        scope.launch { vm.release() }
                    },
                    modifier = Modifier.testTag("sd-release-confirm"),
                ) { Text(stringResource(R.string.release_box_confirm), color = FS.colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}
