// "Backup/clone server" (docs/server-backup-and-clone.md): the server page's
// backup dialog, and Home's Import a backup screen (which hands its create step
// to the create screen). MIRRORS the iOS ServerArchiveScreens.swift.

package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
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
import androidx.compose.material3.AlertDialog
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
import com.flagshipserver.app.api.ScreensClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.PodInfo
import com.flagshipserver.app.core.BackupsText
import com.flagshipserver.app.core.ServerArchive
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
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

private val captionStyle = TextStyle(fontSize = 13.sp, lineHeight = 18.sp)
private val bodySmStyle = TextStyle(fontSize = 14.sp, lineHeight = 19.sp)

/** "Backup/clone server" button in the server page's Backup / Migrate card. */
@Composable
internal fun ServerBackupButton(serverDomain: String) {
    var show by remember { mutableStateOf(false) }
    FSPrimaryButton(
        label = "Backup/clone server",
        onClick = { show = true },
        block = true,
        enabled = !LocalServerReadOnly.current,
        modifier = Modifier.semantics { contentDescription = "sd-backup-server" },
    )
    if (show) ServerBackupDialog(serverDomain, onDismiss = { show = false })
}

/** Copy [file] into the document the user created (ACTION_CREATE_DOCUMENT). */
internal fun saveIntoDocument(context: Context, doc: Uri, file: File) {
    context.contentResolver.openOutputStream(doc)?.use { out -> file.inputStream().use { it.copyTo(out, 1 shl 20) } }
        ?: throw java.io.IOException("couldn't write ${file.name}")
}

