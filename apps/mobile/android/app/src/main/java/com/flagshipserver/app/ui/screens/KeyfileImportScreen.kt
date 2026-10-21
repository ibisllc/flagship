// "Import backup file" — brings this device into an account using its
// `.flagshipkey` backup. Reached from the login/recovery flow (2 steps
// on "Connect to an existing account", below any cloud option). Mirror of
// the iOS KeyfileImportSheet.
//
// Flow: pick a file (SAF) → enter passphrase → unwrap → install UMK →
// takeover re-pair → finish after the grace. On Opened we call
// onOpened(); the host completes onboarding paired.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.NoteAdd
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.KeyfileImportPhase
import com.flagshipserver.app.viewmodels.KeyfileImportViewModel
import kotlinx.coroutines.launch

@Composable
fun KeyfileImportScreen(
    onOpened: () -> Unit,
    onBack: () -> Unit,
) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val vm = remember { KeyfileImportViewModel(server = server, app = app) }
    val phase by vm.phase.collectAsState()
    val passphrase by vm.passphrase.collectAsState()

    var pickedText by remember { mutableStateOf<String?>(null) }
    var pickError by remember { mutableStateOf<String?>(null) }

    val openDoc = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val text = runCatching {
            ctx.contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) }
        }.getOrNull()
        if (text == null) {
            pickError = FSStrings.get(R.string.couldnt_read_that_file_try_choosing)
        } else {
            pickedText = text
            pickError = null
            vm.reset()
        }
    }

    LaunchedEffect(phase) {
        (phase as? KeyfileImportPhase.Opened)?.let { onOpened() }
    }

    FSScreen(
        title = stringResource(R.string.import_backup_file),
        onBack = onBack,
        subtitle = stringResource(R.string.bring_this_device_into_your_account),
        modifier = Modifier.semantics { contentDescription = "keyfile-import" },
    ) {
        when (val p = phase) {
            KeyfileImportPhase.Working ->
                WorkingView()
            is KeyfileImportPhase.Opened ->
                WorkingView()
            is KeyfileImportPhase.Grace ->
                GraceView(
                    completesAt = p.completesAt,
                    onFinish = { scope.launch { vm.completeImport() } },
                )
            else -> ChooseAndUnlock(
                pickedText = pickedText,
                passphrase = passphrase,
                onPassphrase = vm::setPassphrase,
                onChoose = {
                    pickError = null
                    // Accept the .flagshipkey extension plus generic
                    // JSON / octet-stream so a file saved with another
                    // mime can still be picked.
                    openDoc.launch(arrayOf("application/octet-stream", "application/json", "text/plain", "*/*"))
                },
                pickError = pickError,
                failure = (p as? KeyfileImportPhase.Failed)?.message,
                canImport = pickedText != null && vm.canImport,
                onImport = { pickedText?.let { t -> scope.launch { vm.importBackup(t) } } },
            )
        }
    }
}

@Composable
private fun ChooseAndUnlock(
    pickedText: String?,
    passphrase: String,
    onPassphrase: (String) -> Unit,
    onChoose: () -> Unit,
    pickError: String?,
    failure: String?,
    canImport: Boolean,
    onImport: () -> Unit,
) {
    FSCard {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Icon(
                if (pickedText == null) Icons.AutoMirrored.Outlined.NoteAdd else Icons.Outlined.TaskAlt,
                contentDescription = null,
                tint = if (pickedText == null) MaterialTheme.colorScheme.primary else FS.colors.success,
                modifier = Modifier.size(24.dp),
            )
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    if (pickedText == null) stringResource(R.string.choose_your_backup_file) else stringResource(R.string.backup_file_selected),
                    style = MaterialTheme.typography.titleSmall,
                )
                Text(
                    if (pickedText == null) stringResource(R.string.pick_the_flagshipkey_file_you_saved)
                    else stringResource(R.string.now_enter_the_passphrase_you_set),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
    FSSecondaryButton(
        label = if (pickedText == null) stringResource(R.string.choose_file) else stringResource(R.string.choose_a_different_file),
        onClick = onChoose,
        block = true,
        modifier = Modifier.semantics { contentDescription = "keyfile-import-choose" },
    )

    if (pickedText != null) {
        FSField(
            value = passphrase,
            onValueChange = onPassphrase,
            label = stringResource(R.string.passphrase),
            placeholder = stringResource(R.string.the_passphrase_for_this_file),
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.semantics { contentDescription = "keyfile-import-passphrase" },
        )
    }

    if (pickError != null) {
        Text(pickError, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.semantics { contentDescription = "keyfile-import-pick-error" })
    }
    if (failure != null) {
        Text(failure, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.semantics { contentDescription = "keyfile-import-error" })
    }

    FSPrimaryButton(
        label = stringResource(R.string.import_label),
        onClick = onImport,
        enabled = canImport,
        block = true,
        large = true,
        modifier = Modifier.semantics { contentDescription = "keyfile-import-continue" },
    )
}

@Composable
private fun WorkingView() {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = FS.space.s8)
            .semantics { contentDescription = "keyfile-import-working" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Text(stringResource(R.string.unlocking_your_account_key), style = MaterialTheme.typography.titleMedium)
        Text(
            stringResource(R.string.decrypting_the_backup_and_bringing_this),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun GraceView(completesAt: Long, onFinish: () -> Unit) {
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(completesAt) {
        while (true) {
            nowMs = System.currentTimeMillis()
            kotlinx.coroutines.delay(1000)
        }
    }
    val remaining = (completesAt - nowMs).coerceAtLeast(0L)
    val elapsed = remaining == 0L
    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s4),
        modifier = Modifier.semantics { contentDescription = "keyfile-import-grace" }) {
        Text(stringResource(R.string.bringing_this_device_in), style = MaterialTheme.typography.titleLarge)
        FSCard {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Icon(Icons.Outlined.Schedule, contentDescription = null, tint = FS.colors.accent, modifier = Modifier.size(24.dp))
                Text(
                    if (elapsed) stringResource(R.string.the_grace_period_has_elapsed_you_2)
                    else fsString(R.string.this_device_takes_over_in_your_2, formatRemaining(remaining)),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
        FSPrimaryButton(
            label = stringResource(R.string.finish_now),
            onClick = onFinish,
            enabled = elapsed,
            block = true,
            large = true,
            modifier = Modifier.semantics { contentDescription = "keyfile-import-finish" },
        )
    }
}

private fun formatRemaining(ms: Long): String {
    val s = ms / 1000
    val d = s / 86400; val h = (s % 86400) / 3600; val m = (s % 3600) / 60; val sec = s % 60
    return when {
        d > 0 -> FSStrings.get(R.string.d_h, d, h)
        h > 0 -> FSStrings.get(R.string.h_m, h, m)
        m > 0 -> FSStrings.get(R.string.m_s, m, sec)
        else -> "${sec}s"
    }
}
