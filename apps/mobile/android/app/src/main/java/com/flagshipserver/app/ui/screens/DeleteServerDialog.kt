package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DeleteForever
import com.flagshipserver.app.ui.components.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.DeleteServerFlow
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.theme.FS

/** Confirm before deleting a server. A pending order keeps the plain cancel
 *  confirmation; a registered server needs its `<server>` label typed. */
@Composable
fun DeleteServerDialog(
    pod: PodInfo,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    if (pod.status == PodInfo.Status.PENDING) {
        AlertDialog(
            onDismissRequest = onDismiss,
            icon = { Icon(Icons.Outlined.DeleteForever, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
            title = { Text(fsString(R.string.delete_3, pod.name)) },
            text = {
                Text(stringResource(R.string.this_frees_the_name_for_reuse))
            },
            confirmButton = { TextButton(onClick = onConfirm) { Text(stringResource(R.string.delete_2), color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
        )
        return
    }
    var typed by remember(pod.podId) { mutableStateOf("") }
    val matches = DeleteServerFlow.confirmationMatches(typed, pod)
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("delete-server-dialog"),
        icon = { Icon(Icons.Outlined.DeleteForever, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
        title = { Text(fsString(R.string.delete_3, pod.name)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Text(
                    fsString(R.string.deletes_for_good_if_the_server, pod.name),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                FSField(
                    value = typed,
                    onValueChange = { typed = it },
                    label = fsString(R.string.type_to_confirm_2, pod.serverLabel),
                    placeholder = pod.serverLabel,
                    fieldTag = "delete-server-confirm-field",
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                enabled = matches,
                modifier = Modifier.testTag("delete-server-confirm"),
            ) { Text(stringResource(R.string.delete_server_2), color = if (matches) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}
