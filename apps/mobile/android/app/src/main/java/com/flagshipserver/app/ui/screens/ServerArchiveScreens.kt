// "Backup/clone server" (docs/server-backup-and-clone.md): the server page's
// backup dialog, and Home's Import a backup screen (which hands its create step
// to the create screen). MIRRORS the iOS ServerArchiveScreens.swift.

package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalPodClients
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.ServerArchive
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import com.flagshipserver.app.viewmodels.ImportBackupViewModel
import com.flagshipserver.app.viewmodels.PickedFile
import com.flagshipserver.app.viewmodels.ServerBackupViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.InputStream

private val captionStyle: TextStyle
    @Composable get() = MaterialTheme.typography.bodySmall
private val bodySmStyle: TextStyle
    @Composable get() = MaterialTheme.typography.bodyMedium

/** "Backup/clone server" button in the server page's Backup / Migrate card. */
@Composable
internal fun ServerBackupButton(serverDomain: String) {
    var show by remember { mutableStateOf(false) }
    FSPrimaryButton(
        label = "Backup/clone server",
        onClick = { show = true },
        block = true,
        modifier = Modifier.semantics { contentDescription = "sd-backup-server" },
    )
    if (show) ServerBackupDialog(serverDomain, onDismiss = { show = false })
}

/** Write both files into a folder the user picked (a tree from ACTION_OPEN_DOCUMENT_TREE). */
private fun saveIntoFolder(context: Context, tree: Uri, files: List<File>) {
    val resolver = context.contentResolver
    val dir = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
    for (f in files) {
        val doc = DocumentsContract.createDocument(resolver, dir, "application/octet-stream", f.name)
            ?: throw java.io.IOException("couldn't create ${f.name}")
        resolver.openOutputStream(doc)!!.use { out -> f.inputStream().use { it.copyTo(out, 1 shl 20) } }
    }
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
            accountKek = { id -> Keystore.deriveServerArchiveKey(id, "Back up $serverDomain") },
            downloadDir = { File(context.cacheDir, "server-backups") },
        )
    }
    val phase by vm.phase.collectAsState()
    var copied by remember { mutableStateOf(false) }
    var saveNote by remember { mutableStateOf<String?>(null) }
    var saveError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val folderPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { tree: Uri? ->
        val saved = phase as? ServerBackupViewModel.Phase.Saved
        if (tree != null && saved != null) {
            scope.launch {
                saving = true
                saveError = null
                val result = runCatching { withContext(Dispatchers.IO) { saveIntoFolder(context, tree, saved.files) } }
                saving = false
                if (result.isSuccess) {
                    saveNote = "Saved both files in the folder you picked."
                    withContext(Dispatchers.IO) { saved.files.forEach { it.delete() } }
                } else {
                    saveError = "Couldn't save the files there. Pick another folder."
                }
            }
        }
    }
    LaunchedEffect(vm) { vm.load() }
    AlertDialog(
        // Closing never stops the server: reopening follows the same backup.
        onDismissRequest = { if (!saving) onDismiss() },
        title = { Text("Backup/clone server") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                when (val p = phase) {
                    ServerBackupViewModel.Phase.Checking -> CircularProgressIndicator(Modifier.size(24.dp))
                    ServerBackupViewModel.Phase.Passcode -> PasscodeStep(
                        vm = vm,
                        copied = copied,
                        onCopy = {
                            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            cm.setPrimaryClip(ClipData.newPlainText("Backup passcode", vm.suggestedPasscode))
                            copied = true
                        },
                        onStart = { scope.launch { vm.start() } },
                    )
                    is ServerBackupViewModel.Phase.Building -> {
                        Text(p.label, color = MaterialTheme.colorScheme.onSurface)
                        LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
                    }
                    is ServerBackupViewModel.Phase.Ready -> {
                        Text("Backup ready: two files, ${ServerArchive.formatBytes(p.bytes)} in all. Keep them together.", color = MaterialTheme.colorScheme.onSurface)
                        if (vm.leftOut.isNotEmpty()) {
                            Text(
                                "Left out (no source to rebuild them from): ${vm.leftOut.joinToString(", ")}.",
                                color = MaterialTheme.colorScheme.error,
                                style = captionStyle,
                            )
                        }
                        FSPrimaryButton(
                            label = "Download both files",
                            onClick = { scope.launch { vm.download() } },
                            block = true,
                            modifier = Modifier.testTag("backup-download"),
                        )
                    }
                    is ServerBackupViewModel.Phase.Downloading -> {
                        Text("Downloading…", color = MaterialTheme.colorScheme.onSurface)
                        LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
                    }
                    is ServerBackupViewModel.Phase.Saved -> {
                        Text(
                            "Downloaded. The server has removed its copy. Save both files together: pick a folder (on this phone, a cloud drive or a USB drive) and both go there.",
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                        p.files.forEach { Text(it.name, color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle) }
                        saveNote?.let { Text(it, color = FS.colors.success) }
                        saveError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                        if (saveNote == null) {
                            FSPrimaryButton(
                                label = if (saving) "Saving…" else "Save both files…",
                                onClick = { folderPicker.launch(null) },
                                enabled = !saving,
                                block = true,
                                modifier = Modifier.testTag("backup-share"),
                            )
                        }
                    }
                    is ServerBackupViewModel.Phase.Failed -> {
                        Text(p.message, color = MaterialTheme.colorScheme.error)
                        FSSecondaryButton(label = "Try again", onClick = { vm.tryAgain() }, block = true)
                    }
                }
                Text(ServerArchive.EXCLUDES_NOTE, color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle)
            }
        },
        confirmButton = { TextButton(onClick = onDismiss, enabled = !saving) { Text("Done") } },
    )
}

