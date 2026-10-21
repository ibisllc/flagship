// An app's Backup card: include the data or not, an optional password, and
// "Back up now", which brings the archive from the box to this phone and
// offers to save or share it. Mirror of iOS's backup card on the app page.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import com.flagshipserver.app.ui.components.Switch
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.core.content.FileProvider
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
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

    val ready = phase as? AppBackupViewModel.Phase.Ready
    FSCard(padding = PaddingValues(FS.space.s4), modifier = Modifier.fillMaxWidth().testTag("service-detail-backup")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            lastBackup?.let {
                Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
            Text(
                stringResource(R.string.the_apps_code_and_its_data),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.include_the_apps_data),
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.weight(1f),
                )
                Switch(
                    checked = includeData,
                    onCheckedChange = { includeData = it },
                    enabled = !busy,
                    modifier = Modifier.testTag("service-detail-backup-data"),
                )
            }
            FSField(
                value = password,
                onValueChange = { password = it },
                label = stringResource(R.string.password_to_encrypt_it_optional),
                visualTransformation = PasswordVisualTransformation(),
                keyboardType = KeyboardType.Password,
                enabled = !busy,
            )
            when (val p = phase) {
                is AppBackupViewModel.Phase.Ready -> {
                    Text(
                        fsString(R.string.ready_kb, p.bytes.size / 1024, if (p.encrypted) ", encrypted" else ""),
                        color = FS.colors.success,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    FSPrimaryButton(
                        label = stringResource(R.string.save_backup),
                        block = true,
                        modifier = Modifier.testTag("service-detail-backup-save"),
                        onClick = { scope.launch { shareBackup(ctx, p.fileName, p.bytes) } },
                    )
                }
                is AppBackupViewModel.Phase.Failed ->
                    Text(p.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                else -> Unit
            }
            val backUpLabel = when (phase) {
                is AppBackupViewModel.Phase.Creating -> stringResource(R.string.packing)
                is AppBackupViewModel.Phase.Downloading -> stringResource(R.string.downloading)
                else -> stringResource(R.string.back_up_now)
            }
            val backUp = {
                scope.launch {
                    vm.backUp(includeData, password)
                    if (vm.phase.value is AppBackupViewModel.Phase.Ready) password = ""
                }
                Unit
            }
            // Save backup is the main action once an archive is ready.
            if (ready != null) {
                FSSecondaryButton(
                    label = backUpLabel,
                    enabled = !busy,
                    block = true,
                    modifier = Modifier.testTag("service-detail-backup-now"),
                    onClick = backUp,
                )
            } else {
                FSPrimaryButton(
                    label = backUpLabel,
                    enabled = !busy,
                    block = true,
                    modifier = Modifier.testTag("service-detail-backup-now"),
                    onClick = backUp,
                )
            }
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
    ctx.startActivity(Intent.createChooser(send, FSStrings.get(R.string.save_2, name)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}
