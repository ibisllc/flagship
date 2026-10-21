// Phase 3 (login redesign) — the REAL single/multi login UI.
//
// Hosts the LoginViewModel state machine for a resolved real account
// (kind == single | multi). Replaces the legacy RecoverFromWelcome
// container hand-off for these branches — the win is every absent
// factor renders a STATE, not an error card, and the takeover actually
// installs the recovered UMK + initiates re-pair + labels this device
// the account with the RESOLVED username (no "recovered-user" placeholder).
//
// Phase 4 adds the grace countdown / completion polling / push /
// quarantine.
//
// The production call site injects the REAL CredentialManager-backed
// provider (same one Recovery + Secure-account use) so credentialed
// takeover login is actually credentialed — the passkey-PRF unwrap must
// assert against the user's real cloud-recovery credential, not a Mock.
// The Mock stays the injectable default for previews + unit tests.
//
// Mirror of the iOS Phase 3 login screens.

package com.flagshipserver.app.ui.onboarding

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.app.Activity
import androidx.compose.ui.platform.LocalContext
import com.flagshipserver.app.api.AccountResolution
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.keystore.CloudRecoveryEnrollment
import com.flagshipserver.app.keystore.PasskeyRecoveryManager
import com.flagshipserver.app.keystore.PlatformWebAuthnProvider
import com.flagshipserver.app.keystore.WebAuthnProvider
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.screens.KeyfileImportScreen
import com.flagshipserver.app.ui.theme.FS
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.outlined.Lock
import com.flagshipserver.app.viewmodels.LoginPhase
import com.flagshipserver.app.viewmodels.LoginViewModel
import kotlinx.coroutines.launch

@Composable
fun RealAccountLoginContainer(
    resolution: AccountResolution,
    onOpened: () -> Unit,
    onBack: () -> Unit,
    /** Real CredentialManager-backed provider by default (built below from
     *  the local context). Injectable so tests + previews can pin the Mock;
     *  null → use the real production provider. */
    webauthn: WebAuthnProvider? = null,
) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    // Credentialed takeover must assert against the user's REAL cloud-
    // recovery passkey — a Mock would make "credentialed" login meaningless.
    val passkeys = remember(ctx) { PasskeyRecoveryManager(ctx.applicationContext) }
    val provider = webauthn ?: remember(ctx) {
        PlatformWebAuthnProvider(
            activity = { ctx as? Activity },
            username = { app.currentUser.value },
            manager = passkeys,
        )
    }
    val vm = remember(resolution) {
        LoginViewModel(resolution = resolution, server = server, app = app, webauthn = provider)
    }
    val phase by vm.phase.collectAsState()

    // "Import backup file" — offered below the cloud option on the
    // recovery screen (mirrors iOS RealAccountLoginScreen.importBackupOption).
    var showImport by remember { mutableStateOf(false) }

    LaunchedEffect(vm) { vm.begin() }
    LaunchedEffect(phase) { if (phase == LoginPhase.Opened) onOpened() }

    if (showImport) {
        KeyfileImportScreen(
            onOpened = onOpened,
            onBack = { showImport = false },
        )
        return
    }

    when (val p = phase) {
        LoginPhase.Idle, LoginPhase.Recovering -> RecoveringView(onCancel = onBack)
        is LoginPhase.NoCloudBackup -> NoCloudBackupView(
            single = p.single,
            onImport = { showImport = true },
            onBack = onBack,
        )
        is LoginPhase.AwaitingPassphrase -> PassphraseView(
            onSubmit = { pp -> scope.launch { vm.submitPassphrase(pp) } },
            onImport = { showImport = true },
            onBack = onBack,
        )
        LoginPhase.AwaitingSecondFactor -> SecondFactorView(
            onSubmit = { code, isRecovery -> vm.submitSecondFactor(code, isRecovery) },
            onBack = onBack,
        )
        is LoginPhase.TakeoverReady -> TakeoverExplainerView(
            graceModel = p.graceModel,
            username = vm.username,
            onConfirm = { scope.launch { vm.confirmTakeover() } },
            onImport = { showImport = true },
            onBack = onBack,
        )
        is LoginPhase.Grace -> GraceCountdownView(
            completesAt = p.completesAt,
            onTakeOver = { scope.launch { vm.completeTakeover() } },
            onBack = onBack,
        )
        LoginPhase.TakingOver -> TakingOverView()
        LoginPhase.Opened -> TakingOverView()  // brief; LaunchedEffect navigates away
        is LoginPhase.Failed -> FailureView(message = p.message, onBack = onBack)
    }
}