@Composable
internal fun PasscodeStep(vm: ServerBackupViewModel, copied: Boolean, onCopy: () -> Unit, onStart: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        Text(
            "Set the backup's passcode",
            color = MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.titleMedium,
        )
        Text(ServerArchive.PASSCODE_NOTE, color = MaterialTheme.colorScheme.onSurfaceVariant, style = bodySmStyle)
        if (vm.useOwnPasscode) {
            FSField(
                value = vm.ownPasscode,
                onValueChange = { vm.ownPasscode = it },
                label = "Your passcode",
                visualTransformation = PasswordVisualTransformation(),
                fieldTag = "backup-own-passcode",
            )
            FSField(
                value = vm.ownPasscodeAgain,
                onValueChange = { vm.ownPasscodeAgain = it },
                label = "Type it again",
                visualTransformation = PasswordVisualTransformation(),
                fieldTag = "backup-own-passcode-again",
            )
            vm.ownPasscodeHint?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle) }
            TextButton(onClick = { vm.useOwnPasscode = false }) { Text("Use the suggested passcode") }
        } else {
            FSCard(modifier = Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Text(
                        "Suggested passcode",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.labelLarge,
                    )
                    SelectionContainer {
                        Text(
                            vm.suggestedPasscode,
                            color = MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace),
                            modifier = Modifier.testTag("backup-suggested-passcode"),
                        )
                    }
                    FSSecondaryButton(label = if (copied) "Copied" else "Copy", onClick = onCopy)
                }
            }
            TextButton(onClick = { vm.useOwnPasscode = true }, modifier = Modifier.testTag("backup-use-own-passcode")) {
                Text("Use my own passcode instead")
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text("I've saved the passcode somewhere safe", color = MaterialTheme.colorScheme.onSurface, style = bodySmStyle, modifier = Modifier.weight(1f))
            Switch(
                checked = vm.passcodeSaved,
                onCheckedChange = { vm.passcodeSaved = it },
                modifier = Modifier.testTag("backup-passcode-saved"),
            )
        }
        FSPrimaryButton(
            label = "Make the backup",
            onClick = onStart,
            enabled = vm.canStart,
            block = true,
            modifier = Modifier.testTag("backup-start"),
        )
    }
}

// ── Import a backup ────────────────────────────────────────────────

/** A file picked through the system picker (SAF), read where it is: on this
 *  phone, a cloud drive or a USB drive. Its read permission is kept while the
 *  restore needs it and given back after. */
private class SafPickedFile(private val context: Context, private val uri: Uri) : PickedFile {
    override val name: String
    override val size: Long

