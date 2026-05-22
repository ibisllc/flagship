// Phase 3b — ADMIN cross-device pairing screen (Settings → Devices →
// Add device). Shows the pairing QR, derives + displays the SAS once the
// collaborator's phone connects, and seals + delivers the account keys
// on confirm.
//
// Safeguards rendered here:
//   - SecureWindow() (FLAG_SECURE) — no screenshots of the QR / SAS.
//   - A prominent risk warning: this shares your account keys.
//   - The relay session is short-lived + single-use (server-enforced).
//
// MIRRORS the iOS admin add-device surface. Mock relay seam in tests;
// the live relay wiring lands with the relay server's phone↔phone roles.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.MockDevicePairingRelay
import com.flagshipserver.app.core.PairingQr
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.SecureWindow
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.AddDevicePhase
import com.flagshipserver.app.viewmodels.AddDeviceViewModel
import kotlinx.coroutines.launch

@Composable
fun AddDeviceScreen(
    onDone: () -> Unit,
    onCancel: () -> Unit,
) {
    // No screenshots — the QR is the doorway to the account master key.
    SecureWindow()

    val app = LocalAppState.current
    val username = app.currentUser.collectAsState().value ?: ""
    val scope = rememberCoroutineScope()

    // The relay transport is a CompositionLocal-free seam here: the live
    // phone↔phone relay lands with the server's role plumbing. Until then
    // the screen uses the Mock so the UI is exercisable; tests drive the
    // VM directly.
    val relay = remember { MockDevicePairingRelay() }
    val vm: AddDeviceViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                AddDeviceViewModel(relay = relay.admin, username = username)
            }
        },
    )
    val phase by vm.phase.collectAsState()

    LaunchedEffect(Unit) { vm.start() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6, vertical = FS.space.s8)
            .semantics { contentDescription = "add-device" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            "Add a device",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "Have the new phone scan this code to join your account.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
        )

        RiskWarning(
            "This shares your account keys with the scanning device. Anyone " +
                "who scans this code can join your account — only do it for a " +
                "device or person you intend to add. Don't screenshot or share " +
                "this code.",
        )

        when (val p = phase) {
            is AddDevicePhase.ShowingQr -> QrPanel(joinUrl = p.joinUrl)
            is AddDevicePhase.ConfirmSas -> ConfirmPanel(
                matchCode = p.matchCode,
                onConfirm = { scope.launch { vm.confirmAndSeal() } },
                onCancel = { vm.cancel(); onCancel() },
            )
            AddDevicePhase.Delivering -> StatusPanel("Sharing keys securely…", spinner = true)
            AddDevicePhase.Delivered -> DeliveredPanel(onDone = onDone)
            is AddDevicePhase.Failed -> StatusPanel(p.message, danger = true)
        }

        if (phase is AddDevicePhase.ShowingQr) {
            FSGhostButton(label = "Cancel", onClick = { vm.cancel(); onCancel() }, block = true)
        }
    }
}

@Composable
private fun QrPanel(joinUrl: String) {
    val bitmap = remember(joinUrl) { PairingQr.encode(joinUrl) }
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = "device-pairing-qr",
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(1f)
                    .padding(FS.space.s4),
            )
            Box(Modifier.height(FS.space.s1))
            CircularProgressIndicator()
            Text(
                "Waiting for the other device to scan…",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
        }
    }
}

@Composable
private fun ConfirmPanel(matchCode: String, onConfirm: () -> Unit, onCancel: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                "Check the code matches",
                color = FS.colors.text,
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                formatSas(matchCode),
                color = FS.colors.primary,
                style = TextStyle(fontSize = 40.sp, fontWeight = FontWeight.Bold, letterSpacing = 4.sp),
                modifier = Modifier.semantics { contentDescription = "add-device-sas" },
            )
            Text(
                "Confirm this matches the code on the other device before continuing.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
        }
    }
    Spacer(Modifier.height(FS.space.s2))
    FSPrimaryButton(label = "Codes match — add device", onClick = onConfirm, block = true, large = true)
    FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
}

@Composable
private fun DeliveredPanel(onDone: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                "Device added",
                color = FS.colors.success,
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                "The new device is finishing setup. It joins as a non-admin " +
                    "device for the first 14 days — you'll get reminders to " +
                    "review your trusted devices.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
        }
    }
    Spacer(Modifier.height(FS.space.s2))
    FSPrimaryButton(label = "Done", onClick = onDone, block = true, large = true)
}

@Composable
private fun StatusPanel(message: String, spinner: Boolean = false, danger: Boolean = false) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            if (spinner) CircularProgressIndicator()
            Text(
                message,
                color = if (danger) FS.colors.danger else FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp),
            )
        }
    }
}

@Composable
internal fun RiskWarning(text: String) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
            Text(
                "Heads up",
                color = FS.colors.warning,
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
            )
            Text(
                text,
                color = FS.colors.text,
                style = TextStyle(fontSize = 13.sp, lineHeight = 19.sp),
            )
        }
    }
}

/** 6-digit SAS rendered with a space after the third digit. Mirrors
 *  QrRelay.formatMatchCode + heroQr.js. */
internal fun formatSas(code: String): String =
    if (code.length == 6) "${code.substring(0, 3)} ${code.substring(3)}" else code