@Composable
private fun RecoveringView(onCancel: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(FS.space.s6)
            .semantics { contentDescription = "login-recovering" },
        verticalArrangement = Arrangement.SpaceBetween,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(FS.space.s12))
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(FS.space.s4)) {
            CircularProgressIndicator()
            Text(
                stringResource(R.string.authenticate_with_your_passkey),
                color = FS.colors.text,
                style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Medium),
            )
            Text(
                stringResource(R.string.well_unwrap_your_account_key_and),
                color = FS.colors.textMuted,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = FS.space.s8),
            )
        }
        FSGhostButton(label = stringResource(R.string.cancel), onClick = onCancel, block = true)
    }
}

@Composable
private fun NoCloudBackupView(single: Boolean, onImport: () -> Unit, onBack: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize()
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12)
            .semantics { contentDescription = "login-no-cloud-backup" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            stringResource(R.string.no_cloud_backup_on_this_account),
            color = FS.colors.text,
            style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Medium),
        )
        // The single/multi-with-no-working-device dead end is a node in
        // the decision tree, NOT a 404. Copy verbatim from
        // docs/login-and-account-redesign.md.
        Text(
            if (single) stringResource(R.string.use_a_device_that_still_has)
            else stringResource(R.string.use_another_device_or_one_of),
            color = FS.colors.textMuted,
            style = MaterialTheme.typography.bodyLarge,
        )
        ImportBackupOption(onImport = onImport)
        Box(Modifier.height(FS.space.s4))
        FSPrimaryButton(label = stringResource(R.string.back), onClick = onBack, block = true, large = true)
    }
}

/** "Import backup file" — the keyfile-import entry, offered below the
 *  cloud option on the recovery screen. Mirror of the iOS
 *  RealAccountLoginScreen.importBackupOption. */
@Composable
private fun ImportBackupOption(onImport: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Row(
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
            modifier = Modifier
                .clickable { onImport() }
                .semantics { contentDescription = "login-import-backup" },
        ) {
            Icon(Icons.Outlined.Lock, contentDescription = null, tint = FS.colors.accent, modifier = Modifier.size(20.dp))
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.import_backup_file), color = FS.colors.text, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable
private fun PassphraseView(
    onSubmit: (String) -> Unit,
    onImport: () -> Unit,
    onBack: () -> Unit,
) {
    var passphrase by remember { mutableStateOf("") }
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12)
            .semantics { contentDescription = "login-passphrase" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            stringResource(R.string.enter_your_recovery_passphrase),
            color = FS.colors.text,
            style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Medium),
        )
        Text(
            stringResource(R.string.this_is_the_passphrase_you_chose),
            color = FS.colors.textMuted,
            style = MaterialTheme.typography.bodyLarge,
        )
        FSField(
            value = passphrase,
            onValueChange = { passphrase = it },
            label = stringResource(R.string.recovery_passphrase),
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.semantics { contentDescription = "login-passphrase-field" },
        )
        Spacer(Modifier.height(FS.space.s2))
        FSPrimaryButton(
            label = stringResource(R.string.continue_label),
            onClick = { onSubmit(passphrase) },
            enabled = passphrase.length >= CloudRecoveryEnrollment.MIN_PASSPHRASE,
            block = true,
            large = true,
            modifier = Modifier.semantics { contentDescription = "login-passphrase-continue" },
        )
        ImportBackupOption(onImport = onImport)
        FSGhostButton(label = stringResource(R.string.back), onClick = onBack, block = true)
    }
}

@Composable
private fun SecondFactorView(
    onSubmit: (String, Boolean) -> Unit,
    onBack: () -> Unit,
) {
    var code by remember { mutableStateOf("") }
    var useRecoveryCode by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12)
            .semantics { contentDescription = "login-second-factor" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            stringResource(R.string.enter_your_recovery_code),
            color = FS.colors.text,
            style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Medium),
        )
        Text(
            stringResource(R.string.this_account_is_protected_by_a),
            color = FS.colors.textMuted,
            style = MaterialTheme.typography.bodyLarge,
        )
        FSField(
            value = code,
            onValueChange = { code = it },
            label = if (useRecoveryCode) stringResource(R.string.recovery_code) else "6-digit code",
            placeholder = if (useRecoveryCode) "AAAA-BBBB" else "123456",
            keyboardType = if (useRecoveryCode) KeyboardType.Text else KeyboardType.Number,
        )
        FSGhostButton(
            label = if (useRecoveryCode) stringResource(R.string.use_my_authenticator_code_instead) else stringResource(R.string.use_a_recovery_code_instead),
            onClick = { useRecoveryCode = !useRecoveryCode; code = "" },
            block = true,
        )
        Spacer(Modifier.height(FS.space.s2))
        FSPrimaryButton(
            label = stringResource(R.string.continue_label),
            onClick = { onSubmit(code, useRecoveryCode) },
            enabled = code.isNotBlank(),
            block = true,
            large = true,
            modifier = Modifier.semantics { contentDescription = "login-second-factor-continue" },
        )
        FSGhostButton(label = stringResource(R.string.back), onClick = onBack, block = true)
    }
}