    init {
        var n: String? = null
        var s: Long? = null
        runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    n = c.getString(0)
                    if (!c.isNull(1)) s = c.getLong(1)
                }
            }
        }
        name = n ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file"
        size = s ?: runCatching { context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } }.getOrNull() ?: 0L
        runCatching { context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }

    override fun open(): InputStream =
        context.contentResolver.openInputStream(uri) ?: throw java.io.IOException("can't open $name")

    override fun release() {
        runCatching { context.contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }
}

/** Home → Add/Import a server → Import a backup (or a waiting server's "Send
 *  the backup"): builds the view model from the account's servers and hands
 *  the create step to the existing create screen. */
@Composable
internal fun ImportBackupRoute(
    targetFqdn: String?,
    /** The create screen made a server (put it on Home like any new server). */
    onServerCreated: (serverDomain: String, serial: String, name: String) -> Unit,
    onClose: () -> Unit,
) {
    val app = LocalAppState.current
    val podClients = LocalPodClients.current
    val vm = remember {
        val pods = app.pods.value
        val taken = pods.mapNotNull { pod ->
            val label = pod.fqdn.substringBefore('.').ifEmpty { pod.name }
            label.lowercase().ifEmpty { null }
        }.toSet()
        val waiting = app.podsAwaitingBackup.value.entries.associate { (fqdn, w) -> w.archiveId to fqdn }
        ImportBackupViewModel(
            username = app.currentUser.value ?: "you",
            takenNames = taken,
            waitingServers = waiting,
            targetFqdn = targetFqdn,
            clientFor = { fqdn ->
                val pod = app.pods.value.firstOrNull { it.fqdn.equals(fqdn, ignoreCase = true) }
                    ?: PodInfo(podId = PodInfo.podId(fqdn), name = fqdn.substringBefore('.'), fqdn = fqdn, status = PodInfo.Status.PENDING)
                podClients.screens(pod)
            },
            accountKek = { id -> Keystore.deriveServerArchiveKey(id, "Open the backup") },
            onRestored = { fqdn -> app.clearAwaitingBackup(fqdn) },
        )
    }
    DisposableEffect(vm) { onDispose { vm.stop() } }
    val phase by vm.phase.collectAsState()
    val target = vm.createTarget
    if (phase == ImportBackupViewModel.Phase.Creating && target != null) {
        // Both callbacks can fire for one server (the builder pairing shows it
        // early); the server goes on Home and the send starts once.
        var started by remember(target) { mutableStateOf<String?>(null) }
        val delivered: (String, String, String) -> Unit = { serverDomain, serial, name ->
            if (started != serverDomain.lowercase()) {
                started = serverDomain.lowercase()
                onServerCreated(serverDomain, serial, name)
                vm.send(serverDomain)
            }
        }
        CreateServerScreen(
            preset = CreateServerPreset(
                name = target.name,
                bootUnlockMode = target.bootUnlockMode,
                encryptDisk = target.diskEncryption != "none",
                restore = target.restore,
            ),
            onDeliveredVisible = { serverDomain, serial, name, _ -> delivered(serverDomain, serial, name) },
            onDelivered = { serverDomain, serial, name, _ ->
                delivered(serverDomain, serial, name)
                vm.leaveCreate(serverDomain)
            },
            onCancel = { vm.cancelCreate() },
        )
        return
    }
    ImportBackupScreen(vm = vm, onClose = onClose)
}

