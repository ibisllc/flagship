// Trusted devices = peer-class devices on the user's account (push-
// token holders). Mirror of FlagshipUI/Screens/SettingsScreen.swift's
// "TRUSTED DEVICES" section, extracted into its own NavHost
// destination on Android because the Material 3 idiom is a list
// screen + ModalBottomSheet for per-row actions, rather than a
// stacked section inside Settings.

package com.flagshipserver.app.ui.screens

import android.app.Activity
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
import androidx.compose.material.icons.outlined.AccessTime
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
import androidx.compose.ui.platform.LocalContext
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
import com.flagshipserver.app.api.PendingRePairSnapshot
import com.flagshipserver.app.api.TrustedDevice
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.keystore.PasskeyRecoveryManager
import com.flagshipserver.app.keystore.PlatformWebAuthnProvider
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.ReplaceDeviceViewModel
import com.flagshipserver.app.viewmodels.TrustedDevicesViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import com.flagshipserver.app.core.FlagshipDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrustedDevicesScreen(nav: NavController) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    // E5 — the Wipe ceremony rotates the recovery passkey. It must run the
    // REAL CredentialManager provider (same one Recovery/Secure-account use),
    // not the Mock — otherwise the new UMK is sealed under a passkey that
    // doesn't exist and the account is unrecoverable after the wipe.
    val ctx = LocalContext.current
    val passkeys = remember(ctx) { PasskeyRecoveryManager(ctx.applicationContext) }
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
    val pendingRePair = vm.pendingRePair.collectAsState().value
    val scope = rememberCoroutineScope()
    var sheetTarget by remember { mutableStateOf<TrustedDevice?>(null) }
    var confirmDisconnect by remember { mutableStateOf<TrustedDevice?>(null) }
    var confirmReplace by remember { mutableStateOf(false) }
    var confirmWipe by remember { mutableStateOf(false) }
    var snackbarMsg by remember { mutableStateOf<String?>(null) }
    val replaceVm: com.flagshipserver.app.viewmodels.ReplaceDeviceViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                com.flagshipserver.app.viewmodels.ReplaceDeviceViewModel(
                    server = server,
                    username = { app.currentUser.value },
                )
            }
        },
    )
    val wipeVm: com.flagshipserver.app.viewmodels.WipeRestartViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                com.flagshipserver.app.viewmodels.WipeRestartViewModel(
                    server = server,
                    // Real passkey provider — see note at the top of this
                    // composable. `ctx as? Activity` is resolved lazily at
                    // ceremony time so the CredentialManager UI has a host.
                    webAuthn = PlatformWebAuthnProvider(
                        activity = { ctx as? Activity },
                        username = { app.currentUser.value },
                        manager = passkeys,
                    ),
                    username = { app.currentUser.value },
                )
            }
        },
    )

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
        // M4 — pending re-pair banner. A replace started on THIS or ANY
        // other device surfaces here with a grace countdown and a
        // "Finalize now" entry into the finalize screen.
        PendingRePairBanner(
            snapshot = pendingRePair,
            onFinalize = { completesAt -> nav.navigate("replace-finalize/$completesAt") },
        )
        // Phase 3b — admin entry to the cross-device pairing QR. Adds a
        // collaborator's OWN phone (no shared iCloud); the added device
        // lands quarantined + non-admin.
        com.flagshipserver.app.ui.components.FSSecondaryButton(
            label = "Add device",
            onClick = { nav.navigate("add-device") },
            block = true,
            modifier = Modifier.semantics { contentDescription = "trusted-devices-add" },
        )
        Spacer(Modifier.height(FS.space.s2))
        // Spec S1/F — the "Add a control device" (browser / tablet) entry
        // merged in from its old standalone Settings row, so every device-add
        // path lives in one place. Distinct from "Add device" above (that pairs
        // another phone that holds account keys); this pairs a browser/tablet.
        com.flagshipserver.app.ui.components.FSGhostButton(
            label = "Add a browser or tablet",
            onClick = { nav.navigate("add-control-device") },
            block = true,
            modifier = Modifier.semantics { contentDescription = "trusted-devices-add-control" },
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
    //
    // v1.2 Phase 4 — Disconnect / Replace / Wipe entries are DISABLED
    // when the row is in quarantine (the 14-day freshly-admitted
    // window). Tapping a disabled entry posts a toast explaining the
    // window so users aren't confused by silent failure.
    sheetTarget?.let { target ->
        val isQuarantined = target.isQuarantined()
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
                if (isQuarantined) {
                    Text(
                        quarantineToast(target),
                        color = FS.colors.danger,
                        style = TextStyle(fontSize = 13.sp),
                        modifier = Modifier.semantics {
                            contentDescription = "trusted-device-quarantine-msg-${target.tokenPrefix}"
                        },
                    )
                }
                TextButton(
                    onClick = {
                        if (isQuarantined) {
                            snackbarMsg = quarantineToast(target)
                        } else {
                            confirmDisconnect = target
                        }
                        sheetTarget = null
                    },
                    enabled = !isQuarantined,
                    modifier = Modifier.semantics { contentDescription = "trusted-device-disconnect" },
                ) {
                    Text("Disconnect", color = FS.colors.danger)
                }
                // C7 — Replace device. Tap opens the scare dialog;
                // confirmation drives the ReplaceDeviceViewModel.
                TextButton(
                    onClick = {
                        if (isQuarantined) {
                            snackbarMsg = quarantineToast(target)
                            sheetTarget = null
                        } else {
                            confirmReplace = true
                            sheetTarget = null
                        }
                    },
                    enabled = !isQuarantined,
                    modifier = Modifier.semantics { contentDescription = "trusted-device-replace" },
                ) {
                    Text("Replace device", color = FS.colors.danger)
                }
                // E5 — Wipe & restart. Live ceremony.
                TextButton(
                    onClick = {
                        if (isQuarantined) {
                            snackbarMsg = quarantineToast(target)
                            sheetTarget = null
                        } else {
                            confirmWipe = true
                            sheetTarget = null
                        }
                    },
                    enabled = !isQuarantined,
                    modifier = Modifier.semantics { contentDescription = "trusted-device-wipe" },
                ) {
                    Text("Wipe & restart", color = FS.colors.danger)
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

    // E5 — Wipe & restart scare dialog.
    if (confirmWipe) {
        AlertDialog(
            onDismissRequest = { confirmWipe = false },
            title = { Text("Wipe and start over?") },
            text = {
                Text(
                    "Your account keeps the same username and your pods keep " +
                        "their data. Every device currently on this account will " +
                        "be disconnected — including this phone, which becomes " +
                        "the new root of trust. You'll re-pair each one fresh.\n\n" +
                        "This can't be undone from another device.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmWipe = false
                    scope.launch {
                        wipeVm.run(currentEtag = vm.etag.value)
                        when (val phase = wipeVm.phase.value) {
                            com.flagshipserver.app.viewmodels.WipeRestartPhase.Completed -> {
                                snackbarMsg = "Done. All other devices are now disconnected. Re-pair them on next open."
                                // Drop to Welcome — current session is stale.
                                app.signOut()
                            }
                            is com.flagshipserver.app.viewmodels.WipeRestartPhase.Failed ->
                                snackbarMsg = phase.message
                            else -> Unit
                        }
                    }
                }) {
                    Text("Wipe and start over", color = FS.colors.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmWipe = false }) { Text("Cancel") }
            },
        )
    }

    // C7 — Replace device scare dialog. Same UX shape as iOS B7.
    if (confirmReplace) {
        AlertDialog(
            onDismissRequest = { confirmReplace = false },
            title = { Text("Replace this device?") },
            text = {
                Text(
                    "Rotates your account's identity key. Other devices on " +
                        "this account will need to re-pair the next time they " +
                        "open the app. Pods stay running, apps stay installed. " +
                        "Takes effect after a 24-hour grace window during which " +
                        "another device can object.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmReplace = false
                    scope.launch {
                        replaceVm.initiate(currentEtag = vm.etag.value)
                        when (val phase = replaceVm.phase.value) {
                            is com.flagshipserver.app.viewmodels.ReplaceDevicePhase.Pending -> {
                                // H5 — push the dedicated FINALIZE screen (24h
                                // grace countdown + Complete) instead of leaving
                                // the ceremony at a transient snackbar. Carries
                                // the server-reported deadline on the route.
                                nav.navigate("replace-finalize/${phase.completesAt}")
                            }
                            is com.flagshipserver.app.viewmodels.ReplaceDevicePhase.Failed ->
                                snackbarMsg = phase.message
                            else -> Unit
                        }
                    }
                }) {
                    Text("Replace device", color = FS.colors.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmReplace = false }) { Text("Cancel") }
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

/** M4 — the "Replace pending" banner. Renders only when the GET /re-pair
 *  snapshot carries an un-objected pending row (mirrors the webapp's
 *  shouldRenderBanner + iOS). The countdown ticks live; "Finalize now" is
 *  gated on the grace having elapsed and routes into the finalize screen. */
@Composable
private fun PendingRePairBanner(
    snapshot: PendingRePairSnapshot?,
    onFinalize: (Long) -> Unit,
) {
    if (!ReplaceDeviceViewModel.shouldRenderPendingBanner(snapshot)) return
    val pending = snapshot?.pending ?: return

    var nowTick by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            nowTick = System.currentTimeMillis()
            delay(1000)
        }
    }
    val elapsed = ReplaceDeviceViewModel.graceElapsed(pending.completesAt, nowTick)

    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                "Replace pending",
                color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                modifier = Modifier.semantics { contentDescription = "pending-re-pair-banner" },
            )
            Text(
                if (elapsed) {
                    "The grace window has elapsed — finalize the device replacement now."
                } else {
                    "Replace pending — finalize when the 3-day grace elapses " +
                        "(${formatCompletesAt(pending.completesAt)})."
                },
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
                modifier = Modifier.semantics { contentDescription = "pending-re-pair-banner-body" },
            )
            FSPrimaryButton(
                label = "Finalize now",
                onClick = { onFinalize(pending.completesAt) },
                enabled = elapsed,
                block = true,
                modifier = Modifier.semantics { contentDescription = "pending-re-pair-finalize-btn" },
            )
        }
    }
    Spacer(Modifier.height(FS.space.s2))
}