/** The system "Save to" picker for one backup file, then the copy into it. */
@Composable
internal fun rememberSaveBackupLauncher(
    file: () -> File?,
    onSaving: (Boolean) -> Unit,
    onResult: (Boolean) -> Unit,
): androidx.activity.compose.ManagedActivityResultLauncher<String, Uri?> {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    return rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { doc: Uri? ->
        val f = file()
        if (doc != null && f != null) {
            scope.launch {
                onSaving(true)
                val ok = runCatching { withContext(Dispatchers.IO) { saveIntoDocument(context, doc, f) } }.isSuccess
                onSaving(false)
                onResult(ok)
            }
        }
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
    val saver = rememberSaveBackupLauncher(
        file = { (phase as? ServerBackupViewModel.Phase.Saved)?.file },
        onSaving = { saving = it; if (it) saveError = null },
        onResult = { ok ->
            if (ok) {
                saveNote = "Saved."
                (phase as? ServerBackupViewModel.Phase.Saved)?.file?.delete()
            } else {
                saveError = "Couldn't save the backup there. Pick another place."
            }
        },
    )
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
                        Text(p.label, color = FS.colors.text)
                        LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
                    }
                    is ServerBackupViewModel.Phase.Ready -> {
                        Text("Backup ready: one file, ${ServerArchive.formatBytes(p.bytes)}.", color = FS.colors.text)
                        if (vm.leftOut.isNotEmpty()) {
                            Text(
                                "Left out (no source to rebuild them from): ${vm.leftOut.joinToString(", ")}.",
                                color = FS.colors.danger,
                                style = captionStyle,
                            )
                        }
                        FSPrimaryButton(
                            label = "Download the backup",
                            onClick = { scope.launch { vm.download() } },
                            block = true,
                            modifier = Modifier.testTag("backup-download"),
                        )
                    }
                    is ServerBackupViewModel.Phase.Downloading -> {
                        Text("Downloading…", color = FS.colors.text)
                        LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
                    }
                    is ServerBackupViewModel.Phase.Saved -> {
                        Text(
                            "Downloaded. The server has removed its copy. Save the file somewhere safe: on this phone, a cloud drive or a USB drive.",
                            color = FS.colors.text,
                        )
                        Text(p.file.name, color = FS.colors.textMuted, style = captionStyle)
                        saveNote?.let { Text(it, color = FS.colors.success) }
                        saveError?.let { Text(it, color = FS.colors.danger) }
                        if (saveNote == null) {
                            FSPrimaryButton(
                                label = if (saving) "Saving…" else "Save the backup…",
                                onClick = { saver.launch(p.file.name) },
                                enabled = !saving,
                                block = true,
                                modifier = Modifier.testTag("backup-share"),
                            )
                        }
                    }
                    is ServerBackupViewModel.Phase.Failed -> {
                        Text(p.message, color = FS.colors.danger)
                        FSSecondaryButton(label = "Try again", onClick = { vm.tryAgain() }, block = true)
                    }
                }
                Text(ServerArchive.EXCLUDES_NOTE, color = FS.colors.textMuted, style = captionStyle)
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
            color = FS.colors.text,
            style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
        )
        Text(BackupsText.PASSCODE_WHY, color = FS.colors.text, style = bodySmStyle, modifier = Modifier.testTag("backup-passcode-why"))
        Text(ServerArchive.PASSCODE_NOTE, color = FS.colors.textMuted, style = bodySmStyle)
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
            vm.ownPasscodeHint?.let { Text(it, color = FS.colors.textMuted, style = captionStyle) }
            TextButton(onClick = { vm.useOwnPasscode = false }) { Text("Use the suggested passcode") }
        } else {
            FSCard(modifier = Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Text(
                        "SUGGESTED PASSCODE",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
                    )
                    SelectionContainer {
                        Text(
                            vm.suggestedPasscode,
                            color = FS.colors.text,
                            style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace),
                            modifier = Modifier.testTag("backup-suggested-passcode"),
                        )
                    }
                    TextButton(onClick = onCopy) { Text(if (copied) "Copied" else "Copy") }
                }
            }
            TextButton(onClick = { vm.useOwnPasscode = true }, modifier = Modifier.testTag("backup-use-own-passcode")) {
                Text("Use my own passcode instead")
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text("I've saved the passcode somewhere safe", color = FS.colors.text, style = bodySmStyle, modifier = Modifier.weight(1f))
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
    /** Restore from other servers (peer backup) instead of importing a file. */
    fromPeers: Boolean = false,
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
        val clientFor: suspend (String) -> ScreensClient? = { fqdn ->
            val pod = app.pods.value.firstOrNull { it.fqdn.equals(fqdn, ignoreCase = true) }
                ?: PodInfo(podId = PodInfo.podId(fqdn), name = fqdn.substringBefore('.'), fqdn = fqdn, status = PodInfo.Status.PENDING)
            podClients.screens(pod)
        }
        ImportBackupViewModel(
            peers = if (fromPeers) {
                com.flagshipserver.app.viewmodels.LivePeerRestoreSource(
                    pods = { app.pods.value },
                    clientFor = clientFor,
                    umkSeed = { Keystore.currentUmkSeed() },
                )
            } else null,
            username = app.currentUser.value ?: "you",
            takenNames = taken,
            waitingServers = waiting,
            targetFqdn = targetFqdn,
            clientFor = clientFor,
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
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) {
            scope.launch {
                val file = withContext(Dispatchers.IO) { SafPickedFile(context, uri) }
                vm.choose(file)
            }
        }
    }
    val pick: () -> Unit = pickFiles ?: {
        val gymFile = com.flagshipserver.app.core.Variant.gymImportBackupFile
        if (gymFile != null) {
            scope.launch { vm.choose(com.flagshipserver.app.viewmodels.LocalPickedFile(gymFile)) }
        } else {
            picker.launch(arrayOf("*/*"))
        }
    }
    val title = when (phase) {
        is ImportBackupViewModel.Phase.Waiting, is ImportBackupViewModel.Phase.Sending,
        is ImportBackupViewModel.Phase.Restoring, is ImportBackupViewModel.Phase.Done,
        is ImportBackupViewModel.Phase.Fetching,
        -> "Restore a backup"
        else -> if (vm.isPeerRestore) "Restore from other servers" else "Import a backup"
    }
    fun serverName(fqdn: String) = fqdn.substringBefore('.')

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(
            Modifier
                .widthIn(max = FSLayout.readingMaxWidth)
                .fillMaxWidth()
                .padding(horizontal = FS.space.s6, vertical = FS.space.s6)
                .testTag("import-backup"),
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
        ) {
            Text(title, color = FS.colors.text, style = TextStyle(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold))
            val summary = vm.summary
            when (val p = phase) {
                ImportBackupViewModel.Phase.Pick -> {
                    Text(
                        vm.targetFqdn?.let { "${serverName(it)} is waiting for its backup. Pick the backup file and this screen sends it." }
                            ?: ServerArchive.IMPORT_INTRO,
                        color = FS.colors.textMuted,
                    )
                    FSCard(modifier = Modifier.fillMaxWidth()) {
                        Text(vm.fileSummary, color = FS.colors.text, style = bodySmStyle, modifier = Modifier.testTag("import-backup-files"))
                    }
                    FSPrimaryButton(
                        label = if (vm.fileName == null) "Choose the backup file" else "Choose another file",
                        onClick = pick,
                        block = true,
                        modifier = Modifier.testTag("import-backup-choose"),
                    )
                    Text(
                        "It's read where it is; nothing is copied onto this phone.",
                        color = FS.colors.textMuted,
                        style = captionStyle,
                    )
                }
                ImportBackupViewModel.Phase.PickLost -> Column(
                    verticalArrangement = Arrangement.spacedBy(FS.space.s3),
                    modifier = Modifier.testTag("restore-peers-pick"),
                ) {
                    Text(com.flagshipserver.app.core.PeerBackup.RESTORE_INTRO, color = FS.colors.textMuted)
                    FSField(
                        value = vm.lost,
                        onValueChange = { vm.lost = it },
                        label = "The lost server",
                        placeholder = "home.you.flagship.services",
                        fieldTag = "restore-peers-lost",
                    )
                    vm.lostChoices.take(6).forEach { choice ->
                        FSSecondaryButton(
                            label = choice,
                            onClick = { vm.lost = choice },
                            block = true,
                            modifier = Modifier.testTag("restore-peers-choice-$choice"),
                        )
                    }
                    FSPrimaryButton(
                        label = "Find its backup",
                        onClick = { scope.launch { vm.findPeerBackup() } },
                        enabled = vm.lost.isNotBlank(),
                        block = true,
                        modifier = Modifier.testTag("restore-peers-find"),
                    )
                }
                ImportBackupViewModel.Phase.Finding -> Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                ) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Text("Looking for the backup…", color = FS.colors.text)
                }
                is ImportBackupViewModel.Phase.Fetching -> {
                    Text("${serverName(p.fqdn)} is getting the backup from other servers…", color = FS.colors.text, modifier = Modifier.testTag("restore-peers-fetching"))
                    val f = p.fraction
                    if (f == null) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    else LinearProgressIndicator(progress = { f.toFloat() }, modifier = Modifier.fillMaxWidth())
                    Text("Keep this screen open. If it stops, the server keeps waiting and shows on Home.", color = FS.colors.textMuted, style = captionStyle)
                }
                ImportBackupViewModel.Phase.Passcode -> {
                    Text("This backup was made on another account. Enter its passcode to open it.", color = FS.colors.text)
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
                    Text("Opening the backup…", color = FS.colors.text)
                }
                is ImportBackupViewModel.Phase.Checking -> {
                    summary?.let { Text(it, color = FS.colors.textMuted, style = bodySmStyle) }
                    Text("Checking the data file…", color = FS.colors.text)
                    LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
                }
                is ImportBackupViewModel.Phase.ChooseTarget -> {
                    summary?.let { Text(it, color = FS.colors.textMuted, style = bodySmStyle) }
                    Text("${serverName(p.fqdn)} is waiting for this backup.", color = FS.colors.text)
                    FSPrimaryButton(
                        label = "Send it to ${serverName(p.fqdn)}",
                        onClick = { vm.send(p.fqdn) },
                        block = true,
                        modifier = Modifier.testTag("import-backup-send-existing"),
                    )
                    FSSecondaryButton(label = "Create a new server instead", onClick = { vm.showName() }, block = true)
                }
                ImportBackupViewModel.Phase.Name -> {
                    summary?.let { Text(it, color = FS.colors.textMuted, style = bodySmStyle) }
                    FSField(
                        value = vm.name,
                        onValueChange = { vm.name = it },
                        label = "Name of the new server",
                        placeholder = "home",
                        error = vm.nameProblem,
                        fieldTag = "import-backup-name",
                    )
                    if (vm.nameProblem == null && vm.name.isNotEmpty()) {
                        Text(vm.previewFqdn, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, fontFamily = FontFamily.Monospace))
                    }
                    vm.settingsLine?.let { Text(it, color = FS.colors.textMuted, style = bodySmStyle) }
                    FSPrimaryButton(
                        label = "Create the server",
                        onClick = { vm.create() },
                        enabled = vm.canCreate,
                        block = true,
                        modifier = Modifier.testTag("import-backup-create"),
                    )
                    Text(
                        "Next you choose how to set it up (Flagship Studio, a recipe file, a USB stick), like any new server.",
                        color = FS.colors.textMuted,
                        style = captionStyle,
                    )
                }
                ImportBackupViewModel.Phase.Creating -> CircularProgressIndicator(Modifier.size(24.dp))
                is ImportBackupViewModel.Phase.Waiting -> Column(
                    verticalArrangement = Arrangement.spacedBy(FS.space.s3),
                    modifier = Modifier.testTag("import-backup-waiting"),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Text("Waiting for ${serverName(p.fqdn)} to come online…", color = FS.colors.text)
                    }
                    Text(
                        "Set it up with the recipe if you haven't yet. Keep this screen open: the backup goes as soon as the server is up. If you leave, ${serverName(p.fqdn)} keeps waiting and shows on Home with Send the backup.",
                        color = FS.colors.textMuted,
                        style = bodySmStyle,
                    )
                }
                is ImportBackupViewModel.Phase.Sending -> {
                    Text("Sending the backup to ${serverName(p.fqdn)}…", color = FS.colors.text)
                    LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
                    Text("Keep this screen open. If it stops, it picks up where it left off.", color = FS.colors.textMuted, style = captionStyle)
                }
                is ImportBackupViewModel.Phase.Restoring -> {
                    Text("Restoring the apps on ${serverName(p.fqdn)}…", color = FS.colors.text)
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    p.apps.forEach { Text(ImportBackupViewModel.describe(it), color = FS.colors.textMuted, style = captionStyle) }
                }
                is ImportBackupViewModel.Phase.Done -> {
                    Text(
                        "${serverName(p.fqdn)} is restored.",
                        color = FS.colors.success,
                        style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
                    )
                    ImportBackupViewModel.resultLines(p.apps).forEachIndexed { i, line ->
                        Text(
                            line,
                            color = if (i == 0) FS.colors.text else FS.colors.danger,
                            style = bodySmStyle,
                            modifier = Modifier.testTag(if (i == 0) "import-backup-restored" else "import-backup-failed-app"),
                        )
                    }
                    FSPrimaryButton(label = "Done", onClick = onClose, block = true, modifier = Modifier.testTag("import-backup-done"))
                }
                is ImportBackupViewModel.Phase.Failed -> {
                    Text(p.message, color = FS.colors.danger)
                    if (p.keepsWaiting) {
                        Text(
                            "The server keeps waiting for its backup. Pick the backup again from Home to send it, or delete the server there.",
                            color = FS.colors.textMuted,
                            style = bodySmStyle,
                        )
                    }
                    FSSecondaryButton(label = "Close", onClick = onClose, block = true)
                }
            }
            vm.fileError?.let { Text(it, color = FS.colors.danger, modifier = Modifier.testTag("import-backup-error")) }
            Spacer(Modifier.height(FS.space.s6))
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
                    color = FS.colors.textMuted,
                )
                Text(
                    vm.code,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 32.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 6.sp, fontFamily = FontFamily.Monospace),
                    modifier = Modifier.semantics { contentDescription = "backup-approve-code" },
                )
                Text(
                    "The backup opens only with its passcode or on your own devices, but anyone at that browser can save the files.",
                    color = FS.colors.textMuted,
                    style = captionStyle,
                )
                when (val p = phase) {
                    com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Approved ->
                        Text("Approved. The downloads start in that browser.", color = FS.colors.success)
                    is com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Failed ->
                        Text(p.message, color = FS.colors.danger)
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
