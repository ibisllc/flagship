// Phase 3 (login redesign) — the REAL single/multi login UI.
//
// Hosts the LoginViewModel state machine for a resolved real account
// (kind == single | multi). Replaces the legacy RecoverFromWelcome
// container hand-off for these branches — the win is every absent
// factor renders a STATE, not an error card, and the takeover actually
// installs the recovered UMK + initiates re-pair + labels this device
// "admin" with the RESOLVED username (no "recovered-user" placeholder).
//
// Phase 3 is Mock-WebAuthn only (MockWebAuthnProvider); live
// CredentialManager wiring is a separate human/device task. Phase 4
// adds the grace countdown / completion polling / push / quarantine.
//
// Mirror of the iOS Phase 3 login screens.

package com.flagshipserver.app.ui.onboarding

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.AccountResolution
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.keystore.MockWebAuthnProvider
import com.flagshipserver.app.keystore.WebAuthnProvider
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.LoginPhase
import com.flagshipserver.app.viewmodels.LoginViewModel
import kotlinx.coroutines.launch

@Composable
fun RealAccountLoginContainer(
    resolution: AccountResolution,
    onOpened: () -> Unit,
    onBack: () -> Unit,
    /** Phase 3 = Mock; the live CredentialManager wrapper is a separate
     *  human/device task. Injectable so tests + previews pin behaviour. */
    webauthn: WebAuthnProvider = remember { MockWebAuthnProvider() },
) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val scope = rememberCoroutineScope()
    val vm = remember(resolution) {
        LoginViewModel(resolution = resolution, server = server, app = app, webauthn = webauthn)
    }
    val phase by vm.phase.collectAsState()

    LaunchedEffect(vm) { vm.begin() }
    LaunchedEffect(phase) { if (phase == LoginPhase.Opened) onOpened() }

    when (val p = phase) {
        LoginPhase.Idle, LoginPhase.Recovering -> RecoveringView(onCancel = onBack)
        is LoginPhase.NoCloudBackup -> NoCloudBackupView(single = p.single, onBack = onBack)
        LoginPhase.AwaitingSecondFactor -> SecondFactorView(
            onSubmit = { code, isRecovery -> vm.submitSecondFactor(code, isRecovery) },
            onBack = onBack,
        )
        is LoginPhase.TakeoverReady -> TakeoverExplainerView(
            graceModel = p.graceModel,
            username = vm.username,
            onConfirm = { scope.launch { vm.confirmTakeover() } },
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
                "Authenticate with your passkey",
                color = FS.colors.text,
                style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Medium),
            )
            Text(
                "We'll unwrap your account key and bring this device into your existing Flagship account.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                modifier = Modifier.padding(horizontal = FS.space.s8),
            )
        }
        FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
    }
}

@Composable
private fun NoCloudBackupView(single: Boolean, onBack: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize()
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12)
            .semantics { contentDescription = "login-no-cloud-backup" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            "No cloud backup on this account",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        // The single/multi-with-no-working-device dead end is a node in
        // the decision tree, NOT a 404. Copy verbatim from
        // docs/login-and-account-redesign.md.
        Text(
            if (single) "Use a device that still has access."
            else "Use another device, or one of your recovery codes.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )
        Box(Modifier.height(FS.space.s4))
        FSPrimaryButton(label = "Back", onClick = onBack, block = true, large = true)
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
            "Enter your recovery code",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "This account is protected by a second factor. Enter the current 6-digit code from your authenticator, " +
                "or use one of the recovery codes you saved when you set this up.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )
        FSField(
            value = code,
            onValueChange = { code = it },
            label = if (useRecoveryCode) "Recovery code" else "6-digit code",
            placeholder = if (useRecoveryCode) "AAAA-BBBB" else "123456",
            keyboardType = if (useRecoveryCode) KeyboardType.Text else KeyboardType.Number,
        )
        FSGhostButton(
            label = if (useRecoveryCode) "Use my authenticator code instead" else "Use a recovery code instead",
            onClick = { useRecoveryCode = !useRecoveryCode; code = "" },
            block = true,
        )
        Spacer(Modifier.height(FS.space.s2))
        FSPrimaryButton(
            label = "Continue",
            onClick = { onSubmit(code, useRecoveryCode) },
            enabled = code.isNotBlank(),
            block = true,
            large = true,
            modifier = Modifier.semantics { contentDescription = "login-second-factor-continue" },
        )
        FSGhostButton(label = "Back", onClick = onBack, block = true)
    }
}

@Composable
private fun TakeoverExplainerView(
    graceModel: AccountResolution.GraceModel,
    username: String,
    onConfirm: () -> Unit,
    onBack: () -> Unit,
) {
    val (graceLine, detail) = when (graceModel) {
        AccountResolution.GraceModel.TwentyFourHourTotp ->
            "This device takes over in 24 hours." to
                "Your other devices are alerted now and can object during the grace window."
        AccountResolution.GraceModel.SevenDay ->
            "This device takes over in 7 days." to
                "Your old device is alerted now. After the grace window this device becomes the admin."
        else ->
            "This device will take over your account." to
                "Your other devices are alerted now."
    }
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12)
            .semantics { contentDescription = "login-takeover-explainer" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            "Take over @$username",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            graceLine,
            color = FS.colors.text,
            style = TextStyle(fontSize = 18.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold),
        )
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Icon(Icons.Outlined.Info, contentDescription = null, tint = FS.colors.primary, modifier = Modifier.size(20.dp))
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("This device becomes the admin", color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
                    Text(
                        detail,
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
                    )
                }
            }
        }
        Box(Modifier.height(FS.space.s4))
        FSPrimaryButton(
            label = "Take over this account",
            onClick = onConfirm,
            block = true,
            large = true,
            modifier = Modifier.semantics { contentDescription = "login-takeover-confirm" },
        )
        FSGhostButton(label = "Back", onClick = onBack, block = true)
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
            "Takeover started",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Icon(Icons.Outlined.Info, contentDescription = null, tint = FS.colors.primary, modifier = Modifier.size(20.dp))
                Text(
                    if (elapsed) "The grace period has elapsed — you can take over now."
                    else "This device takes over in ${formatRemaining(remaining)}. Your other devices are alerted and can object until then.",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                )
            }
        }
        Box(Modifier.height(FS.space.s4))
        FSPrimaryButton(
            label = "Take over now",
            onClick = onTakeOver,
            enabled = elapsed,
            block = true,
            large = true,
            modifier = Modifier.semantics { contentDescription = "login-take-over-now" },
        )
        FSGhostButton(label = "Back", onClick = onBack, block = true)
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
        Text("Bringing this device into your account…", color = FS.colors.textMuted, style = TextStyle(fontSize = 16.sp))
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
            "Couldn't take over the account",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(message, color = FS.colors.textMuted, style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp))
        Box(Modifier.height(FS.space.s4))
        FSSecondaryButton(label = "Back", onClick = onBack, block = true, large = true)
    }
}