/** Absolute locale timestamp for the pending-re-pair banner's unlock time
 *  (mirrors the webapp's formatCompletesAt). Kept top-level so a test can
 *  assert the exact shape without Compose scaffolding. */
internal fun formatCompletesAt(ms: Long): String =
    FlagshipDateFormat.format(ms, includeTime = true)

@Composable
private fun TrustedDeviceRow(device: TrustedDevice, onMenu: () -> Unit) {
    val isQuarantined = device.isQuarantined()
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
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        device.label,
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                    )
                    if (isQuarantined) {
                        Icon(
                            imageVector = Icons.Outlined.AccessTime,
                            contentDescription = null,
                            tint = FS.colors.danger,
                            modifier = Modifier
                                .size(16.dp)
                                .semantics {
                                    contentDescription =
                                        "trusted-device-quarantine-icon-${device.tokenPrefix}"
                                },
                        )
                    }
                }
                Text(
                    "${platformDisplay(device.platform)} · added ${relative(device.addedAt)}",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp),
                )
                if (isQuarantined) {
                    Text(
                        quarantineToast(device),
                        color = FS.colors.danger,
                        style = TextStyle(fontSize = 12.sp),
                    )
                } else if (device.lastSeenAt > device.addedAt) {
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

/** Tooltip / toast copy for a quarantined device row. Kept as a
 *  top-level helper so the QuarantineIndicatorTest can assert on the
 *  exact byte-string without going through SwiftUI / Compose
 *  scaffolding. */
internal fun quarantineToast(device: TrustedDevice): String {
    val until = device.quarantineUntil ?: return "This device is in quarantine. Use another device."
    val when_ = FlagshipDateFormat.format(until)
    return "Quarantined until $when_. Use another device."
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

private fun relative(ms: Long): String = FlagshipDateFormat.format(ms)
