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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.PairingQr
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
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

    // No live phone-to-phone relay exists yet: say so instead of pairing over
    // nothing. Debug builds use the in-memory relay so the gym can drive it.
    if (!com.flagshipserver.app.core.AddServerGate.allowsAddDevice(app)) {
        AddServerAdminOnlyScreen(
            onBack = onCancel,
            message = com.flagshipserver.app.core.AddServerGate.ADD_DEVICE_ADMIN_ONLY,
        )
        return
    }
    val relays = remember { com.flagshipserver.app.core.Variant.devicePairingRelays() }
    if (relays == null) {
        DevicePairingUnavailable(title = "Add a device", onCancel = onCancel)
        return
    }
    val vm: AddDeviceViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                AddDeviceViewModel(relay = relays.admin, username = username)
            }
        },
    )
    val phase by vm.phase.collectAsState()

    LaunchedEffect(Unit) { vm.start() }

    FSScreen(
        title = "Add a device",
        onBack = { vm.cancel(); onCancel() },
        modifier = Modifier.semantics { contentDescription = "add-device" },
        subtitle = "Have your new phone or tablet scan this code to join your account.",
    ) {
        RiskWarning(
            "Anyone who scans this code holds your whole account, so add only " +
                "your own phones and tablets. Don't screenshot or share this code.",
            title = "Only for your own devices",
        )
        Text(
            "To give another person access, use Share this server on the server's page instead.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier
                .padding(horizontal = FS.space.s1)
                .semantics { contentDescription = "add-device-share-hint" },
        )

        when (val p = phase) {
            is AddDevicePhase.ShowingQr -> QrPanel(joinUrl = p.joinUrl)
            is AddDevicePhase.ConfirmSas -> {
                // Slice D (D-4) — the promote-to-admin toggle appears ONLY here,
                // in this synchronous admin-initiated SAS ceremony, and ONLY when
                // this device can seal the admin root. DEFAULT OFF + hard warning.
                if (vm.canOfferPromote) {
                    val promote by vm.promoteToAdmin.collectAsState()
                    AdminPromoteToggle(
                        checked = promote,
                        onCheckedChange = { vm.setPromoteToAdmin(it) },
                    )
                }
                ConfirmPanel(
                    matchCode = p.matchCode,
                    // L10 — Confirm stays disabled for the anti-double-tap window
                    // after the SAS appears (parity with iOS `gateExpired`).
                    confirmEnabled = p.gateExpired,
                    onConfirm = { scope.launch { vm.confirmAndSeal() } },
                    onCancel = { vm.cancel(); onCancel() },
                )
            }
            AddDevicePhase.Delivering -> StatusPanel(
                title = "Sharing your account key…",
                message = "Hold on — sending the keys securely to the new device.",
                icon = Icons.Outlined.Lock,
                spinner = true,
            )
            AddDevicePhase.Delivered -> DeliveredPanel(onDone = onDone)
            is AddDevicePhase.Failed -> StatusPanel(
                title = "Couldn't add the device",
                message = p.message,
                icon = Icons.Outlined.ErrorOutline,
                danger = true,
            )
        }

        if (phase is AddDevicePhase.ShowingQr) {
            FSSecondaryButton(label = "Cancel", onClick = { vm.cancel(); onCancel() }, block = true)
        }
    }
}

@Composable
private fun QrPanel(joinUrl: String) {
    val bitmap = remember(joinUrl) { PairingQr.encode(joinUrl) }
    FSCard(padding = PaddingValues(FS.space.s6)) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(FS.space.s4),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = "device-pairing-qr",
                modifier = Modifier
                    .widthIn(max = 280.dp)
                    .fillMaxWidth()
                    .aspectRatio(1f),
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                Text(
                    "Waiting for the other device to scan…",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@Composable
private fun ConfirmPanel(
    matchCode: String,
    confirmEnabled: Boolean,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
) {
    FSCard {
        Column(
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Check the codes match", style = MaterialTheme.typography.titleMedium)
            Text(
                "Both screens should show the same six digits. If they don't, stop — someone may be in the middle.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                formatSas(matchCode),
                color = MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.displaySmall.copy(fontFamily = FontFamily.Monospace, letterSpacing = 6.sp),
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = "add-device-sas" },
            )
            FSPrimaryButton(
                label = "Codes match — add device",
                onClick = onConfirm,
                enabled = confirmEnabled,
                block = true,
            )
        }
    }
    FSSecondaryButton(label = "Cancel", onClick = onCancel, block = true)
}

@Composable
private fun DeliveredPanel(onDone: () -> Unit) {
    StatusPanel(
        title = "Device added",
        message = "The new device is finishing setup. It joins as a non-admin " +
            "device for the first 14 days — you'll get reminders to " +
            "review your trusted devices.",
        icon = Icons.Outlined.CheckCircle,
        tint = FS.colors.success,
    )
    FSPrimaryButton(label = "Done", onClick = onDone, block = true)
}

@Composable
private fun StatusPanel(
    title: String,
    message: String,
    icon: ImageVector,
    spinner: Boolean = false,
    danger: Boolean = false,
    tint: Color? = null,
) {
    val accent = tint ?: if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                if (spinner) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                } else {
                    Icon(icon, contentDescription = null, tint = accent)
                }
                Text(title, style = MaterialTheme.typography.titleMedium)
            }
            Text(
                message,
                color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

/** Slice D (D-4) — the "Also make this device an admin" toggle. DEFAULT OFF,
 *  with a hard warning that admin can wipe / transfer / decommission the cloud.
 *  Rendered ONLY in the synchronous admin-initiated SAS ceremony. */
@Composable
private fun AdminPromoteToggle(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    FSCard {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentDescription = "add-device-promote-admin-toggle" },
        ) {
            Icon(
                Icons.Outlined.Key,
                contentDescription = null,
                tint = if (checked) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
            )
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                Text("Also make this device an admin", style = MaterialTheme.typography.titleSmall)
                Text(
                    "Off by default. If on, this device will be able to wipe, transfer, " +
                        "or decommission your cloud. Only turn this on for a device " +
                        "you fully trust.",
                    color = if (checked) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Switch(checked = checked, onCheckedChange = onCheckedChange)
        }
    }
}

/** The always-on safeguard card: a warning icon, a title and the risk. */
@Composable
internal fun RiskWarning(text: String, title: String = "Heads up") {
    FSCard {
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = FS.colors.warning)
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(
                    text,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

/** 6-digit SAS rendered with a space after the third digit. Mirrors
 *  QrRelay.formatMatchCode + webapp/lib/pairingRelay.js. */
internal fun formatSas(code: String): String =
    if (code.length == 6) "${code.substring(0, 3)} ${code.substring(3)}" else code

/** Where device pairing would start while no live relay exists. */
@Composable
internal fun DevicePairingUnavailable(title: String, onCancel: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6, vertical = FS.space.s8)
            .semantics { contentDescription = "device-pairing-unavailable" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            title,
            color = FS.colors.text,
            style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.SemiBold),
        )
        Text(
            com.flagshipserver.app.core.DEVICE_PAIRING_UNAVAILABLE,
            color = FS.colors.textMuted,
            style = MaterialTheme.typography.bodyLarge,
        )
        FSPrimaryButton(label = "Back", onClick = onCancel, block = true)
    }
}
