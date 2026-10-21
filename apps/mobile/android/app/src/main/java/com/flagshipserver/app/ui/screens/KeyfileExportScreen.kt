// "Back up your account key" — exports the UMK into a passphrase-
// encrypted `.flagshipkey` file. Reached from Settings → Recovery.
// Mirror of the iOS KeyfileExportScreen.
//
// Copy is approved + verbatim. The "Create backup file" CTA enables only
// when a strong passphrase is set + confirmed AND all three
// acknowledgments are checked. On success the file is saved via the
// Storage Access Framework (CreateDocument) as `<username>.flagshipkey`;
// we never write it ourselves.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Verified
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.KeyfileExportPhase
import com.flagshipserver.app.viewmodels.KeyfileExportViewModel

@Composable
fun KeyfileExportScreen(
    nav: NavController,
    // Onboarding seam — when set, a "Continue into the app" CTA appears
    // after the file is saved so the create-flow can proceed. Default is
    // a no-op so the Settings call site is unchanged.
    onSaved: (() -> Unit)? = null,
) {
    val app = LocalAppState.current
    val username = app.currentUser.collectAsState().value ?: ""
    val vm = remember(username) { KeyfileExportViewModel(username = username) }

    val phase by vm.phase.collectAsState()
    val passphrase by vm.passphrase.collectAsState()
    val confirm by vm.confirmPassphrase.collectAsState()
    val ackControl by vm.ackControl.collectAsState()

    // SAF "create document" — hands back a content:// uri we write the
    // keyfile text into. We never persist the file ourselves.
    var pendingText by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf(false) }
    val ctx = LocalContext.current
    val createDoc = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream"),
    ) { uri ->
        val text = pendingText
        if (uri != null && text != null) {
            runCatching {
                ctx.contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
            }.onSuccess { com.flagshipserver.app.core.KeyBackupStore.markWritten(ctx, username) }
            saved = true
        }
        pendingText = null
        vm.reset()
    }

    // When the wrap finishes, kick off the SAF save dialog.
    LaunchedEffect(phase) {
        (phase as? KeyfileExportPhase.Ready)?.let { ready ->
            pendingText = ready.text
            saved = false
            createDoc.launch(vm.suggestedFilename)
        }
    }

    val working = phase is KeyfileExportPhase.Working
    // Derived here from the collected values: the card lambdas read them in
    // their own scopes, so reading vm.canCreate (plain StateFlow.value) left
    // this scope stale and the button stuck disabled (device bug M14).
    val canCreate = KeyfileExportViewModel.isStrong(passphrase) &&
        confirm.isNotEmpty() && passphrase == confirm && ackControl
    LaunchedEffect(passphrase, confirm, ackControl) {
        com.flagshipserver.app.core.ErrorLog.step(
            "key-backup",
            "inputs len=${passphrase.length}/${confirm.length} strong=${KeyfileExportViewModel.isStrong(passphrase)} match=${passphrase == confirm} ack=$ackControl",
        )
    }

    FSScreen(
        title = stringResource(R.string.account_backup),
        onBack = { nav.popBackStack() },
        modifier = Modifier.semantics { contentDescription = "keyfile-export" },
    ) {
        // Danger callout.
        FSCard {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = FS.colors.danger, modifier = Modifier.size(24.dp))
                Text(
                    stringResource(R.string.anyone_with_both_this_file_and),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }

        // Passphrase.
        FSCard {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                FSField(
                    value = passphrase,
                    onValueChange = vm::setPassphrase,
                    label = stringResource(R.string.passphrase),
                    helper = if (passphrase.isEmpty() || vm.passphraseStrong) KeyfileExportViewModel.RULE else null,
                    error = if (passphrase.isEmpty() || vm.passphraseStrong) null
                    else KeyfileExportViewModel.RULE_ERROR,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.semantics { contentDescription = "keyfile-export-passphrase" },
                )
                FSField(
                    value = confirm,
                    onValueChange = vm::setConfirmPassphrase,
                    label = stringResource(R.string.confirm_passphrase),
                    error = if (confirm.isEmpty() || vm.passphrasesMatch) null else stringResource(R.string.passphrases_dont_match),
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.semantics { contentDescription = "keyfile-export-confirm" },
                )
            }
        }

        // Acknowledgment.
        FSCard(padding = PaddingValues(vertical = FS.space.s2, horizontal = FS.space.s2)) {
            AckCheckbox(
                checked = ackControl,
                onToggle = { vm.setAckControl(!ackControl) },
                text = stringResource(R.string.i_understand_anyone_with_this_file),
                cd = "keyfile-export-ack-control",
            )
        }

        (phase as? KeyfileExportPhase.Failed)?.let { f ->
            ErrorCard(f.message)
        }

        FSPrimaryButton(
            label = if (working) stringResource(R.string.creating) else stringResource(R.string.create_backup_file),
            onClick = { vm.createBackup() },
            enabled = canCreate && !working,
            block = true,
            large = true,
            modifier = Modifier.semantics { contentDescription = "keyfile-export-create" },
        )

        if (saved) {
            FSCard {
                Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    Icon(Icons.Outlined.Verified, contentDescription = null, tint = FS.colors.success, modifier = Modifier.size(24.dp))
                    Text(
                        stringResource(R.string.backup_saved_keep_it_somewhere_safe),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.semantics { contentDescription = "keyfile-export-saved" },
                    )
                }
            }
            if (onSaved != null) {
                FSPrimaryButton(
                    label = stringResource(R.string.continue_into_the_app),
                    onClick = onSaved,
                    block = true,
                    large = true,
                    modifier = Modifier.semantics { contentDescription = "keyfile-export-continue" },
                )
            }
        }
    }
}

@Composable
private fun AckCheckbox(checked: Boolean, onToggle: () -> Unit, text: String, cd: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .toggleable(value = checked, role = Role.Checkbox, onValueChange = { onToggle() })
            .semantics { contentDescription = cd }
            .padding(end = FS.space.s2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = checked, onCheckedChange = null, modifier = Modifier.padding(FS.space.s3))
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
    }
}
