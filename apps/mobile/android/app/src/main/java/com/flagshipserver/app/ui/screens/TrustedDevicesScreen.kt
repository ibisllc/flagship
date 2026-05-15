// Trusted devices = peer-class devices on the user's account (push-
// token holders). Mirror of FlagshipUI/Screens/SettingsScreen.swift's
// "TRUSTED DEVICES" section, extracted into its own NavHost
// destination on Android because the Material 3 idiom is a list
// screen + ModalBottomSheet for per-row actions, rather than a
// stacked section inside Settings.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.PhoneIphone
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.lifecycle.viewmodel.initializer
import androidx.navigation.NavController
import com.flagshipserver.app.api.TrustedDevice
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.TrustedDevicesViewModel
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrustedDevicesScreen(nav: NavController) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val vm: TrustedDevicesViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                TrustedDevicesViewModel(
                    server = server,
                    username = { app.currentUser.value },
                )
            }
        },
    )
    val state = vm.state.collectAsState().value
    val scope = rememberCoroutineScope()
    var sheetTarget by remember { mutableStateOf<TrustedDevice?>(null) }
    var confirmDisconnect by remember { mutableStateOf<TrustedDevice?>(null) }
    var snackbarMsg by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { vm.load() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6, vertical = FS.space.s8),
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            "Trusted devices",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "Phones and tablets that hold your account keys.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp),
        )
        Spacer(Modifier.height(FS.space.s2))
        when (state) {
            is TrustedDevicesViewModel.State.Idle,
            is TrustedDevicesViewModel.State.Loading -> LoadingRow()
            is TrustedDevicesViewModel.State.Failed -> ErrorRow(message = state.reason)
            is TrustedDevicesViewModel.State.Loaded -> {
                if (state.devices.isEmpty()) {
                    EmptyRow()
                } else {
                    state.devices.forEach { d ->
                        TrustedDeviceRow(device = d, onMenu = { sheetTarget = d })
                    }
                }
            }
        }
        snackbarMsg?.let {
            Text(it, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
        }
    }

    // Per-device actions: ModalBottomSheet is the Android idiom for
    // "tap a row, see options" — feels more native than an iOS-style
    // contextual menu.
    sheetTarget?.let { target ->
        ModalBottomSheet(onDismissRequest = { sheetTarget = null }) {
            Column(Modifier.padding(FS.space.s4), verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Text(
                    target.label,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
                )
                Text(
                    "${platformDisplay(target.platform)} · added ${relative(target.addedAt)}",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
                TextButton(
                    onClick = {
                        confirmDisconnect = target
                        sheetTarget = null
                    },
                    modifier = Modifier.semantics { contentDescription = "trusted-device-disconnect" },
                ) {
                    Text("Disconnect", color = FS.colors.danger)
                }
                // Replace device lands in C7; row dimmed for now.
                TextButton(onClick = { /* C7 */ }, enabled = false) {
                    Text("Replace device", color = FS.colors.textMuted)
                }
                // Wipe & restart — v1.1 (E5). Visible-but-dimmed so a
                // security-conscious user can see the nuclear option
                // exists. Tap shows an in-place "Coming soon" note
                // instead of a system snackbar (which would dismiss
                // the sheet on Android).
                var wipeNote by remember { mutableStateOf<String?>(null) }
                TextButton(
                    onClick = {
                        wipeNote = "Wipe & restart ships in the next update. Use Replace device for now."
                    },
                    enabled = false,
                    modifier = Modifier.semantics { contentDescription = "trusted-device-wipe" },
                ) {
                    Text("Wipe & restart", color = FS.colors.textMuted)
                }
                wipeNote?.let {
                    Text(it, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
                }
                Spacer(Modifier.height(FS.space.s4))
            }
        }
    }

    // Scare-warning confirmation. "We'll stop sending alerts to <label>.
    // It can sign back in with your passkey."
    confirmDisconnect?.let { target ->
        AlertDialog(
            onDismissRequest = { confirmDisconnect = null },
            title = { Text("Disconnect ${target.label}?") },
            text = { Text("We'll stop sending alerts to ${target.label}. It can sign back in with your passkey.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDisconnect = null
                    scope.launch {
                        val ok = vm.disconnect(target)
                        if (!ok) snackbarMsg = "Couldn't disconnect — check your connection and try again."
                    }
                }) {
                    Text("Disconnect", color = FS.colors.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDisconnect = null }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun LoadingRow() {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
        Text("Loading devices…", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
    }
}

@Composable
private fun ErrorRow(message: String) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Text(message, color = FS.colors.danger, style = TextStyle(fontSize = 14.sp))
    }
}

@Composable
private fun EmptyRow() {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Just this device", color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
            Text(
                "Sign in on another phone or tablet to add a trusted device.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp),
            )
        }
    }
}

@Composable
private fun TrustedDeviceRow(device: TrustedDevice, onMenu: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
        ) {
            Icon(
                imageVector = platformIcon(device.platform),
                contentDescription = null,
                tint = FS.colors.primary,
                modifier = Modifier.size(28.dp),
            )
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    device.label,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                )
                Text(
                    "${platformDisplay(device.platform)} · added ${relative(device.addedAt)}",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp),
                )
                if (device.lastSeenAt > device.addedAt) {
                    Text(
                        "last seen ${relative(device.lastSeenAt)}",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp),
                    )
                }
            }
            IconButton(
                onClick = onMenu,
                modifier = Modifier.semantics {
                    contentDescription = "trusted-device-menu-${device.tokenPrefix}"
                },
            ) {
                Icon(Icons.Outlined.Devices, contentDescription = null, tint = FS.colors.textMuted)
            }
        }
    }
}

private fun platformIcon(raw: String): ImageVector = when (raw) {
    "apns"    -> Icons.Outlined.PhoneIphone
    "fcm"     -> Icons.Outlined.PhoneAndroid
    "webpush" -> Icons.Outlined.Language
    else      -> Icons.Outlined.Devices
}

private fun platformDisplay(raw: String): String = when (raw) {
    "apns"    -> "iPhone / iPad"
    "fcm"     -> "Android"
    "webpush" -> "Web"
    else      -> raw
}

private fun relative(ms: Long): String {
    val now = System.currentTimeMillis()
    val deltaSec = (now - ms) / 1000
    return when {
        deltaSec < 60       -> "just now"
        deltaSec < 3600     -> "${deltaSec / 60}m ago"
        deltaSec < 86_400   -> "${deltaSec / 3600}h ago"
        deltaSec < 604_800  -> "${deltaSec / 86_400}d ago"
        else                -> SimpleDateFormat("MMM d", Locale.getDefault()).format(Date(ms))
    }
}
