package com.flagshipserver.app.ui.screens

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
            title = { Text("Delete ${pod.name}?") },
            text = {
                Text("This frees the name for reuse and the server can no longer come online. This install hasn't completed.")
            },
            confirmButton = { TextButton(onClick = onConfirm) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        )
        return
    }
    var typed by remember(pod.podId) { mutableStateOf("") }
    val matches = DeleteServerFlow.confirmationMatches(typed, pod)
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("delete-server-dialog"),
        icon = { Icon(Icons.Outlined.DeleteForever, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
        title = { Text("Delete ${pod.name}?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Text(
                    "Deletes ${pod.name} for good. If the server is online it erases its data and powers off; " +
                        "if it's offline it can never come back online. The name becomes free to reuse.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                FSField(
                    value = typed,
                    onValueChange = { typed = it },
                    label = "Type ${pod.serverLabel} to confirm",
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
            ) { Text("Delete server", color = if (matches) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
