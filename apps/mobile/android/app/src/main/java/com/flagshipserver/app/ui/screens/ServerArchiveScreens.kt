// "Backup/clone server" (docs/server-backup-and-clone.md): the server page's
// card and dialog, and Home's import dialog. MIRRORS the iOS ServerArchiveScreens.swift.

package com.flagshipserver.app.ui.screens

import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalPodClients
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.ServerArchive
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.ArchiveSource
import com.flagshipserver.app.viewmodels.ImportBackupViewModel
import com.flagshipserver.app.viewmodels.ServerBackupViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/** The server page's Backup section. */
@Composable
internal fun ServerBackupCard(serverDomain: String) {
    var show by remember { mutableStateOf(false) }
    Text(
        "Backup",
        color = FS.colors.text,
        style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
    )
    Spacer(Modifier.height(FS.space.s2))
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                ServerArchive.BACKUP_NOTE,
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
            )
            FSPrimaryButton(
                label = "Backup/clone server",
                onClick = { show = true },
                block = true,
                modifier = Modifier.semantics { contentDescription = "sd-backup-server" },
            )
        }
    }
    if (show) ServerBackupDialog(serverDomain, onDismiss = { show = false })
}

@Composable
private fun ServerBackupDialog(serverDomain: String, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val app = LocalAppState.current
    val podClients = LocalPodClients.current
    val screens = LocalScreensClient.current
    val scope = rememberCoroutineScope()
    val vm = remember(serverDomain) {
        val pod = app.pods.value.firstOrNull { it.fqdn.equals(serverDomain, ignoreCase = true) }
        ServerBackupViewModel(
            serverFqdn = serverDomain,
            client = (pod?.let { podClients.screens(it) }) ?: screens,
            keyProvider = { id -> Keystore.deriveServerArchiveKey(id, "Back up $serverDomain") },
            downloadFile = { File(context.cacheDir, "server-backup.${ServerArchive.FILE_EXTENSION}") },
        )
    }
    val phase by vm.phase.collectAsState()
    var saveError by remember { mutableStateOf<String?>(null) }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri: Uri? ->
        val saved = phase as? ServerBackupViewModel.Phase.Saved
        if (uri != null && saved != null) {
            scope.launch {
                saveError = runCatching {
                    withContext(Dispatchers.IO) {
                        context.contentResolver.openOutputStream(uri)!!.use { out -> saved.file.inputStream().use { it.copyTo(out) } }
                    }
                }.exceptionOrNull()?.let { "Couldn't save the file there." }
            }
        }
    }
    LaunchedEffect(vm) { vm.start() }
    AlertDialog(
        // Closing never stops the server: reopening follows the same backup.
        onDismissRequest = onDismiss,
        title = { Text("Backup/clone server") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                when (val p = phase) {
                    ServerBackupViewModel.Phase.Idle -> Text("Starting…", color = FS.colors.text)
                    is ServerBackupViewModel.Phase.Building -> {
                        Text(p.label, color = FS.colors.text)
                        LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
                    }
                    is ServerBackupViewModel.Phase.Ready -> {
                        Text("Backup ready (${ServerArchive.formatBytes(p.bytes)}). Save it somewhere safe.", color = FS.colors.text)
                        FSPrimaryButton(label = "Download backup", onClick = { scope.launch { vm.download() } }, block = true)
                    }
                    is ServerBackupViewModel.Phase.Downloading -> {
                        Text("Downloading…", color = FS.colors.text)
                        LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
                    }
                    is ServerBackupViewModel.Phase.Saved -> {
                        Text("Downloaded. The server has removed its copy. Choose where to keep the file.", color = FS.colors.text)
                        FSPrimaryButton(label = "Save backup…", onClick = { saver.launch(p.suggestedName) }, block = true)
                        saveError?.let { Text(it, color = FS.colors.danger) }
                    }
                    is ServerBackupViewModel.Phase.Failed -> {
                        Text(p.message, color = FS.colors.danger)
                        FSSecondaryButton(label = "Try again", onClick = { scope.launch { vm.start() } }, block = true)
                    }
                }
                Text(
                    ServerArchive.EXCLUDES_NOTE,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                )
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
    )
}

/** Up to [n] bytes, fewer only at the end (InputStream.readNBytes needs API 33). */
private fun readUpTo(input: java.io.InputStream, n: Int): ByteArray {
    val buf = ByteArray(n)
    var got = 0
    while (got < n) {
        val r = input.read(buf, got, n - got)
        if (r < 0) break
        got += r
    }
    return if (got == n) buf else buf.copyOf(got)
}

