// Phase 3b — INCOMING cross-device pairing screen. Reached two ways:
//   - Connect to an existing account → Scan a code, or a pasted link, or
//   - the https://flagshipserver.com/join App Link (the collaborator's native
//     camera follows the admin's QR).
//
// Drives the JoinDeviceViewModel: connect → show SAS for the USER to
// verify → receive + open the bundle → verify the admit → install into a
// NEW profile → admit (lands QUARANTINED). Surfaces the 14-day quarantine
// countdown on success.
//
// Safeguards: SecureWindow() (FLAG_SECURE — no screenshots) + a risk
// warning. Mock relay seam in tests; live Credential Manager NOT involved.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Sensors
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.OutlinedTextField
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.JoinLink
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.SecureWindow
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.JoinDevicePhase
import com.flagshipserver.app.viewmodels.JoinDeviceViewModel
import kotlinx.coroutines.launch
import com.flagshipserver.app.core.FlagshipDateFormat
import java.util.Date
import java.util.Locale

/**
 * @param initialLink non-null when arriving via deeplink (skips the
 *        scanner). Null shows the in-app scanner first.
 */
@Composable
fun JoinDeviceScreen(
    initialLink: JoinLink? = null,
    onJoined: () -> Unit,
    onCancel: () -> Unit,
) {
    // No screenshots — the SAS + relay are the join doorway.
    SecureWindow()

    // A variant without a pairing transport says so before the scanner.
    // Mock debug runs use the in-memory relay so the gym can drive it.
    val relays = remember { com.flagshipserver.app.core.Variant.devicePairingRelays() }
    if (relays == null) {
        DevicePairingUnavailable(title = stringResource(R.string.join_an_account), onCancel = onCancel, message = com.flagshipserver.app.core.DEVICE_JOIN_UNAVAILABLE)
        return
    }

    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val scope = rememberCoroutineScope()

    var link by remember { mutableStateOf(initialLink) }
    var scanError by remember { mutableStateOf<String?>(null) }
    var deviceName by remember { mutableStateOf(FSStrings.get(R.string.this_android_device)) }

    if (link == null) {
        ScannerEntry(
            error = scanError,
            onScanned = { raw ->
                val parsed = JoinLink.parse(raw)
                if (parsed == null) {
                    scanError = FSStrings.get(R.string.that_qr_isnt_a_flagship_pairing)
                } else {
                    scanError = null
                    link = parsed
                }
            },
            onCancel = onCancel,
        )
        return
    }

    val vm = remember(link) {
        JoinDeviceViewModel(
            joinLink = link!!,
            relay = relays.incoming,
            server = server,
            app = app,
        )
    }
    val phase by vm.phase.collectAsState()

    LaunchedEffect(vm) { vm.start() }

    FSScreen(
        title = stringResource(R.string.join_an_account),
        onBack = { vm.cancel(); onCancel() },
        modifier = Modifier.semantics { contentDescription = "join-device" },
    ) {
        RiskWarning(
            stringResource(R.string.youre_about_to_bring_this_device),
        )

        when (val p = phase) {
            JoinDevicePhase.Connecting -> StatusPanel(
                title = stringResource(R.string.connecting),
                message = stringResource(R.string.setting_up_a_secure_channel_with),
                icon = Icons.Outlined.Sensors,
                spinner = true,
            )
            is JoinDevicePhase.VerifySas -> VerifyPanel(
                matchCode = p.matchCode,
                deviceName = deviceName,
                onDeviceNameChange = { deviceName = it },
                onConfirm = {
                    vm.confirmDisplayName(deviceName)
                    scope.launch { vm.verifyAndJoin() }
                },
                onCancel = { vm.cancel(); onCancel() },
            )
            JoinDevicePhase.Joining -> StatusPanel(
                title = stringResource(R.string.joining_the_account),
                message = stringResource(R.string.verifying_the_admins_authorization_and),
                icon = Icons.Outlined.Lock,
                spinner = true,
            )
            is JoinDevicePhase.Joined -> JoinedPanel(quarantineUntil = p.quarantineUntil, onDone = onJoined)
            is JoinDevicePhase.Failed -> {
                StatusPanel(
                    title = stringResource(R.string.couldnt_join),
                    message = p.message,
                    icon = Icons.Outlined.ErrorOutline,
                    danger = true,
                )
                FSSecondaryButton(label = stringResource(R.string.back), onClick = onCancel, block = true)
            }
        }
    }
}

@Composable
private fun ScannerEntry(error: String?, onScanned: (String) -> Unit, onCancel: () -> Unit) {
    FSScreen(
        title = stringResource(R.string.scan_the_pairing_code),
        onBack = onCancel,
        modifier = Modifier.semantics { contentDescription = "join-device-scan" },
        subtitle = stringResource(R.string.point_your_camera_at_the_add),
    ) {
        RiskWarning(
            stringResource(R.string.scanning_brings_this_device_into_the),
        )
        QRScanner(onScanned = onScanned)
        error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
        FSSecondaryButton(label = stringResource(R.string.cancel), onClick = onCancel, block = true)
    }
}

@Composable
private fun VerifyPanel(
    matchCode: String,
    deviceName: String,
    onDeviceNameChange: (String) -> Unit,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
) {
    FSCard {
        Column(
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.confirm_this_code), style = MaterialTheme.typography.titleMedium)
            Text(
                stringResource(R.string.it_must_match_the_code_on),
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
                    .semantics { contentDescription = "join-device-sas" },
            )
            FSField(
                value = deviceName,
                onValueChange = onDeviceNameChange,
                label = stringResource(R.string.name_in_this_account),
                helper = stringResource(R.string.this_encrypted_name_applies_only_inside),
            )
            FSPrimaryButton(
                label = stringResource(R.string.confirm_name_and_join),
                onClick = onConfirm,
                enabled = deviceName.isNotBlank(),
                block = true,
            )
        }
    }
    FSSecondaryButton(label = stringResource(R.string.cancel), onClick = onCancel, block = true)
}

@Composable
private fun JoinedPanel(quarantineUntil: Long?, onDone: () -> Unit) {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = FS.colors.success)
                Text(stringResource(R.string.youre_in), style = MaterialTheme.typography.titleMedium)
            }
            Text(
                quarantineCopy(quarantineUntil),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.semantics { contentDescription = "join-device-quarantine" },
            )
        }
    }
    FSPrimaryButton(label = stringResource(R.string.continue_label), onClick = onDone, block = true)
}

@Composable
private fun StatusPanel(
    title: String,
    message: String,
    icon: ImageVector,
    spinner: Boolean = false,
    danger: Boolean = false,
) {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                if (spinner) {
                    CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                } else {
                    Icon(
                        icon,
                        contentDescription = null,
                        tint = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                    )
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

/** Quarantine countdown copy for the joined panel. Kept top-level so a
 *  test can assert the byte-string without Compose scaffolding. */
internal fun quarantineCopy(quarantineUntil: Long?, now: Long = System.currentTimeMillis()): String {
    if (quarantineUntil == null || quarantineUntil <= now) {
        return FSStrings.get(R.string.this_device_is_now_on_the)
    }
    val days = ((quarantineUntil - now) + 86_399_999) / 86_400_000  // ceil to days
    val until = FlagshipDateFormat.format(quarantineUntil, nowMs = now)
    return FSStrings.get(R.string.this_device_is_a_non_admin, days) +
        (if (days == 1L) "" else "s") +
        " (until $until). The account owner is being reminded to review trusted devices."
}