/** The restore flow's own pages (the create step is the create screen). */
@Composable
internal fun ImportBackupScreen(vm: ImportBackupViewModel, onClose: () -> Unit = {}, pickFiles: (() -> Unit)? = null) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val phase by vm.phase.collectAsState()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris: List<Uri> ->
        if (uris.isNotEmpty()) {
            scope.launch {
                val files = withContext(Dispatchers.IO) { uris.map { SafPickedFile(context, it) } }
                vm.choose(files)
            }
        }
    }
    val pick = pickFiles ?: { picker.launch(arrayOf("*/*")) }
    val title = when (phase) {
        is ImportBackupViewModel.Phase.Waiting, is ImportBackupViewModel.Phase.Sending,
        is ImportBackupViewModel.Phase.Restoring, is ImportBackupViewModel.Phase.Done,
        -> "Restore a backup"
        else -> "Import a backup"
    }
    fun serverName(fqdn: String) = fqdn.substringBefore('.')

    FSScreen(title = title, onBack = onClose) {
        Column(
            Modifier
                .fillMaxWidth()
                .testTag("import-backup"),
            verticalArrangement = Arrangement.spacedBy(FS.space.s4),
        ) {
            val summary = vm.summary
            when (val p = phase) {
                ImportBackupViewModel.Phase.Pick -> {
                    Text(
                        vm.targetFqdn?.let { "${serverName(it)} is waiting for its backup. Pick the backup's two files and this screen sends it." }
                            ?: ServerArchive.IMPORT_INTRO,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    FSCard(modifier = Modifier.fillMaxWidth()) {
                        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.FolderOpen, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(vm.filesSummary, color = MaterialTheme.colorScheme.onSurface, style = bodySmStyle, modifier = Modifier.testTag("import-backup-files"))
                        }
                    }
                    FSPrimaryButton(
                        label = if (vm.backupFileName == null && vm.dataFileName == null) "Choose the backup files" else "Choose the other file",
                        onClick = pick,
                        block = true,
                        modifier = Modifier.testTag("import-backup-choose"),
                    )
                    Text(
                        "You can pick both at once. They're read where they are; nothing is copied onto this phone.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = captionStyle,
                    )
                }
                ImportBackupViewModel.Phase.Passcode -> {
                    Text("This backup was made on another account. Enter its passcode to open it.", color = MaterialTheme.colorScheme.onSurface)
                    FSField(
                        value = vm.passcode,
                        onValueChange = { vm.passcode = it },
                        label = "Passcode",
                        visualTransformation = PasswordVisualTransformation(),
                        fieldTag = "import-backup-passcode",
                    )
                    FSPrimaryButton(
                        label = "Open the backup",
                        onClick = { scope.launch { vm.unlock() } },
                        enabled = vm.passcode.isNotEmpty(),
                        block = true,
                        modifier = Modifier.testTag("import-backup-unlock"),
                    )
                }
                ImportBackupViewModel.Phase.Opening -> Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                ) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Text("Opening the backup…", color = MaterialTheme.colorScheme.onSurface)
                }
                is ImportBackupViewModel.Phase.Checking -> {
                    summary?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = bodySmStyle) }
                    Text("Checking the data file…", color = MaterialTheme.colorScheme.onSurface)
                    LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
                }
                is ImportBackupViewModel.Phase.ChooseTarget -> {
                    summary?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = bodySmStyle) }
                    Text("${serverName(p.fqdn)} is waiting for this backup.", color = MaterialTheme.colorScheme.onSurface)
                    FSPrimaryButton(
                        label = "Send it to ${serverName(p.fqdn)}",
                        onClick = { vm.send(p.fqdn) },
                        block = true,
                        modifier = Modifier.testTag("import-backup-send-existing"),
                    )
                    FSSecondaryButton(label = "Create a new server instead", onClick = { vm.showName() }, block = true)
                }
                ImportBackupViewModel.Phase.Name -> {
                    summary?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = bodySmStyle) }
                    FSField(
                        value = vm.name,
                        onValueChange = { vm.name = it },
                        label = "Name of the new server",
                        placeholder = "home",
                        error = vm.nameProblem,
                        fieldTag = "import-backup-name",
                    )
                    if (vm.nameProblem == null && vm.name.isNotEmpty()) {
                        Text(vm.previewFqdn, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
                    }
                    vm.settingsLine?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = bodySmStyle) }
                    FSPrimaryButton(
                        label = "Create the server",
                        onClick = { vm.create() },
                        enabled = vm.canCreate,
                        block = true,
                        modifier = Modifier.testTag("import-backup-create"),
                    )
                    Text(
                        "Next you choose how to set it up (Flagship Studio, a recipe file, a USB stick), like any new server.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = captionStyle,
                    )
                }
                ImportBackupViewModel.Phase.Creating -> CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                is ImportBackupViewModel.Phase.Waiting -> Column(
                    verticalArrangement = Arrangement.spacedBy(FS.space.s3),
                    modifier = Modifier.testTag("import-backup-waiting"),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Text("Waiting for ${serverName(p.fqdn)} to come online…", color = MaterialTheme.colorScheme.onSurface)
                    }
                    Text(
                        "Set it up with the recipe if you haven't yet. Keep this screen open: the backup goes as soon as the server is up. If you leave, ${serverName(p.fqdn)} keeps waiting and shows on Home with Send the backup.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = bodySmStyle,
                    )
                }
                is ImportBackupViewModel.Phase.Sending -> {
                    Text("Sending the backup to ${serverName(p.fqdn)}…", color = MaterialTheme.colorScheme.onSurface)
                    LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
                    Text("Keep this screen open. If it stops, it picks up where it left off.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle)
                }
                is ImportBackupViewModel.Phase.Restoring -> {
                    Text("Restoring the apps on ${serverName(p.fqdn)}…", color = MaterialTheme.colorScheme.onSurface)
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    p.apps.forEach { Text(ImportBackupViewModel.describe(it), color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle) }
                }
                is ImportBackupViewModel.Phase.Done -> {
                    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = FS.colors.success)
                        Text(
                            "${serverName(p.fqdn)} is restored.",
                            color = MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.titleMedium,
                        )
                    }
                    p.apps.forEach { Text(ImportBackupViewModel.describe(it), color = MaterialTheme.colorScheme.onSurfaceVariant, style = bodySmStyle) }
                    FSPrimaryButton(label = "Done", onClick = onClose, block = true, modifier = Modifier.testTag("import-backup-done"))
                }
                is ImportBackupViewModel.Phase.Failed -> {
                    Text(p.message, color = MaterialTheme.colorScheme.error)
                    if (p.keepsWaiting) {
                        Text(
                            "The server keeps waiting for its backup. Pick the backup again from Home to send it, or delete the server there.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = bodySmStyle,
                        )
                    }
                    FSSecondaryButton(label = "Close", onClick = onClose, block = true)
                }
            }
            vm.fileError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = bodySmStyle, modifier = Modifier.testTag("import-backup-error")) }
        }
    }
}

