// Phase 2 (login redesign) — OPEN ACCOUNT screen.
//
// The last create-path step before Home. The username was chosen +
// verified-available on ChooseUsername; here we name THIS device and
// open the account: ensure UMK → standalone username claim → complete
// onboarding with ZERO servers. Home then lands on the "add your first
// server" empty state. A server is a separate, later, repeatable step.
//
// Drives OpenAccountViewModel; see docs/login-and-account-redesign.md.

package com.flagshipserver.app.ui.screens

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.OpenAccountPhase
import com.flagshipserver.app.viewmodels.OpenAccountViewModel
import kotlinx.coroutines.launch

@Composable
fun OpenAccountScreen(
    username: String,
    onOpened: () -> Unit,
    onBack: () -> Unit,
) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val scope = rememberCoroutineScope()

    val vm = remember(username) {
        OpenAccountViewModel(server = server, app = app, username = username)
    }
    val phase by vm.phase.collectAsState()

    val deviceModel = remember { (Build.MODEL ?: "").trim().ifEmpty { null } }
    var accountName by remember { mutableStateOf(vm.defaultAccountName()) }
    var deviceName by remember { mutableStateOf(vm.defaultDeviceName(deviceModel)) }

    // When the claim + onboarding land, hand back to the host (which lets
    // AppState.isPaired flip the shell to Home).
    LaunchedEffect(phase) {
        if (phase is OpenAccountPhase.Opened) onOpened()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12)
            .semantics { contentDescription = "open-account" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s6),
    ) {
        Text(
            text = "Open your account.",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = "Reserving “$username” and bringing this device into your account. " +
                "Give this device a name so you can recognise it later.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )

        FSField(
            value = accountName,
            onValueChange = { accountName = it },
            label = "Account display name",
            placeholder = "Johnson Family",
            helper = "Encrypted and shown above @$username. It is never used in links.",
            enabled = phase !is OpenAccountPhase.Working,
        )

        FSField(
            value = deviceName,
            onValueChange = { deviceName = it },
            label = "This device's name",
            placeholder = "$username's phone",
            helper = "You can rename it anytime in Settings.",
            enabled = phase !is OpenAccountPhase.Working,
        )

        if (phase is OpenAccountPhase.Failed) {
            Text(
                text = (phase as OpenAccountPhase.Failed).message,
                color = FS.colors.danger,
                style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
            )
        }

        Spacer(Modifier.height(FS.space.s4))

        FSPrimaryButton(
            label = if (phase is OpenAccountPhase.Failed) "Try again" else "Open account",
            onClick = { scope.launch { vm.openAccount(deviceName, accountName) } },
            block = true,
            large = true,
            enabled = phase !is OpenAccountPhase.Working && deviceName.isNotBlank() && accountName.isNotBlank(),
        )
        FSGhostButton(
            label = "Back",
            onClick = onBack,
            block = true,
        )
    }
}
