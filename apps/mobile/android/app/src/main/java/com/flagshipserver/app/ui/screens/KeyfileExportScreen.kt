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

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
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
            }
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

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6)
            .semantics { contentDescription = "keyfile-export" },
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "ACCOUNT BACKUP",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
        )
        Spacer(Modifier.height(FS.space.s4))

        // Danger callout.
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Icon(Icons.Filled.Warning, contentDescription = null, tint = FS.colors.danger, modifier = Modifier.size(20.dp))
                Text(
                    "Anyone with both this file and its passphrase can take over your account and lock you out.",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 13.sp, lineHeight = 19.sp),
                )
            }
        }
        Spacer(Modifier.height(FS.space.s3))

        // Passphrase.
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                FSField(
                    value = passphrase,
                    onValueChange = vm::setPassphrase,
                    label = "Passphrase",
                    helper = if (passphrase.isEmpty() || vm.passphraseStrong) "12 characters minimum" else null,
                    error = if (passphrase.isEmpty() || vm.passphraseStrong) null
                    else "12 characters minimum",
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.semantics { contentDescription = "keyfile-export-passphrase" },
                )
                FSField(
                    value = confirm,
                    onValueChange = vm::setConfirmPassphrase,
                    label = "Confirm Passphrase",
                    error = if (confirm.isEmpty() || vm.passphrasesMatch) null else "Passphrases don't match.",
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.semantics { contentDescription = "keyfile-export-confirm" },
                )
            }
        }
        Spacer(Modifier.height(FS.space.s3))

        // Acknowledgment.
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                AckCheckbox(
                    checked = ackControl,
                    onToggle = { vm.setAckControl(!ackControl) },
                    text = "I understand anyone with this file and passphrase controls my entire account.",
                    cd = "keyfile-export-ack-control",
                )
            }
        }
        Spacer(Modifier.height(FS.space.s4))

        (phase as? KeyfileExportPhase.Failed)?.let { f ->
            FSCard(padding = PaddingValues(FS.space.s3)) {
                Text(f.message, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
            }
            Spacer(Modifier.height(FS.space.s2))
        }

        FSPrimaryButton(
            label = if (working) "Creating…" else "Create backup file",
            onClick = { vm.createBackup() },
            enabled = vm.canCreate && !working,
            block = true,
            large = true,
            modifier = Modifier.semantics { contentDescription = "keyfile-export-create" },
        )

        if (saved) {
            Spacer(Modifier.height(FS.space.s3))
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = FS.colors.success, modifier = Modifier.size(20.dp))
                    Text(
                        "Backup saved. Keep it somewhere safe and offline.",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 13.sp),
                        modifier = Modifier.semantics { contentDescription = "keyfile-export-saved" },
                    )
                }
            }
            if (onSaved != null) {
                Spacer(Modifier.height(FS.space.s3))
                FSPrimaryButton(
                    label = "Continue into the app",
                    onClick = onSaved,
                    block = true,
                    large = true,
                    modifier = Modifier.semantics { contentDescription = "keyfile-export-continue" },
                )
            }
        }
        Spacer(Modifier.height(FS.space.s8))
    }
}

@Composable
private fun AckCheckbox(checked: Boolean, onToggle: () -> Unit, text: String, cd: String) {
    Row(
        modifier = Modifier
            .clickable { onToggle() }
            .semantics { contentDescription = cd },
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
    ) {
        Icon(
            if (checked) Icons.Filled.CheckBox else Icons.Filled.CheckBoxOutlineBlank,
            contentDescription = null,
            tint = if (checked) FS.colors.primary else FS.colors.textMuted,
            modifier = Modifier.size(22.dp),
        )
        Text(
            text,
            color = FS.colors.text,
            style = TextStyle(fontSize = 13.sp, lineHeight = 19.sp),
        )
    }
}