@Composable
private fun TakeoverExplainerView(
    graceModel: AccountResolution.GraceModel,
    username: String,
    onConfirm: () -> Unit,
    onImport: () -> Unit,
    onBack: () -> Unit,
) {
    val (graceLine, detail) = when (graceModel) {
        AccountResolution.GraceModel.TwentyFourHourTotp ->
            "This device takes over in 24 hours." to
                stringResource(R.string.your_other_devices_are_alerted_now)
        AccountResolution.GraceModel.ThreeDay ->
            "This device takes over in 3 days." to
                stringResource(R.string.your_old_device_is_alerted_now)
        else ->
            "This device will take over your account." to
                stringResource(R.string.your_other_devices_are_alerted_now)
    }
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12)
            .semantics { contentDescription = "login-takeover-explainer" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            fsString(R.string.take_over, username),
            color = FS.colors.text,
            style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Medium),
        )
        Text(
            graceLine,
            color = FS.colors.text,
            style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        )
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Icon(Icons.Outlined.Info, contentDescription = null, tint = FS.colors.accent, modifier = Modifier.size(20.dp))
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(stringResource(R.string.this_device_becomes_the_admin), color = FS.colors.text, style = MaterialTheme.typography.bodyMedium)
                    Text(
                        detail,
                        color = FS.colors.textMuted,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
        Box(Modifier.height(FS.space.s4))
        FSPrimaryButton(
            label = stringResource(R.string.take_over_this_account),
            onClick = onConfirm,
            block = true,
            large = true,
            modifier = Modifier.semantics { contentDescription = "login-takeover-confirm" },
        )
        ImportBackupOption(onImport = onImport)
        FSGhostButton(label = stringResource(R.string.back), onClick = onBack, block = true)
    }
}

@Composable
private fun GraceCountdownView(
    completesAt: Long,
    onTakeOver: () -> Unit,
    onBack: () -> Unit,
) {
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(completesAt) {
        while (true) {
            nowMs = System.currentTimeMillis()
            kotlinx.coroutines.delay(1000)
        }
    }
    val remaining = (completesAt - nowMs).coerceAtLeast(0L)
    val elapsed = remaining == 0L
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12)
            .semantics { contentDescription = "login-grace-countdown" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            stringResource(R.string.takeover_started),
            color = FS.colors.text,
            style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Medium),
        )
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Icon(Icons.Outlined.Info, contentDescription = null, tint = FS.colors.accent, modifier = Modifier.size(20.dp))
                Text(
                    if (elapsed) stringResource(R.string.the_grace_period_has_elapsed_you)
                    else fsString(R.string.this_device_takes_over_in_your, formatRemaining(remaining)),
                    color = FS.colors.text,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
        Box(Modifier.height(FS.space.s4))
        FSPrimaryButton(
            label = stringResource(R.string.take_over_now),
            onClick = onTakeOver,
            enabled = elapsed,
            block = true,
            large = true,
            modifier = Modifier.semantics { contentDescription = "login-take-over-now" },
        )
        FSGhostButton(label = stringResource(R.string.back), onClick = onBack, block = true)
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

@Composable
private fun TakingOverView() {
    Column(
        modifier = Modifier.fillMaxSize().padding(FS.space.s6)
            .semantics { contentDescription = "login-taking-over" },
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Spacer(Modifier.height(FS.space.s4))
        Text(stringResource(R.string.bringing_this_device_into_your_account), color = FS.colors.textMuted, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun FailureView(message: String, onBack: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize()
            .padding(horizontal = FS.space.s6, vertical = FS.space.s8)
            .semantics { contentDescription = "login-failed" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            stringResource(R.string.couldnt_take_over_the_account),
            color = FS.colors.text,
            style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Medium),
        )
        Text(message, color = FS.colors.textMuted, style = MaterialTheme.typography.bodyLarge)
        Box(Modifier.height(FS.space.s4))
        FSSecondaryButton(label = stringResource(R.string.back), onClick = onBack, block = true, large = true)
    }
}