/** Opened by the QR on a backup's browser download page. */
@Composable
internal fun BackupDownloadApprovalDialog(serverFqdn: String, archiveId: String, requestId: String, onDismiss: () -> Unit) {
    val app = LocalAppState.current
    val podClients = LocalPodClients.current
    val scope = rememberCoroutineScope()
    val vm = remember(requestId) {
        val pod = app.pods.value.firstOrNull { it.fqdn.equals(serverFqdn, ignoreCase = true) }
        com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel(
            serverFqdn = serverFqdn,
            archiveId = archiveId,
            requestId = requestId,
            client = pod?.let { podClients.screens(it) },
            sign = { bytes -> Keystore.adminSigningKey("Approve downloading the backup of $serverFqdn").sign(bytes) },
        )
    }
    val phase by vm.phase.collectAsState()
    AlertDialog(
        onDismissRequest = { if (phase != com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Working) onDismiss() },
        title = { Text("Download a backup in a browser?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    "A browser is asking to download the backup of $serverFqdn. Approve only if this code is on the page in front of you:",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    vm.code,
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.headlineMedium.copy(letterSpacing = 6.sp, fontFamily = FontFamily.Monospace),
                    modifier = Modifier.semantics { contentDescription = "backup-approve-code" },
                )
                Text(
                    "The backup opens only with its passcode or on your own devices, but anyone at that browser can save the files.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = captionStyle,
                )
                when (val p = phase) {
                    com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Approved ->
                        Text("Approved. The downloads start in that browser.", color = FS.colors.success)
                    is com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Failed ->
                        Text(p.message, color = MaterialTheme.colorScheme.error)
                    else -> {}
                }
            }
        },
        confirmButton = {
            if (phase == com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Approved) {
                TextButton(onClick = onDismiss) { Text("Done") }
            } else {
                TextButton(
                    onClick = { scope.launch { vm.approve() } },
                    enabled = phase != com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Working,
                    modifier = Modifier.semantics { contentDescription = "backup-approve" },
                ) { Text(if (phase == com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Working) "Approving…" else "Approve") }
            }
        },
        dismissButton = {
            if (phase != com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Approved) {
                TextButton(onClick = onDismiss) { Text("Don't approve") }
            }
        },
    )
}
