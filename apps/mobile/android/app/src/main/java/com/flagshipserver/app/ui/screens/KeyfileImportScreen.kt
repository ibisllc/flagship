// "Import backup file" — brings this device into an account using its
// `.flagshipkey` backup. Reached from the login/recovery flow (2 steps
// after "I already have an account", below any cloud option). Mirror of
// the iOS KeyfileImportSheet.
//
// Flow: pick a file (SAF) → enter passphrase → unwrap → install UMK →
// takeover re-pair → finish after the grace. On Opened we call
// onOpened(); the host completes onboarding paired.

package com.flagshipserver.app.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
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
            pickError = "Couldn't read that file. Try choosing it again."
        } else {
            pickedText = text
            pickError = null
            vm.reset()
        }
    }

    LaunchedEffect(phase) {
        (phase as? KeyfileImportPhase.Opened)?.let { onOpened() }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6)
            .semantics { contentDescription = "keyfile-import" },
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = onBack)
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "Import backup file",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s2))
        Text(
            "Bring this device into your account using its backup key file. You'll need the file and its passphrase.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
        Spacer(Modifier.height(FS.space.s4))

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
        Spacer(Modifier.height(FS.space.s8))
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
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Icon(Icons.Outlined.Info, contentDescription = null, tint = FS.colors.primary, modifier = Modifier.size(20.dp))
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    if (pickedText == null) "Choose your backup file" else "Backup file selected",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 14.sp),
                )
                Text(
                    if (pickedText == null) "Pick the .flagshipkey file you saved earlier."
                    else "Now enter the passphrase you set when you created it.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
                )
            }
        }
    }
    Spacer(Modifier.height(FS.space.s3))
    FSGhostButton(
        label = if (pickedText == null) "Choose file" else "Choose a different file",
        onClick = onChoose,
        block = true,
        modifier = Modifier.semantics { contentDescription = "keyfile-import-choose" },
    )

    if (pickedText != null) {
        Spacer(Modifier.height(FS.space.s3))
        FSField(
            value = passphrase,
            onValueChange = onPassphrase,
            label = "Passphrase",
            placeholder = "The passphrase for this file",
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.semantics { contentDescription = "keyfile-import-passphrase" },
        )
    }

    if (pickError != null) {
        Spacer(Modifier.height(FS.space.s2))
        Text(pickError, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp),
            modifier = Modifier.semantics { contentDescription = "keyfile-import-pick-error" })
    }
    if (failure != null) {
        Spacer(Modifier.height(FS.space.s2))
        Text(failure, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp),
            modifier = Modifier.semantics { contentDescription = "keyfile-import-error" })
    }

    Spacer(Modifier.height(FS.space.s4))
    FSPrimaryButton(
        label = "Import",
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
        modifier = Modifier.fillMaxSize().padding(vertical = FS.space.s8)
            .semantics { contentDescription = "keyfile-import-working" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Text("Unlocking your account key…", color = FS.colors.text,
            style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Medium))
        Text(
            "Decrypting the backup and bringing this device into your Flagship account.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp, lineHeight = 19.sp),
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
        Text("Bringing this device in", color = FS.colors.text,
            style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Medium))
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = FS.colors.primary, modifier = Modifier.size(20.dp))
                Text(
                    if (elapsed) "The grace period has elapsed — you can finish now."
                    else "This device takes over in ${formatRemaining(remaining)}. Your other devices are being alerted and can object until then.",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                )
            }
        }
        FSPrimaryButton(
            label = "Finish now",
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
        d > 0 -> "${d}d ${h}h"
        h > 0 -> "${h}h ${m}m"
        m > 0 -> "${m}m ${sec}s"
        else -> "${sec}s"
    }
}