private fun archiveSource(context: Context, uri: Uri): ArchiveSource {
    val size = context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: 0L
    return object : ArchiveSource {
        override val size: Long = size
        // The upload reads front to back, so one stream stays open between
        // chunks instead of re-opening and skipping to each offset.
        private var stream: java.io.InputStream? = null
        private var position = 0L

        override suspend fun readHead(): ByteArray = withContext(Dispatchers.IO) {
            context.contentResolver.openInputStream(uri)!!.use { readUpTo(it, ServerArchive.HEADER_MAX_BYTES) }
        }

        override suspend fun read(offset: Long, length: Int): ByteArray = withContext(Dispatchers.IO) {
            if (stream == null || offset != position) {
                stream?.close()
                val s = context.contentResolver.openInputStream(uri)!!
                var skipped = 0L
                while (skipped < offset) {
                    val n = s.skip(offset - skipped)
                    if (n <= 0) break
                    skipped += n
                }
                stream = s
                position = skipped
            }
            val out = readUpTo(stream!!, length)
            position += out.size
            if (position >= size) {
                stream?.close()
                stream = null
            }
            out
        }
    }
}

/** Home → Add/Import a server → Import a backup. */
@Composable
internal fun ImportBackupDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val app = LocalAppState.current
    val podClients = LocalPodClients.current
    val scope = rememberCoroutineScope()
    val pods = app.pods.collectAsState().value
    val vm = remember {
        val online = pods.filter { it.status == PodInfo.Status.ONLINE && it.fqdn.isNotEmpty() }
        ImportBackupViewModel(
            targets = online.map { ImportBackupViewModel.Target(it.fqdn, it.name) },
            clientFor = { fqdn -> online.firstOrNull { it.fqdn.equals(fqdn, ignoreCase = true) }?.let { podClients.screens(it) } },
            keyProvider = { id -> Keystore.deriveServerArchiveKey(id, "Import a server backup") },
        )
    }
    val phase by vm.phase.collectAsState()
    val selected by vm.selectedFqdn.collectAsState()
    val fileError by vm.fileError.collectAsState()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) scope.launch { vm.choose(archiveSource(context, uri)) }
    }
    val busy = phase is ImportBackupViewModel.Phase.Uploading || phase is ImportBackupViewModel.Phase.Restoring
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Import a backup") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(ServerArchive.CLONE_HINT, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp))
                if (vm.targets.isEmpty()) {
                    Text(
                        "No server of yours is online right now. Add the new server first, wait for it to come online, then import.",
                        color = FS.colors.danger,
                    )
                } else when (val p = phase) {
                    ImportBackupViewModel.Phase.Picking -> {
                        FSPrimaryButton(
                            label = "Choose backup file",
                            onClick = { picker.launch(arrayOf("*/*")) },
                            block = true,
                            modifier = Modifier.semantics { contentDescription = "import-backup-choose" },
                        )
                        fileError?.let { Text(it, color = FS.colors.danger) }
                    }
                    is ImportBackupViewModel.Phase.Chosen -> {
                        val h = p.header
                        Text(
                            "From ${h.sourceServer.ifEmpty { "a server" }}: ${h.appNames.joinToString(", ").ifEmpty { "no apps" }} (${ServerArchive.formatBytes(p.bytes)}).",
                            color = FS.colors.text,
                        )
                        Text("Import onto", color = FS.colors.textMuted)
                        vm.targets.forEach { t ->
                            Row(
                                Modifier.fillMaxWidth().selectable(selected = selected == t.fqdn, onClick = { vm.select(t.fqdn) }).padding(FS.space.s1),
                            ) {
                                RadioButton(selected = selected == t.fqdn, onClick = { vm.select(t.fqdn) })
                                Text(t.label, color = FS.colors.text)
                            }
                        }
                        Text(
                            "Apps already on that server are left alone. Apps are installed under that server's own name.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                        )
                        FSPrimaryButton(
                            label = "Import",
                            onClick = { scope.launch { vm.startImport() } },
                            block = true,
                            modifier = Modifier.semantics { contentDescription = "import-backup-go" },
                        )
                        FSSecondaryButton(label = "Choose another file", onClick = { picker.launch(arrayOf("*/*")) }, block = true)
                    }
                    is ImportBackupViewModel.Phase.Uploading -> {
                        Text("Sending the backup to the server…", color = FS.colors.text)
                        LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
                    }
                    is ImportBackupViewModel.Phase.Restoring -> {
                        Text("Restoring the apps…", color = FS.colors.text)
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                        p.apps.forEach { Text(ImportBackupViewModel.describe(it), color = FS.colors.textMuted) }
                    }
                    is ImportBackupViewModel.Phase.Done -> {
                        Text("Import finished.", color = FS.colors.text)
                        p.apps.forEach { Text(ImportBackupViewModel.describe(it), color = FS.colors.textMuted) }
                    }
                    is ImportBackupViewModel.Phase.Failed -> {
                        Text(p.message, color = FS.colors.danger)
                        FSSecondaryButton(label = "Try again", onClick = { vm.retry() }, block = true)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Done") } },
    )
}
