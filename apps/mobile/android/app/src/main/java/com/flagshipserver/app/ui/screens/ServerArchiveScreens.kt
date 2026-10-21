// "Backup/clone server" (docs/server-backup-and-clone.md): the server page's
// backup dialog, and Home's Import a backup screen (which hands its create step
// to the create screen). MIRRORS the iOS ServerArchiveScreens.swift.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import com.flagshipserver.app.ui.components.fsFocusRing
import androidx.compose.foundation.selection.selectable
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
import com.flagshipserver.app.ui.components.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import com.flagshipserver.app.ui.components.Switch
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
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
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import com.flagshipserver.app.viewmodels.ImportBackupViewModel
import com.flagshipserver.app.viewmodels.PickedFile
import com.flagshipserver.app.viewmodels.ServerBackupViewModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.InputStream

private val captionStyle: TextStyle @Composable get() = MaterialTheme.typography.bodySmall
private val bodySmStyle: TextStyle @Composable get() = MaterialTheme.typography.bodyMedium

/** "Backup/clone server" button in the server page's Backup / Migrate card. */
@Composable
internal fun ServerBackupButton(serverDomain: String) {
    var show by remember { mutableStateOf(false) }
    FSSecondaryButton(
        label = stringResource(R.string.back_up_with_a_passcode),
        onClick = { show = true },
        block = true,
        enabled = !LocalServerReadOnly.current,
        modifier = Modifier.semantics { contentDescription = "sd-backup-server" },
    )
    if (show) ServerBackupDialog(serverDomain, onDismiss = { show = false })
}

/** The system "Save to" picker for one backup file, then the copy into it ([PendingBackupSave]). */
class BackupSaveLauncher internal constructor(private val file: () -> File?, private val onSaving: (Boolean) -> Unit, private val onResult: (Boolean) -> Unit) {
    fun launch(name: String) {
        val f = file() ?: return
        onSaving(true)
        com.flagshipserver.app.core.PendingBackupSave.start(f, name) { ok ->
            onSaving(false)
            onResult(ok)
        }
    }
}

@Composable
internal fun rememberSaveBackupLauncher(
    file: () -> File?,
    onSaving: (Boolean) -> Unit,
    onResult: (Boolean) -> Unit,
): BackupSaveLauncher = BackupSaveLauncher(file, onSaving, onResult)

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
            accountKek = { id -> Keystore.deriveServerArchiveKey(id, FSStrings.get(R.string.back_up, serverDomain)) },
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
                saveNote = FSStrings.get(R.string.saved)
                (phase as? ServerBackupViewModel.Phase.Saved)?.file?.delete()
            } else {
                saveError = FSStrings.get(R.string.couldnt_save_the_backup_there_pick)
            }
        },
    )
    LaunchedEffect(vm) { vm.load() }
    AlertDialog(
        // Closing never stops the server: reopening follows the same backup.
        onDismissRequest = { if (!saving) onDismiss() },
        title = { Text(stringResource(R.string.back_up_this_server)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                when (val p = phase) {
                    ServerBackupViewModel.Phase.Checking -> CircularProgressIndicator(Modifier.size(24.dp))
                    ServerBackupViewModel.Phase.Passcode -> PasscodeStep(
                        vm = vm,
                        copied = copied,
                        onCopy = {
                            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            cm.setPrimaryClip(ClipData.newPlainText(FSStrings.get(R.string.backup_passcode), vm.suggestedPasscode))
                            copied = true
                        },
                        onStart = { scope.launch { vm.start() } },
                    )
                    is ServerBackupViewModel.Phase.Building -> {
                        Text(p.label, color = FS.colors.text)
                        LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
                    }
                    is ServerBackupViewModel.Phase.Ready -> {
                        Text(fsString(R.string.backup_ready_one_file, ServerArchive.formatBytes(p.bytes)), color = FS.colors.text)
                        if (vm.leftOut.isNotEmpty()) {
                            Text(
                                fsString(R.string.left_out_no_source_to_rebuild, vm.leftOut.joinToString(", ")),
                                color = MaterialTheme.colorScheme.error,
                                style = captionStyle,
                            )
                        }
                        FSPrimaryButton(
                            label = stringResource(R.string.download_the_backup),
                            onClick = { scope.launch { vm.download() } },
                            block = true,
                            modifier = Modifier.testTag("backup-download"),
                        )
                    }
                    is ServerBackupViewModel.Phase.Downloading -> {
                        Text(stringResource(R.string.downloading), color = FS.colors.text)
                        LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
                    }
                    is ServerBackupViewModel.Phase.Saved -> {
                        Text(
                            stringResource(R.string.downloaded_the_server_has_removed_its),
                            color = FS.colors.text,
                        )
                        Text(p.file.name, color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle)
                        saveNote?.let { Text(it, color = FS.colors.success) }
                        saveError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                        if (saveNote == null) {
                            FSPrimaryButton(
                                label = if (saving) stringResource(R.string.saving) else stringResource(R.string.save_the_backup),
                                onClick = { saver.launch(p.file.name) },
                                enabled = !saving,
                                block = true,
                                modifier = Modifier.testTag("backup-share"),
                            )
                        }
                    }
                    is ServerBackupViewModel.Phase.Failed -> {
                        Text(p.message, color = MaterialTheme.colorScheme.error)
                        FSSecondaryButton(label = stringResource(R.string.try_again), onClick = { vm.tryAgain() }, block = true)
                    }
                }
                Text(ServerArchive.EXCLUDES_NOTE, color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle)
            }
        },
        confirmButton = { TextButton(onClick = onDismiss, enabled = !saving) { Text(stringResource(R.string.done)) } },
    )
}

