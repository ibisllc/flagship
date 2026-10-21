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

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
import androidx.compose.ui.platform.testTag
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
import com.flagshipserver.app.ui.components.Switch
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

    // A variant without a pairing transport says so instead of pairing over
    // nothing. Mock debug runs use the in-memory relay so the gym can drive it.
    if (!com.flagshipserver.app.core.AddServerGate.allowsAddDevice(app)) {
        AddServerAdminOnlyScreen(
            onBack = onCancel,
            message = com.flagshipserver.app.core.AddServerGate.ADD_DEVICE_ADMIN_ONLY,
        )
        return
    }
    val relays = remember { com.flagshipserver.app.core.Variant.devicePairingRelays() }
    if (relays == null) {
        DevicePairingUnavailable(title = stringResource(R.string.add_a_device), onCancel = onCancel)
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
        title = stringResource(R.string.add_a_device),
        onBack = { vm.cancel(); onCancel() },
        modifier = Modifier.semantics { contentDescription = "add-device" },
        subtitle = stringResource(R.string.have_your_new_phone_or_tablet),
    ) {
        RiskWarning(
            stringResource(R.string.anyone_who_scans_this_code_holds),
            title = stringResource(R.string.only_for_your_own_devices),
        )
        Text(
            stringResource(R.string.to_give_another_person_access_use),
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
                title = stringResource(R.string.sharing_your_account_key),
                message = stringResource(R.string.hold_on_sending_the_keys_securely),
                icon = Icons.Outlined.Lock,
                spinner = true,
            )
            AddDevicePhase.Delivered -> DeliveredPanel(onDone = onDone)
            is AddDevicePhase.Failed -> StatusPanel(
                title = stringResource(R.string.couldnt_add_the_device),
                message = p.message,
                icon = Icons.Outlined.ErrorOutline,
                danger = true,
            )
        }

        if (phase is AddDevicePhase.Failed) {
            FSSecondaryButton(label = stringResource(R.string.try_again), onClick = { scope.launch { vm.start() } }, block = true, modifier = Modifier.testTag("add-device-retry"))
            FSSecondaryButton(label = stringResource(R.string.close), onClick = { vm.cancel(); onCancel() }, block = true)
        }
        if (phase is AddDevicePhase.ShowingQr) {
            FSSecondaryButton(label = stringResource(R.string.cancel), onClick = { vm.cancel(); onCancel() }, block = true)
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
                    stringResource(R.string.waiting_for_the_other_device_to),
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
            Text(stringResource(R.string.check_the_codes_match), style = MaterialTheme.typography.titleMedium)
            Text(
                stringResource(R.string.both_screens_should_show_the_same),
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
                label = stringResource(R.string.codes_match_add_device),
                onClick = onConfirm,
                enabled = confirmEnabled,
                block = true,
            )
        }
    }
    FSSecondaryButton(label = stringResource(R.string.cancel), onClick = onCancel, block = true)
}

@Composable
private fun DeliveredPanel(onDone: () -> Unit) {
    StatusPanel(
        title = stringResource(R.string.device_added),
        message = stringResource(R.string.the_new_device_is_finishing_setup),
        icon = Icons.Outlined.CheckCircle,
        tint = FS.colors.success,
    )
    FSPrimaryButton(label = stringResource(R.string.done), onClick = onDone, block = true)
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
                Text(stringResource(R.string.also_make_this_device_an_admin), style = MaterialTheme.typography.titleSmall)
                Text(
                    stringResource(R.string.off_by_default_if_on_this),
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
internal fun RiskWarning(text: String, title: String = stringResource(R.string.heads_up)) {
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
internal fun DevicePairingUnavailable(
    title: String,
    onCancel: () -> Unit,
    message: String = com.flagshipserver.app.core.DEVICE_PAIRING_UNAVAILABLE,
) {
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
            message,
            color = FS.colors.textMuted,
            style = MaterialTheme.typography.bodyLarge,
        )
        FSPrimaryButton(label = stringResource(R.string.back), onClick = onCancel, block = true)
    }
}
