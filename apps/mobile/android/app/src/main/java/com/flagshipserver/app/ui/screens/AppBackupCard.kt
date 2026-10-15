// An app's Backup card: include the data or not, an optional password, and
// "Back up now", which brings the archive from the box to this phone and
// offers to save or share it. Mirror of iOS's backup card on the app page.

package com.flagshipserver.app.ui.screens

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.AppBackupViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

@Composable
fun AppBackupCard(serviceId: String, client: ScreensClient, lastBackup: String?) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val vm = remember(serviceId, client) { AppBackupViewModel(serviceId, client) }
    val phase by vm.phase.collectAsState()
    var includeData by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    val busy = phase is AppBackupViewModel.Phase.Creating || phase is AppBackupViewModel.Phase.Downloading

    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("service-detail-backup")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            lastBackup?.let { Text(it, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp)) }
            Text(
                "The app's code, and its data if you include it. It comes straight from your server to this phone.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Include the app's data", color = FS.colors.text, style = TextStyle(fontSize = 14.sp), modifier = Modifier.weight(1f))
                Switch(
                    checked = includeData,
                    onCheckedChange = { includeData = it },
                    enabled = !busy,
                    modifier = Modifier.testTag("service-detail-backup-data"),
                )
            }
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("Password to encrypt it (optional)") },
                visualTransformation = PasswordVisualTransformation(),
                enabled = !busy,
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            when (val p = phase) {
                is AppBackupViewModel.Phase.Ready -> {
                    Text(
                        "Ready: ${p.bytes.size / 1024} KB${if (p.encrypted) ", encrypted" else ""}",
                        color = FS.colors.success,
                        style = TextStyle(fontSize = 13.sp),
                    )
                    FSSecondaryButton(
                        label = "Save backup",
                        block = true,
                        modifier = Modifier.testTag("service-detail-backup-save"),
                        onClick = { scope.launch { shareBackup(ctx, p.fileName, p.bytes) } },
                    )
                }
                is AppBackupViewModel.Phase.Failed ->
                    Text(p.message, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
                else -> Unit
            }
            FSSecondaryButton(
                label = when (phase) {
                    is AppBackupViewModel.Phase.Creating -> "Packing…"
                    is AppBackupViewModel.Phase.Downloading -> "Downloading…"
                    else -> "Back up now"
                },
                enabled = !busy,
                block = true,
                modifier = Modifier.testTag("service-detail-backup-now"),
                onClick = {
                    scope.launch {
                        vm.backUp(includeData, password)
                        if (vm.phase.value is AppBackupViewModel.Phase.Ready) password = ""
                    }
                },
            )
        }
    }
}

// Through the app's FileProvider (res/xml/file_paths.xml: cache/backups); only
// the newest archive is kept on the phone.
private suspend fun shareBackup(ctx: Context, name: String, bytes: ByteArray) {
    val file = withContext(Dispatchers.IO) {
        val dir = File(ctx.cacheDir, "backups")
        dir.deleteRecursively()
        dir.mkdirs()
        File(dir, name).also { it.writeBytes(bytes) }
    }
    val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "application/octet-stream"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_SUBJECT, name)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    ctx.startActivity(Intent.createChooser(send, "Save $name").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}