@Composable
internal fun PasscodeStep(vm: ServerBackupViewModel, copied: Boolean, onCopy: () -> Unit, onStart: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        Text(
            stringResource(R.string.set_the_backups_passcode),
            color = FS.colors.text,
            style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        )
        Text(BackupsText.PASSCODE_WHY, color = FS.colors.text, style = bodySmStyle, modifier = Modifier.testTag("backup-passcode-why"))
        Text(ServerArchive.PASSCODE_NOTE, color = MaterialTheme.colorScheme.onSurfaceVariant, style = bodySmStyle)
        if (vm.useOwnPasscode) {
            FSField(
                value = vm.ownPasscode,
                onValueChange = { vm.ownPasscode = it },
                label = stringResource(R.string.your_passcode),
                visualTransformation = PasswordVisualTransformation(),
                fieldTag = "backup-own-passcode",
            )
            FSField(
                value = vm.ownPasscodeAgain,
                onValueChange = { vm.ownPasscodeAgain = it },
                label = stringResource(R.string.type_it_again),
                visualTransformation = PasswordVisualTransformation(),
                fieldTag = "backup-own-passcode-again",
            )
            vm.ownPasscodeHint?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle) }
            TextButton(onClick = { vm.useOwnPasscode = false }) { Text(stringResource(R.string.use_the_suggested_passcode)) }
        } else {
            FSCard(modifier = Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Text(
                        stringResource(R.string.suggested_passcode),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
                    )
                    SelectionContainer {
                        Text(
                            vm.suggestedPasscode,
                            color = FS.colors.text,
                            style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace),
                            modifier = Modifier.testTag("backup-suggested-passcode"),
                        )
                    }
                    TextButton(onClick = onCopy) { Text(if (copied) stringResource(R.string.copied_2) else stringResource(R.string.copy)) }
                }
            }
            TextButton(onClick = { vm.useOwnPasscode = true }, modifier = Modifier.testTag("backup-use-own-passcode")) {
                Text(stringResource(R.string.use_my_own_passcode_instead))
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.ive_saved_the_passcode_somewhere_safe), color = FS.colors.text, style = bodySmStyle, modifier = Modifier.weight(1f))
            Switch(
                checked = vm.passcodeSaved,
                onCheckedChange = { vm.passcodeSaved = it },
                modifier = Modifier.testTag("backup-passcode-saved"),
            )
        }
        FSPrimaryButton(
            label = stringResource(R.string.make_the_backup),
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
        context.contentResolver.openInputStream(uri) ?: throw java.io.IOException(FSStrings.get(R.string.cant_open, name))

    override fun release() {
        runCatching { context.contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }
}

/** Home → Add/Restore server → Restore from backup (or a waiting server's "Send
 *  the backup"): builds the view model from the account's servers and hands
 *  the create step to the existing create screen. */
@Composable
internal fun ImportBackupRoute(
    targetFqdn: String?,
    /** Restore from other servers (peer backup) instead of importing a file. */
    fromPeers: Boolean = false,
    /** A copy this phone kept (the phone backup policy): opened at once, no file picking. */
    phoneCopyPath: String? = null,
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
            accountKek = { id -> Keystore.deriveServerArchiveKey(id, FSStrings.get(R.string.open_the_backup)) },
            onRestored = { fqdn -> app.clearAwaitingBackup(fqdn) },
        )
    }
    DisposableEffect(vm) { onDispose { vm.stop() } }
    androidx.compose.runtime.LaunchedEffect(vm, phoneCopyPath) {
        if (phoneCopyPath != null) vm.choose(com.flagshipserver.app.viewmodels.LocalPickedFile(java.io.File(phoneCopyPath)))
    }
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
        -> stringResource(R.string.restore_a_backup)
        else -> if (vm.isPeerRestore) stringResource(R.string.restore_from_other_servers) else stringResource(R.string.import_a_backup)
    }
    fun serverName(fqdn: String) = fqdn.substringBefore('.')

    androidx.activity.compose.BackHandler(enabled = phase == ImportBackupViewModel.Phase.Passcode) { vm.backFromPasscode() }
    FSScreen(title = title, onBack = onClose, modifier = Modifier.testTag("import-backup")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            val summary = vm.summary
            when (val p = phase) {
                ImportBackupViewModel.Phase.Pick -> {
                    Text(
                        vm.targetFqdn?.let { fsString(R.string.is_waiting_for_its_backup_pick, serverName(it)) }
                            ?: ServerArchive.IMPORT_INTRO,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    FSCard(modifier = Modifier.fillMaxWidth()) {
                        Text(vm.fileSummary, color = FS.colors.text, style = bodySmStyle, modifier = Modifier.testTag("import-backup-files"))
                    }
                    FSPrimaryButton(
                        label = if (vm.fileName == null) stringResource(R.string.choose_the_backup_file) else stringResource(R.string.choose_another_file),
                        onClick = pick,
                        block = true,
                        modifier = Modifier.testTag("import-backup-choose"),
                    )
                    Text(
                        stringResource(R.string.its_read_where_it_is_nothing),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = captionStyle,
                    )
                }
                ImportBackupViewModel.Phase.PickLost -> Column(
                    verticalArrangement = Arrangement.spacedBy(FS.space.s3),
                    modifier = Modifier.testTag("restore-peers-pick"),
                ) {
                    Text(com.flagshipserver.app.core.PeerBackup.RESTORE_INTRO, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    FSField(
                        value = vm.lost,
                        onValueChange = { vm.lost = it },
                        label = stringResource(R.string.the_lost_server),
                        placeholder = "home.you.flagship.services",
                        fieldTag = "restore-peers-lost",
                    )
                    if (vm.lostChoices.isNotEmpty()) {
                        com.flagshipserver.app.ui.components.FSGroup {
                            vm.lostChoices.take(6).forEachIndexed { i, choice ->
                                if (i > 0) com.flagshipserver.app.ui.components.FSDivider(inset = FS.space.s4)
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .testTag("restore-peers-choice-$choice")
                                        .fsFocusRing(8.dp).selectable(selected = vm.lost == choice, role = androidx.compose.ui.semantics.Role.RadioButton) { vm.lost = choice }
                                        .padding(horizontal = FS.space.s2, vertical = FS.space.s1),
                                ) {
                                    androidx.compose.material3.RadioButton(selected = vm.lost == choice, onClick = null, modifier = Modifier.padding(FS.space.s2))
                                    Text(choice, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = FS.space.s2))
                                }
                            }
                        }
                    }
                    FSPrimaryButton(
                        label = stringResource(R.string.find_its_backup),
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
                    Text(stringResource(R.string.looking_for_the_backup), color = FS.colors.text)
                }
                is ImportBackupViewModel.Phase.Fetching -> {
                    Text(fsString(R.string.is_getting_the_backup_from_other, serverName(p.fqdn)), color = FS.colors.text, modifier = Modifier.testTag("restore-peers-fetching"))
                    val f = p.fraction
                    if (f == null) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    else LinearProgressIndicator(progress = { f.toFloat() }, modifier = Modifier.fillMaxWidth())
                    Text(stringResource(R.string.keep_this_screen_open_if_it), color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle)
                }
                ImportBackupViewModel.Phase.Passcode -> {
                    Text(stringResource(R.string.this_backup_was_made_on_another), color = FS.colors.text)
                    FSField(
                        value = vm.passcode,
                        onValueChange = { vm.passcode = it },
                        label = stringResource(R.string.passcode),
                        visualTransformation = PasswordVisualTransformation(),
                        fieldTag = "import-backup-passcode",
                    )
                    FSPrimaryButton(
                        label = stringResource(R.string.open_the_backup),
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
                    Text(stringResource(R.string.opening_the_backup), color = FS.colors.text)
                }
                is ImportBackupViewModel.Phase.Checking -> {
                    summary?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = bodySmStyle) }
                    Text(stringResource(R.string.checking_the_data_file), color = FS.colors.text)
                    LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
                }
                is ImportBackupViewModel.Phase.ChooseTarget -> {
                    summary?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = bodySmStyle) }
                    Text(fsString(R.string.is_waiting_for_this_backup, serverName(p.fqdn)), color = FS.colors.text)
                    FSPrimaryButton(
                        label = fsString(R.string.send_it_to, serverName(p.fqdn)),
                        onClick = { vm.send(p.fqdn) },
                        block = true,
                        modifier = Modifier.testTag("import-backup-send-existing"),
                    )
                    FSSecondaryButton(label = stringResource(R.string.create_a_new_server_instead), onClick = { vm.showName() }, block = true)
                }
                ImportBackupViewModel.Phase.Name -> {
                    summary?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = bodySmStyle) }
                    FSField(
                        value = vm.name,
                        onValueChange = { vm.name = it },
                        label = stringResource(R.string.name_of_the_new_server),
                        placeholder = "home",
                        error = vm.nameProblem,
                        fieldTag = "import-backup-name",
                    )
                    if (vm.nameProblem == null && vm.name.isNotEmpty()) {
                        Text(vm.previewFqdn, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
                    }
                    vm.settingsLine?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = bodySmStyle) }
                    FSPrimaryButton(
                        label = stringResource(R.string.create_the_server),
                        onClick = { vm.create() },
                        enabled = vm.canCreate,
                        block = true,
                        modifier = Modifier.testTag("import-backup-create"),
                    )
                    Text(
                        stringResource(R.string.next_you_choose_how_to_set),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
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
                        Text(fsString(R.string.waiting_for_to_come_online, serverName(p.fqdn)), color = FS.colors.text)
                    }
                    Text(
                        fsString(R.string.set_it_up_with_the_recipe, serverName(p.fqdn)),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = bodySmStyle,
                    )
                }
                is ImportBackupViewModel.Phase.Sending -> {
                    Text(fsString(R.string.sending_the_backup_to, serverName(p.fqdn)), color = FS.colors.text)
                    LinearProgressIndicator(progress = { p.fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
                    Text(stringResource(R.string.keep_this_screen_open_if_it_2), color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle)
                }
                is ImportBackupViewModel.Phase.Restoring -> {
                    Text(fsString(R.string.restoring_the_apps_on, serverName(p.fqdn)), color = FS.colors.text)
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    p.apps.forEach { Text(ImportBackupViewModel.describe(it), color = MaterialTheme.colorScheme.onSurfaceVariant, style = captionStyle) }
                }
                is ImportBackupViewModel.Phase.Done -> {
                    Text(
                        fsString(R.string.is_restored, serverName(p.fqdn)),
                        color = FS.colors.success,
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                    )
                    ImportBackupViewModel.resultLines(p.apps).forEachIndexed { i, line ->
                        Text(
                            line,
                            color = if (i == 0) FS.colors.text else MaterialTheme.colorScheme.error,
                            style = bodySmStyle,
                            modifier = Modifier.testTag(if (i == 0) "import-backup-restored" else "import-backup-failed-app"),
                        )
                    }
                    FSPrimaryButton(label = stringResource(R.string.done), onClick = onClose, block = true, modifier = Modifier.testTag("import-backup-done"))
                }
                is ImportBackupViewModel.Phase.Failed -> {
                    Text(p.message, color = MaterialTheme.colorScheme.error)
                    if (p.keepsWaiting) {
                        Text(
                            stringResource(R.string.the_server_keeps_waiting_for_its),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = bodySmStyle,
                        )
                    }
                    FSSecondaryButton(label = stringResource(R.string.close), onClick = onClose, block = true)
                }
            }
            vm.fileError?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("import-backup-error")) }
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
            sign = { bytes -> Keystore.adminSigningKey(FSStrings.get(R.string.approve_downloading_the_backup_of, serverFqdn)).sign(bytes) },
        )
    }
    val phase by vm.phase.collectAsState()
    AlertDialog(
        onDismissRequest = { if (phase != com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Working) onDismiss() },
        title = { Text(stringResource(R.string.download_a_backup_in_a_browser)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    fsString(R.string.a_browser_is_asking_to_download, serverFqdn),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    vm.code,
                    color = FS.colors.text,
                    style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 6.sp, fontFamily = FontFamily.Monospace),
                    modifier = Modifier.semantics { contentDescription = "backup-approve-code" },
                )
                Text(
                    stringResource(R.string.the_backup_opens_only_with_its),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = captionStyle,
                )
                when (val p = phase) {
                    com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Approved ->
                        Text(stringResource(R.string.approved_the_downloads_start_in_that), color = FS.colors.success)
                    is com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Failed ->
                        Text(p.message, color = MaterialTheme.colorScheme.error)
                    else -> {}
                }
            }
        },
        confirmButton = {
            if (phase == com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Approved) {
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.done)) }
            } else {
                TextButton(
                    onClick = { scope.launch { vm.approve() } },
                    enabled = phase != com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Working,
                    modifier = Modifier.semantics { contentDescription = "backup-approve" },
                ) { Text(if (phase == com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Working) stringResource(R.string.approving) else stringResource(R.string.approve)) }
            }
        },
        dismissButton = {
            if (phase != com.flagshipserver.app.viewmodels.BackupDownloadApprovalViewModel.Phase.Approved) {
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.dont_approve)) }
            }
        },
    )
}
