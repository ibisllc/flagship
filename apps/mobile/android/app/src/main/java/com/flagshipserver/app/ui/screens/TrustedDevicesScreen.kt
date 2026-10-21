// Trusted devices = peer-class devices on the user's account (push-
// token holders). Mirror of FlagshipUI/Screens/SettingsScreen.swift's
// "TRUSTED DEVICES" section, extracted into its own NavHost
// destination on Android because the Material 3 idiom is a list
// screen + ModalBottomSheet for per-row actions, rather than a
// stacked section inside Settings.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import android.app.Activity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.ui.platform.testTag
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
import com.flagshipserver.app.ui.components.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.IconButton
import com.flagshipserver.app.ui.components.ModalBottomSheet
import com.flagshipserver.app.ui.components.OutlinedTextField
import androidx.compose.material3.Checkbox
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
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
        title = stringResource(R.string.trusted_devices),
        onBack = { nav.popBackStack() },
        actions = { FSBarAction(Icons.Outlined.Refresh, stringResource(R.string.refresh), onClick = { vm.load() }) },
    ) {
        FSGroup(header = stringResource(R.string.account)) {
            FSRow(
                title = accountDisplayName ?: "@${app.currentUser.value.orEmpty()}",
                subtitle = "@${app.currentUser.value.orEmpty()}",
                icon = Icons.Outlined.AccountCircle,
                iconTint = FS.colors.accent,
                onClick = if (canManageNames) ({
                    nameEditMode = "account"
                    nameDraft = accountDisplayName.orEmpty()
                    nameLocked = false
                }) else null,
                trailing = if (canManageNames) ({
                    Icon(Icons.Outlined.Edit, contentDescription = stringResource(R.string.edit_account_name), tint = MaterialTheme.colorScheme.onSurfaceVariant)
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
            FSSectionHeader(stringResource(R.string.trusted_devices))
            Text(
                stringResource(R.string.phones_and_tablets_that_hold_your),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = FS.space.s1),
            )
            when (state) {
                is TrustedDevicesViewModel.State.Idle,
                is TrustedDevicesViewModel.State.Loading -> LoadingRow()
                is TrustedDevicesViewModel.State.Failed -> ErrorRow(message = state.reason, onRetry = { vm.load() })
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
        val canAddDevice = com.flagshipserver.app.core.AddServerGate.allowsAddDevice(app)
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSGroup {
                FSRow(
                    title = stringResource(R.string.add_a_device),
                    icon = Icons.Outlined.QrCode2,
                    iconTint = if (canAddDevice) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    titleColor = if (canAddDevice) FS.colors.accentText else MaterialTheme.colorScheme.onSurfaceVariant,
                    onClick = { nav.navigate("add-device") },
                    enabled = canAddDevice,
                    modifier = Modifier.semantics { contentDescription = "trusted-devices-add" },
                )
            }
            if (!canAddDevice) {
                Text(
                    com.flagshipserver.app.core.AddServerGate.ADD_DEVICE_ADMIN_ONLY,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = FS.space.s1).semantics { contentDescription = "trusted-devices-add-admin-only" },
                )
            }
            Text(
                stringResource(R.string.for_your_own_phones_and_tablets),
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
                        fsString(R.string.device, platformDisplay(target.platformClass), target.supportCode),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                if (target.isCurrent) {
                    FSRow(
                        title = stringResource(R.string.rename_this_device),
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
                        title = if (target.isManaged) stringResource(R.string.edit_managed_name) else stringResource(R.string.set_managed_name),
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
                            title = stringResource(R.string.remove_managed_name),
                            icon = Icons.Outlined.LockOpen,
                            iconTint = MaterialTheme.colorScheme.error,
                            titleColor = MaterialTheme.colorScheme.error,
                            onClick = {
                                sheetTarget = null
                                scope.launch {
                                    if (!vm.removeManagedName(target.deviceId)) snackbarMsg = FSStrings.get(R.string.couldnt_remove_the_managed_name)
                                }
                            },
                        )
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                }
                FSRow(
                    title = stringResource(R.string.revoke_2),
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
                    title = stringResource(R.string.replace_device),
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
                    title = stringResource(R.string.wipe_restart),
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
                    "account" -> stringResource(R.string.edit_account_name)
                    "self" -> stringResource(R.string.rename_this_device)
                    else -> stringResource(R.string.managed_device_name)
                })
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    OutlinedTextField(
                        value = nameDraft,
                        onValueChange = { nameDraft = it },
                        label = { Text(stringResource(R.string.display_name)) },
                        singleLine = true,
                    )
                    if (mode == "managed") {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = nameLocked, onCheckedChange = { nameLocked = it })
                            Text(stringResource(R.string.lock_managed_name))
                        }
                    }
                    Text(
                        stringResource(R.string.names_are_encrypted_and_apply_only),
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
                            if (!ok) snackbarMsg = FSStrings.get(R.string.couldnt_save_the_encrypted_name_check)
                        }
                    },
                ) { Text(stringResource(R.string.save)) }
            },
            dismissButton = { TextButton(onClick = { nameEditMode = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }

    // Scare-warning confirmation. "We'll stop sending alerts to <label>.
    // It can sign back in with your passkey."
    confirmDisconnect?.let { target ->
        AlertDialog(
            onDismissRequest = { confirmDisconnect = null },
            title = { Text(fsString(R.string.revoke, target.displayName)) },
            text = { Text(stringResource(R.string.this_revokes_the_devices_account_access)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmDisconnect = null
                    scope.launch {
                        val ok = vm.disconnect(target)
                        if (!ok) snackbarMsg = FSStrings.get(R.string.couldnt_disconnect_check_your_connection_and)
                    }
                }) {
                    Text(stringResource(R.string.revoke_2), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDisconnect = null }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }

    // E5 — Wipe & restart scare dialog.
    if (confirmWipe) {
        AlertDialog(
            onDismissRequest = { confirmWipe = false },
            title = { Text(stringResource(R.string.wipe_and_start_over)) },
            text = {
                Text(
                    stringResource(R.string.your_account_keeps_the_same_username),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmWipe = false
                    scope.launch {
                        wipeVm.run(currentEtag = vm.etag.value)
                        when (val phase = wipeVm.phase.value) {
                            com.flagshipserver.app.viewmodels.WipeRestartPhase.Completed -> {
                                snackbarMsg = FSStrings.get(R.string.done_all_other_devices_are_now)
                                // Drop to Welcome — current session is stale.
                                app.signOut()
                            }
                            is com.flagshipserver.app.viewmodels.WipeRestartPhase.Failed ->
                                snackbarMsg = phase.message
                            else -> Unit
                        }
                    }
                }) {
                    Text(stringResource(R.string.wipe_and_start_over_2), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmWipe = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }

    // C7 — Replace device scare dialog. Same UX shape as iOS B7.
    if (confirmReplace) {
        AlertDialog(
            onDismissRequest = { confirmReplace = false },
            title = { Text(stringResource(R.string.replace_this_device)) },
            text = {
                Text(
                    stringResource(R.string.rotates_your_accounts_identity_key_other),
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
                    Text(stringResource(R.string.replace_device), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmReplace = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

@Composable
private fun LoadingRow() {
    FSCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
            Text(stringResource(R.string.loading_devices), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun ErrorRow(message: String, onRetry: () -> Unit) {
    FSCard(modifier = Modifier.testTag("trusted-devices-error")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            com.flagshipserver.app.ui.components.FSSecondaryButton(label = stringResource(R.string.try_again), onClick = onRetry, modifier = Modifier.testTag("trusted-devices-retry"))
        }
    }
}

@Composable
private fun EmptyRow() {
    FSGroup {
        FSRow(
            title = stringResource(R.string.just_this_device),
            subtitle = stringResource(R.string.sign_in_on_another_phone_or),
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
                Icon(Icons.Outlined.Sync, contentDescription = null, tint = FS.colors.accent)
                Text(
                    stringResource(R.string.replace_pending),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.semantics { contentDescription = "pending-re-pair-banner" },
                )
            }
            Text(
                if (elapsed) {
                    stringResource(R.string.the_grace_window_has_elapsed_finalize)
                } else {
                    fsString(R.string.replace_pending_finalize_when_the_3, formatCompletesAt(pending.completesAt))
                },
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.semantics { contentDescription = "pending-re-pair-banner-body" },
            )
            FSPrimaryButton(
                label = stringResource(R.string.finalize_now),
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
        add(fsString(R.string.device, platformDisplay(device.platformClass), device.supportCode))
        if (device.isManaged) {
            add(if (device.isLocked) stringResource(R.string.administrator_managed_locked) else stringResource(R.string.administrator_managed))
        } else if (device.lastSeenAt > device.createdAt) {
            add(fsString(R.string.last_seen, relative(device.lastSeenAt)))
        }
    }
    FSRow(
        title = device.displayName,
        subtitle = lines.joinToString("\n"),
        icon = platformIcon(device.platformClass),
        iconTint = FS.colors.accent,
        onClick = onMenu,
        trailing = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                if (device.isCurrent) FSPill(stringResource(R.string.this_device), FSPillKind.Online)
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
    "web" -> FSStrings.get(R.string.web)
    "macos" -> FSStrings.get(R.string.mac)
    else -> FSStrings.get(R.string.device_2)
}

private fun relative(ms: Long): String = FlagshipDateFormat.format(ms)
