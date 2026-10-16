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
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.DeleteForever
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.LockOpen
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.PhonelinkErase
import androidx.compose.material.icons.outlined.QrCode2
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.PhoneIphone
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Checkbox
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
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.keystore.PasskeyRecoveryManager
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.PlatformWebAuthnProvider
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSBarAction
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSectionHeader
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
                    profile = { app.activeProfile },
                    cacheNames = { accountName, deviceName ->
                        app.cachePresentationNames(accountName, deviceName)
                    },
                )
            }
        },
    )
    val state = vm.state.collectAsState().value
    val pendingRePair = vm.pendingRePair.collectAsState().value
    val accountDisplayName = vm.accountDisplayName.collectAsState().value
    val scope = rememberCoroutineScope()
    var sheetTarget by remember { mutableStateOf<TrustedDevicesViewModel.DirectoryDevice?>(null) }
    var confirmDisconnect by remember { mutableStateOf<TrustedDevicesViewModel.DirectoryDevice?>(null) }
    var confirmReplace by remember { mutableStateOf(false) }
    var confirmWipe by remember { mutableStateOf(false) }
    var snackbarMsg by remember { mutableStateOf<String?>(null) }
    var nameEditMode by remember { mutableStateOf<String?>(null) }
    var nameEditTarget by remember { mutableStateOf<TrustedDevicesViewModel.DirectoryDevice?>(null) }
    var nameDraft by remember { mutableStateOf("") }
    var nameLocked by remember { mutableStateOf(false) }
    val canManageNames = Keystore.hasAdminRoot()
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

    FSScreen(
        title = "Trusted devices",
        onBack = { nav.popBackStack() },
        actions = { FSBarAction(Icons.Outlined.Refresh, "Refresh", onClick = { vm.load() }) },
    ) {
        FSGroup(header = "Account") {
            FSRow(
                title = accountDisplayName ?: "@${app.currentUser.value.orEmpty()}",
                subtitle = "@${app.currentUser.value.orEmpty()}",
                icon = Icons.Outlined.AccountCircle,
                iconTint = MaterialTheme.colorScheme.primary,
                onClick = if (canManageNames) ({
                    nameEditMode = "account"
                    nameDraft = accountDisplayName.orEmpty()
                    nameLocked = false
                }) else null,
                trailing = if (canManageNames) ({
                    Icon(Icons.Outlined.Edit, contentDescription = "Edit account name", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }) else null,
            )
        }
        // M4 — pending re-pair banner. A replace started on THIS or ANY
        // other device surfaces here with a grace countdown and a
        // "Finalize now" entry into the finalize screen.
        PendingRePairBanner(
            snapshot = pendingRePair,
            onFinalize = { completesAt -> nav.navigate("replace-finalize/$completesAt") },
        )
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSSectionHeader("Trusted devices")
            Text(
                "Phones and tablets that hold your account keys.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = FS.space.s1),
            )
            when (state) {
                is TrustedDevicesViewModel.State.Idle,
                is TrustedDevicesViewModel.State.Loading -> LoadingRow()
                is TrustedDevicesViewModel.State.Failed -> ErrorRow(message = state.reason)
                is TrustedDevicesViewModel.State.Loaded -> {
                    if (state.devices.isEmpty()) {
                        EmptyRow()
                    } else {
                        FSGroup {
                            state.devices.forEachIndexed { idx, d ->
                                TrustedDeviceRow(device = d, onMenu = { sheetTarget = d })
                                if (idx < state.devices.size - 1) FSDivider()
                            }
                        }
                    }
                }
            }
        }
        // Phase 3b — admin entry to the cross-device pairing QR. Adds a
        // collaborator's OWN phone (no shared iCloud); the added device
        // lands quarantined + non-admin.
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSGroup {
                FSRow(
                    title = "Add a device",
                    icon = Icons.Outlined.QrCode2,
                    iconTint = MaterialTheme.colorScheme.primary,
                    titleColor = MaterialTheme.colorScheme.primary,
                    onClick = { nav.navigate("add-device") },
                    modifier = Modifier.semantics { contentDescription = "trusted-devices-add" },
                )
            }
            Text(
                "For your own phones and tablets. To give another person access, use Share this server on the server's page.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = FS.space.s1),
            )
        }
        snackbarMsg?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
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
        ModalBottomSheet(onDismissRequest = { sheetTarget = null }) {
            Column(Modifier.padding(bottom = FS.space.s6)) {
                Column(
                    Modifier.padding(horizontal = FS.space.s6, vertical = FS.space.s2),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(target.displayName, style = MaterialTheme.typography.titleLarge)
                    Text(
                        "${platformDisplay(target.platformClass)} · Device ${target.supportCode}",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                if (target.isCurrent) {
                    FSRow(
                        title = "Rename this device",
                        icon = Icons.Outlined.Edit,
                        onClick = {
                            nameEditMode = "self"
                            nameEditTarget = target
                            nameDraft = target.displayName
                            nameLocked = false
                            sheetTarget = null
                        },
                    )
                }
                if (canManageNames) {
                    FSRow(
                        title = if (target.isManaged) "Edit managed name" else "Set managed name",
                        icon = Icons.Outlined.Shield,
                        onClick = {
                            nameEditMode = "managed"
                            nameEditTarget = target
                            nameDraft = target.displayName
                            nameLocked = target.isLocked
                            sheetTarget = null
                        },
                    )
                    if (target.isManaged) {
                        FSRow(
                            title = "Remove managed name",
                            icon = Icons.Outlined.LockOpen,
                            iconTint = MaterialTheme.colorScheme.error,
                            titleColor = MaterialTheme.colorScheme.error,
                            onClick = {
                                sheetTarget = null
                                scope.launch {
                                    if (!vm.removeManagedName(target.deviceId)) snackbarMsg = "Couldn't remove the managed name."
                                }
                            },
                        )
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                }
                FSRow(
                    title = "Revoke",
                    icon = Icons.Outlined.PhonelinkErase,
                    iconTint = MaterialTheme.colorScheme.error,
                    titleColor = MaterialTheme.colorScheme.error,
                    enabled = !target.isCurrent,
                    onClick = {
                        confirmDisconnect = target
                        sheetTarget = null
                    },
                    modifier = Modifier.semantics { contentDescription = "trusted-device-disconnect" },
                )
                // C7 — Replace device. Tap opens the scare dialog;
                // confirmation drives the ReplaceDeviceViewModel.
                FSRow(
                    title = "Replace device",
                    icon = Icons.Outlined.Sync,
                    iconTint = MaterialTheme.colorScheme.error,
                    titleColor = MaterialTheme.colorScheme.error,
                    enabled = !target.isCurrent,
                    onClick = {
                        confirmReplace = true
                        sheetTarget = null
                    },
                    modifier = Modifier.semantics { contentDescription = "trusted-device-replace" },
                )
                // E5 — Wipe & restart. Live ceremony.
                FSRow(
                    title = "Wipe & restart",
                    icon = Icons.Outlined.DeleteForever,
                    iconTint = MaterialTheme.colorScheme.error,
                    titleColor = MaterialTheme.colorScheme.error,
                    enabled = !target.isCurrent,
                    onClick = {
                        confirmWipe = true
                        sheetTarget = null
                    },
                    modifier = Modifier.semantics { contentDescription = "trusted-device-wipe" },
                )
            }
        }
    }

    nameEditMode?.let { mode ->
        AlertDialog(
            onDismissRequest = { nameEditMode = null },
            title = {
                Text(when (mode) {
                    "account" -> "Edit account name"
                    "self" -> "Rename this device"
                    else -> "Managed device name"
                })
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    OutlinedTextField(
                        value = nameDraft,
                        onValueChange = { nameDraft = it },
                        label = { Text("Display name") },
                        singleLine = true,
                    )
                    if (mode == "managed") {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = nameLocked, onCheckedChange = { nameLocked = it })
                            Text("Lock managed name")
                        }
                    }
                    Text(
                        "Names are encrypted and apply only inside this Flagship account.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = nameDraft.isNotBlank(),
                    onClick = {
                        val target = nameEditTarget
                        nameEditMode = null
                        scope.launch {
                            val ok = when (mode) {
                                "account" -> vm.renameAccount(nameDraft)
                                "self" -> vm.renameCurrentDevice(nameDraft)
                                else -> target?.let { vm.setManagedName(it.deviceId, nameDraft, nameLocked) } ?: false
                            }
                            if (!ok) snackbarMsg = "Couldn't save the encrypted name. Check the name and try again."
                        }
                    },
                ) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { nameEditMode = null }) { Text("Cancel") } },
        )
    }

    // Scare-warning confirmation. "We'll stop sending alerts to <label>.
    // It can sign back in with your passkey."
    confirmDisconnect?.let { target ->
        AlertDialog(
            onDismissRequest = { confirmDisconnect = null },
            title = { Text("Revoke ${target.displayName}?") },
            text = { Text("This revokes the device's account access. Its presentation name is never stored by Flagship's control plane in plaintext.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDisconnect = null
                    scope.launch {
                        val ok = vm.disconnect(target)
                        if (!ok) snackbarMsg = "Couldn't disconnect — check your connection and try again."
                    }
                }) {
                    Text("Revoke", color = MaterialTheme.colorScheme.error)
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
                    "Your account keeps the same username and your servers keep " +
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
                    Text("Wipe and start over", color = MaterialTheme.colorScheme.error)
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
                        "open the app. Servers stay running, apps stay installed. " +
                        "Takes effect after a 24-hour grace window. Your other " +
                        "devices are notified, and only this device can cancel it.",
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
                    Text("Replace device", color = MaterialTheme.colorScheme.error)
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
    FSCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
            Text("Loading devices…", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun ErrorRow(message: String) {
    FSCard {
        Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun EmptyRow() {
    FSGroup {
        FSRow(
            title = "Just this device",
            subtitle = "Sign in on another phone or tablet to add a trusted device.",
            icon = Icons.Outlined.PhoneAndroid,
        )
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

    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Icon(Icons.Outlined.Sync, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Text(
                    "Replace pending",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.semantics { contentDescription = "pending-re-pair-banner" },
                )
            }
            Text(
                if (elapsed) {
                    "The grace window has elapsed — finalize the device replacement now."
                } else {
                    "Replace pending — finalize when the 3-day grace elapses " +
                        "(${formatCompletesAt(pending.completesAt)})."
                },
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
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
}

/** Absolute locale timestamp for the pending-re-pair banner's unlock time
 *  (mirrors the webapp's formatCompletesAt). Kept top-level so a test can
 *  assert the exact shape without Compose scaffolding. */
internal fun formatCompletesAt(ms: Long): String =
    FlagshipDateFormat.format(ms, includeTime = true)

@Composable
private fun TrustedDeviceRow(device: TrustedDevicesViewModel.DirectoryDevice, onMenu: () -> Unit) {
    val lines = buildList {
        add("${platformDisplay(device.platformClass)} · Device ${device.supportCode}")
        if (device.isManaged) {
            add(if (device.isLocked) "Administrator-managed · locked" else "Administrator-managed")
        } else if (device.lastSeenAt > device.createdAt) {
            add("last seen ${relative(device.lastSeenAt)}")
        }
    }
    FSRow(
        title = device.displayName,
        subtitle = lines.joinToString("\n"),
        icon = platformIcon(device.platformClass),
        iconTint = MaterialTheme.colorScheme.primary,
        onClick = onMenu,
        trailing = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                if (device.isCurrent) FSPill("This device", FSPillKind.Online)
                IconButton(
                    onClick = onMenu,
                    modifier = Modifier.semantics {
                        contentDescription = "trusted-device-menu-${device.deviceId}"
                    },
                ) {
                    Icon(Icons.Outlined.MoreVert, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
    )
}

private fun platformIcon(raw: String?): ImageVector = when (raw) {
    "ios" -> Icons.Outlined.PhoneIphone
    "android" -> Icons.Outlined.PhoneAndroid
    "web" -> Icons.Outlined.Language
    "macos" -> Icons.Outlined.Laptop
    else      -> Icons.Outlined.Devices
}

private fun platformDisplay(raw: String?): String = when (raw) {
    "ios" -> "iPhone / iPad"
    "android" -> "Android"
    "web" -> "Web"
    "macos" -> "Mac"
    else -> "Device"
}

private fun relative(ms: Long): String = FlagshipDateFormat.format(ms)
