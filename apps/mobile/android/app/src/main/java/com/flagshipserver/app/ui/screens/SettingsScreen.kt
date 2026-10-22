// Settings landing, organised into the spec S1 six-group taxonomy: Account ·
// Devices · Companions · Web access · Backup & peers · App · Danger zone.
// One tap to any row; mirrors the iOS/webapp grouping.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
import androidx.compose.material.icons.outlined.BrightnessAuto
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import com.flagshipserver.app.ui.components.fsTick
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.FSSettingsRow
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Autorenew
import androidx.compose.material.icons.outlined.Backup
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.LightMode
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.ScreenShare
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Save
import androidx.compose.material.icons.outlined.VpnKey
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import com.flagshipserver.app.core.LocalPrivacySettings
import com.flagshipserver.app.core.LocalPushNotificationsSwitch
import com.flagshipserver.app.core.PushNotificationsSwitch
import com.flagshipserver.app.core.ThemeMode
import com.flagshipserver.app.core.AppIconSwitcher
import com.flagshipserver.app.core.AppIconVariant
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import com.flagshipserver.app.ui.components.AlertDialog
import com.flagshipserver.app.ui.components.Switch
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavController
import com.flagshipserver.app.BuildConfig
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.api.PushTokenRevokeRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.PushTokenRevoke
import com.flagshipserver.app.core.SignOutPolicy
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.FSAnnouncementCard
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSSettingsGroup
import com.flagshipserver.app.ui.components.FSSettingsRowData
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import com.flagshipserver.app.viewmodels.AccountSecurityViewModel
import kotlinx.coroutines.launch

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(nav: NavController) {
    val app = LocalAppState.current
    val privacy = LocalPrivacySettings.current
    val themeMode = privacy?.themeMode?.collectAsState()?.value ?: ThemeMode.AUTO
    val server = LocalFlagshipServerClient.current
    val client = LocalScreensClient.current
    // C6a — drives the Remove-this-device confirmation dialog.
    var showRemoveConfirm by remember { mutableStateOf(false) }
    // Tier 2 — drives the key-wipe Sign-out confirmation dialog. Copy +
    // severity adapt on hasCloudRecovery (a wipe without recovery is
    // permanent account loss, so it gets the danger-zone framing).
    var showSignOutConfirm by remember { mutableStateOf(false) }
    // P14 Phase 2 — companion-requests pending count, fetched once on
    // appearance; drives the badge on the Companion-requests row.
    var companionPending by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        companionPending = runCatching { client.companionPendingWrites() }
            .map { it.pending.size }
            .getOrDefault(0)
    }
    // Optional promo announcement at the top of Settings. Wired but empty
    // by default — flip this on for a campaign without touching the rows.
    // Kept as state so a future dismiss is a one-liner.
    var showPromo by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val hasRecovery by app.hasCloudRecovery.collectAsState()
    val username = app.currentUser.collectAsState().value ?: ""
    // The control plane enforces last-device status. The old public push-token
    // roster is intentionally unavailable and is never used as an identity
    // source for account deletion.
    var isLastDevice by remember { mutableStateOf(false) }

    // Real account type (single vs multi-device + 2FA), read off the Worker
    // `usernames` row via the same VM the Account-security screen uses, so the
    // hero subtitle + the ACCOUNT-security row reflect the live state instead
    // of a recovery-only guess. Null while the load is in flight / on failure.
    val accountSecurity: AccountSecurityViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                AccountSecurityViewModel(
                    server = server,
                    username = { app.currentUser.value },
                )
            }
        },
    )
    val accountType by accountSecurity.accountType.collectAsState()
    LaunchedEffect(username) { accountSecurity.load() }
    // #52 — the Tier-2 sign-out gate. Demo/mock sessions are exempt: they
    // never wrap a real UMK. A passwordless demo ACCOUNT (its profile or pods
    // carry a demoServer block) counts as demo too — it holds no account keys,
    // so the key-backed rows are hidden and Delete account becomes a
    // remove-from-device. A debug gym run on mocks counts as demo; a release
    // build never does (fail-closed: the gate applies).
    val pods by app.pods.collectAsState()
    val profiles by app.profiles.collectAsState()
    val activeCloud by app.activeCloudName.collectAsState()
    val isDemoAccountSession = AppState.isDemoAccount(profiles.firstOrNull { it.cloudName == activeCloud }, pods)
    // Name dibs — the "Claim your .com name" row shows only while the window is open.
    val nameDibsClient = com.flagshipserver.app.core.LocalNameDibsClient.current
    var dibsOpen by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(nameDibsClient) {
        dibsOpen = runCatching { nameDibsClient.window().open }.getOrDefault(false)
    }
    val isMockSession = com.flagshipserver.app.core.Variant.usesMockClients
    val isDemoAccount = isMockSession || isDemoAccountSession
    var showDemoDeleteNotice by remember { mutableStateOf(false) }
    val signOutPolicy = SignOutPolicy.evaluate(
        hasCloudRecovery = hasRecovery,
        isDemoAccount = isDemoAccount,
        isLastDevice = isLastDevice,
    )
    // The recovery-gated buttons ("Sign out" + "Remove this
    // device") stay greyed-but-tappable until recovery is enrolled; a
    // tap-while-greyed surfaces this toast instead of the destructive path.
    val ctx = LocalContext.current
    var iconVariant by remember { mutableStateOf(AppIconSwitcher.current(ctx)) }
    val showRecoveryRequiredToast = {
        Toast.makeText(ctx, FSStrings.get(R.string.set_up_account_recovery_to_use), Toast.LENGTH_LONG).show()
    }
    val sessionGated = signOutPolicy == SignOutPolicy.BLOCKED_NO_RECOVERY

    FSScreen(
        title = stringResource(R.string.settings),
        titleTag = "settings-title",
        subtitle = "@${username.removePrefix("@")}",
        subtitleTag = "settings-cloud-username",
        spacing = FS.space.s6,
    ) {
        // Optional promo slot (empty unless flipped on).
        if (showPromo) {
            FSAnnouncementCard(
                icon = Icons.Outlined.AutoAwesome,
                title = stringResource(R.string.welcome_to_flagship),
                message = stringResource(R.string.your_stuff_on_your_hardware_with),
                onDismiss = { showPromo = false },
            )
        }

        // Settings taxonomy (spec S1), in iOS's order: Account · Devices ·
        // Companions · Web access · Backup & peers · App · session actions ·
        // Danger zone · Developer (hidden) · About.
        FSSettingsGroup(
            header = stringResource(R.string.account),
            rows = listOf(
                // Plan / Subscription: the dedicated tier-status screen (marketplace).
                FSSettingsRowData(
                    icon = Icons.Outlined.CreditCard,
                    title = stringResource(R.string.plan_subscription),
                    subtitle = stringResource(R.string.tier_llm_credits_dispatcher_usage_custom),
                    onClick = { nav.navigate("tier-status") },
                ),
                // Account security leads; the live account type (single vs
                // multi-device + 2FA) rides the subtitle.
                FSSettingsRowData(
                    icon = if (accountType == "multi") Icons.Outlined.VerifiedUser else Icons.Outlined.Shield,
                    iconTint = if (accountType == "multi") FS.colors.success else null,
                    title = stringResource(R.string.account_security),
                    subtitle = when (accountType) {
                        "multi" -> stringResource(R.string.code_protection_on_recovery_needs_a)
                        "single" -> stringResource(R.string.single_device_recovery_is_a_3)
                        else -> stringResource(R.string.single_device_or_code_protection_on)
                    },
                    onClick = { nav.navigate("account-security") },
                    testTag = "settings-open-account-security",
                ),
                FSSettingsRowData(
                    icon = Icons.Outlined.AutoAwesome,
                    title = stringResource(R.string.ai_keys),
                    subtitle = stringResource(R.string.bring_your_own_keys_for_building),
                    onClick = { nav.navigate("ai-keys") },
                    testTag = "settings-ai-keys",
                ),
            ) + (if (dibsOpen && !isDemoAccountSession) listOf(
                FSSettingsRowData(
                    icon = Icons.Outlined.Flag,
                    title = stringResource(R.string.claim_your_com_name),
                    subtitle = stringResource(R.string.own_the_com_the_matching_name),
                    onClick = { nav.navigate("name-dibs") },
                    testTag = "settings-open-name-dibs",
                ),
            ) else emptyList()) + (if (isDemoAccountSession) emptyList() else listOf(
                FSSettingsRowData(
                    icon = Icons.Outlined.VpnKey,
                    title = stringResource(R.string.cloud_recovery),
                    subtitle = stringResource(R.string.recover_on_a_new_device),
                    onClick = { nav.navigate("recovery") },
                    testTag = "settings-cloud-recovery",
                ),
                FSSettingsRowData(
                    icon = Icons.Outlined.Save,
                    title = stringResource(R.string.back_up_account_key),
                    subtitle = stringResource(R.string.save_an_encrypted_key_file),
                    onClick = { nav.navigate("keyfile-export") },
                    testTag = "settings-backup-key",
                ),
            )) + listOf(
                FSSettingsRowData(
                    icon = Icons.Outlined.Cloud,
                    title = stringResource(R.string.profiles),
                    subtitle = stringResource(R.string.switch_between_your_clouds),
                    onClick = { nav.navigate("profiles") },
                    testTag = "settings-profiles",
                ),
            ),
        )

        // The single home for Add / Replace / Wipe / Remove device is the
        // Trusted devices screen, plus the browser sessions list.
        FSSettingsGroup(
            header = stringResource(R.string.devices),
            rows = (if (isDemoAccountSession) emptyList() else listOf(
                FSSettingsRowData(
                    icon = Icons.Outlined.Devices,
                    title = stringResource(R.string.trusted_devices),
                    subtitle = stringResource(R.string.add_replace_or_remove_the_devices),
                    onClick = { nav.navigate("trusted-devices") },
                    testTag = "settings-trusted-devices",
                ),
            )) + listOf(
                // Phase 3b — this phone joins another account (or a second one
                // of yours) by scanning the code that account's device shows.
                FSSettingsRowData(
                    icon = Icons.Outlined.QrCodeScanner,
                    title = stringResource(R.string.scan_a_pairing_code),
                    subtitle = stringResource(R.string.add_this_phone_to_another_account),
                    onClick = { nav.navigate("join-device-scan") },
                    testTag = "settings-scan-pairing-code",
                ),
                FSSettingsRowData(
                    icon = Icons.Outlined.Computer,
                    title = stringResource(R.string.browser_sessions),
                    subtitle = stringResource(R.string.browsers_you_opened_through_remote),
                    onClick = { nav.navigate("paired-sessions") },
                    testTag = "settings-browser-sessions",
                ),
            ),
        )

        FSSettingsGroup(
            header = stringResource(R.string.companions),
            rows = listOf(
                FSSettingsRowData(
                    icon = Icons.Outlined.ScreenShare,
                    title = stringResource(R.string.remote),
                    subtitle = stringResource(R.string.read_only_browser_session_4h),
                    onClick = { nav.navigate("companion-dock") },
                    testTag = "settings-remote",
                ),
                FSSettingsRowData(
                    icon = Icons.Outlined.Inbox,
                    title = stringResource(R.string.companion_requests),
                    subtitle = companionRequestsSubtitle(companionPending),
                    badge = companionPending.takeIf { it > 0 },
                    onClick = { nav.navigate("companion-requests") },
                    testTag = "settings-companion-requests",
                ),
            ),
        )

        FSSettingsGroup(
            header = stringResource(R.string.web_access),
            rows = listOf(
                FSSettingsRowData(
                    icon = Icons.Outlined.Public,
                    title = stringResource(R.string.open_secured_sessions),
                    subtitle = stringResource(R.string.sites_youve_signed_a_browser_into),
                    onClick = { nav.navigate("secured-sessions") },
                    testTag = "settings-secured-sessions",
                ),
                FSSettingsRowData(
                    icon = Icons.Outlined.Link,
                    title = stringResource(R.string.process_url),
                    subtitle = stringResource(R.string.open_a_sign_in_link_you),
                    onClick = { nav.navigate("process-url") },
                    testTag = "settings-process-url",
                ),
            ),
        )

        FSSettingsGroup(
            header = stringResource(R.string.backup_peers),
            rows = listOf(
                FSSettingsRowData(
                    icon = Icons.Outlined.Backup,
                    title = stringResource(R.string.peer_backup),
                    subtitle = stringResource(R.string.shard_health_across_peers),
                    onClick = { nav.navigate("peer-backup") },
                    testTag = "settings-peer-backup",
                ),
            ),
        )

        // One switch for every push to this device (§3a).
        PushNotificationsCard()

        // APP: appearance, app icon, Privacy and About. Appearance writes
        // straight to PrivacySettings; MainActivity applies it app-wide.
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSSectionHeader(stringResource(R.string.app_2))
            FSGroup {
                Column(
                    verticalArrangement = Arrangement.spacedBy(FS.space.s3),
                    modifier = Modifier.padding(FS.space.s4),
                ) {
                    val view = androidx.compose.ui.platform.LocalView.current
                    Text(stringResource(R.string.appearance), style = MaterialTheme.typography.bodyLarge)
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        val modes = listOf(
                            Triple(ThemeMode.LIGHT, stringResource(R.string.light), Icons.Outlined.LightMode),
                            Triple(ThemeMode.DARK, stringResource(R.string.dark), Icons.Outlined.DarkMode),
                            Triple(ThemeMode.AUTO, stringResource(R.string.auto), Icons.Outlined.BrightnessAuto),
                        )
                        modes.forEachIndexed { i, (mode, label, icon) ->
                            SegmentedButton(
                                selected = themeMode == mode,
                                onClick = { view.fsTick(); privacy?.setThemeMode(mode) },
                                shape = SegmentedButtonDefaults.itemShape(index = i, count = modes.size),
                                icon = { SegmentedButtonDefaults.Icon(active = themeMode == mode) { androidx.compose.material3.Icon(icon, contentDescription = null, modifier = Modifier.size(SegmentedButtonDefaults.IconSize)) } },
                                modifier = Modifier.testTag("settings-theme-${mode.name.lowercase()}"),
                            ) { Text(label) }
                        }
                    }
                    Text(stringResource(R.string.app_icon), style = MaterialTheme.typography.bodyLarge)
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        val icons = listOf(AppIconVariant.CLASSIC to stringResource(R.string.classic), AppIconVariant.LEGACY to stringResource(R.string.legacy))
                        icons.forEachIndexed { i, (variant, label) ->
                            SegmentedButton(
                                selected = iconVariant == variant,
                                onClick = {
                                    view.fsTick()
                                    AppIconSwitcher.set(ctx, variant)
                                    iconVariant = variant
                                },
                                shape = SegmentedButtonDefaults.itemShape(index = i, count = icons.size),
                            ) { Text(label) }
                        }
                    }
                }
                FSDivider(inset = 0.dp)
                FSSettingsRow(
                    FSSettingsRowData(
                        icon = Icons.Outlined.Lock,
                        title = stringResource(R.string.privacy),
                        subtitle = stringResource(R.string.app_lock_app_level_gating),
                        onClick = { nav.navigate("privacy") },
                        testTag = "settings-privacy",
                    ),
                )
                FSDivider()
                // About — Android has no separate About screen: the version
                // line at the foot of this page is the About surface.
                FSSettingsRow(
                    FSSettingsRowData(
                        icon = Icons.Outlined.Info,
                        title = stringResource(R.string.about_flagship),
                        subtitle = fsString(R.string.busl_1_1_patent_pending, productAboutLine(BuildConfig.VERSION_NAME, BuildConfig.PRODUCT_LABEL, BuildConfig.VERSION_CODE)),
                        showsChevron = false,
                        onClick = {},
                    ),
                )
            }
        }

        // The three-tier "leave the app" cluster, ordered by increasing
        // severity (mirror of iOS SettingsScreen.sessionActions). Tier 3
        // (Remove this device) lives in the danger zone just below.
        //
        //   - LOCK (tier 1): re-gate behind BiometricPrompt. Removes
        //     NOTHING — no network, the key + session stay in the
        //     AndroidKeyStore. Cheapest; re-entry is the lock screen.
        //   - SIGN OUT (tier 2): erase this device's local key material
        //     from the Keystore WITHOUT revoking server-side. Re-entry is a
        //     recovery sign-in that restores the SAME key. Gated on cloud
        //     recovery — see the confirmation dialog below.
        //
        // Both share one box and one look (owner, 2026-10-15); the sign-out
        // confirmation carries the warning.
        FSCard {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                com.flagshipserver.app.ui.components.FSSecondaryButton(
                    label = stringResource(R.string.lock_the_app),
                    onClick = {
                        // Tier 1 — LOCK. Re-gate behind biometrics with zero side
                        // effects: no network, the key + session stay in the
                        // Keystore. Re-entry is the BiometricLockScreen.
                        app.lock()
                    },
                    block = true,
                    large = true,
                    modifier = Modifier.testTag("settings-lock-btn"),
                )
                FSDangerButton(
                    label = stringResource(R.string.sign_out_2),
                    muted = sessionGated,
                    onClick = {
                        when {
                            sessionGated -> showRecoveryRequiredToast()
                            signOutPolicy == SignOutPolicy.DELETION_CEREMONY -> nav.navigate("delete-account")
                            else -> showSignOutConfirm = true
                        }
                    },
                    block = true,
                    large = true,
                    modifier = Modifier.testTag("settings-sign-out-btn"),
                )
            }
        }

        // C6a — danger zone, boxed like a server page's. The confirmations
        // carry the warnings; their copy adapts to whether cloud recovery is
        // enrolled. Delete account opens the guarded deletion ceremony.
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSSectionHeader(stringResource(R.string.danger_zone))
            FSCard {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                    FSDangerButton(
                        label = stringResource(R.string.remove_this_device_from_account),
                        muted = sessionGated,
                        onClick = {
                            when {
                                sessionGated -> showRecoveryRequiredToast()
                                signOutPolicy == SignOutPolicy.DELETION_CEREMONY -> nav.navigate("delete-account")
                                else -> showRemoveConfirm = true
                            }
                        },
                        block = true,
                        modifier = Modifier.testTag("settings-remove-device-btn"),
                    )
                    FSDangerButton(
                        label = stringResource(R.string.delete_account),
                        onClick = {
                            if (isDemoAccountSession) showDemoDeleteNotice = true else nav.navigate("delete-account")
                        },
                        block = true,
                        modifier = Modifier.testTag("settings-delete-account-btn"),
                    )
                }
            }
        }

        if (showDemoDeleteNotice) {
            AlertDialog(
                onDismissRequest = { showDemoDeleteNotice = false },
                confirmButton = {
                    TextButton(onClick = {
                        showDemoDeleteNotice = false
                        Keystore.wipe()
                        app.signOut()
                    }) {
                        Text(stringResource(R.string.remove_from_this_device), color = FS.colors.danger)
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showDemoDeleteNotice = false }) {
                        Text(stringResource(R.string.cancel))
                    }
                },
                title = { Text(stringResource(R.string.demo_account)) },
                text = {
                    Text(
                        stringResource(R.string.this_demo_account_is_managed_by),
                    )
                },
                modifier = Modifier.testTag("settings-demo-delete-notice"),
            )
        }

        if (showRemoveConfirm) {
            // A device that holds the admin key or a server session says what removing it costs, first
            // (docs/account-gone.md); dismissing that dialog is never a choice.
            val removeSessions = com.flagshipserver.app.core.LocalSessionStore.current
            val removalWarning = com.flagshipserver.app.core.AdminKeyWarning.needsRemovalWarning(
                holdsAdminRoot = com.flagshipserver.app.core.Variant.forceAdminRoot || Keystore.hasAdminRoot(),
                holdsServerSession = removeSessions.podTokenIds().isNotEmpty(),
            )
            AlertDialog(
                onDismissRequest = { if (!removalWarning) showRemoveConfirm = false },
                confirmButton = {
                    TextButton(onClick = {
                        showRemoveConfirm = false
                        scope.launch {
                            // Best-effort push revoke (network failure OR a
                            // declined biometric tolerated — local wipe still
                            // proceeds). Revoke is IRK-signed (SEC): sign the
                            // envelope so .com verifies against the token
                            // owner's registered IRK before deleting it.
                            val tokenId = Keystore.pushTokenId()
                            if (!tokenId.isNullOrEmpty()) {
                                runCatching {
                                    val irk = Keystore.deriveIRK(reason = FSStrings.get(R.string.remove_this_device_from_flagship))
                                    val issuedAt = System.currentTimeMillis()
                                    val canonical = PushTokenRevoke.canonicalBytes(tokenId = tokenId, issuedAt = issuedAt)
                                    server.revokePushToken(
                                        PushTokenRevokeRequest(
                                            request = PushTokenRevokeRequest.Inner(tokenId = tokenId, issuedAt = issuedAt),
                                            signature = HexUtil.encode(irk.sign(canonical)),
                                        ),
                                    )
                                }
                            }
                            Keystore.wipe()
                            Keystore.setPushTokenId(null)
                            app.signOut()
                        }
                    }) {
                        Text(
                            if (removalWarning) com.flagshipserver.app.core.AdminKeyWarning.REMOVE_ANYWAY else stringResource(R.string.remove_this_device),
                            color = FS.colors.danger,
                            modifier = Modifier.testTag("settings-remove-confirm"),
                        )
                    }
                },
                dismissButton = {
                    if (removalWarning) {
                        TextButton(
                            onClick = { showRemoveConfirm = false; nav.navigate("keyfile-export") },
                            modifier = Modifier.testTag("settings-remove-save-first"),
                        ) { Text(com.flagshipserver.app.core.AdminKeyWarning.SAVE_FIRST) }
                    } else {
                        TextButton(onClick = { showRemoveConfirm = false }) {
                            Text(stringResource(R.string.cancel))
                        }
                    }
                },
                title = {
                    Text(
                        if (removalWarning) com.flagshipserver.app.core.AdminKeyWarning.REMOVE_TITLE
                        else if (hasRecovery) stringResource(R.string.remove_this_device_from_your_account)
                        else stringResource(R.string.permanently_remove_this_device),
                    )
                },
                text = {
                    Text(
                        if (removalWarning) com.flagshipserver.app.core.AdminKeyWarning.REMOVE_MESSAGE
                        else if (hasRecovery)
                            stringResource(R.string.well_revoke_this_devices_notification_access)
                        else
                            stringResource(R.string.you_have_no_cloud_recovery_on),
                    )
                },
            )
        }

        if (showSignOutConfirm) {
            // Only reachable when recovery is enrolled (or in demo mode) —
            // the "Sign out" button is greyed and routes to a
            // toast otherwise.
            val keyFileWritten = com.flagshipserver.app.core.KeyBackupStore.isWritten(ctx, username)
            val adminWarning = com.flagshipserver.app.core.AdminKeyWarning.signOut(
                isAdminDevice = com.flagshipserver.app.core.Variant.forceAdminRoot || Keystore.hasAdminRoot(),
                keyFileWritten = keyFileWritten,
            )
            val doSignOut = {
                showSignOutConfirm = false
                // Tier 2 — SIGN OUT. Erase this device's local key
                // material from the Keystore (snoop-hardening at
                // rest) but DO NOT revoke server-side: the device
                // stays a valid account member, so signing back in
                // via recovery restores the SAME IRK and re-pairs
                // instantly. Deliberately NO push-token revoke —
                // that's a server mutation reserved for the
                // danger-zone eviction below.
                //
                // #52 — ACTION-LAYER gate (not just UI): re-evaluate
                // the policy at wipe time so no code path can erase
                // the only copy of the identity key. Demo/mock
                // sessions are exempt (they never wrap a real UMK).
                if (SignOutPolicy.evaluate(
                        hasCloudRecovery = hasRecovery,
                        isDemoAccount = isDemoAccount,
                        isLastDevice = isLastDevice,
                    ) == SignOutPolicy.ALLOWED
                ) {
                    Keystore.wipe()
                    app.signOut()
                }
            }
            val notBackedUp = adminWarning == com.flagshipserver.app.core.AdminKeyWarning.SignOutWarning.NotBackedUp
            // An admin device that has not written its key file is told to save first; dismissing
            // the dialog is never a choice there (docs/account-gone.md).
            AlertDialog(
                onDismissRequest = { if (!notBackedUp) showSignOutConfirm = false },
                confirmButton = {
                    TextButton(
                        onClick = doSignOut,
                        modifier = Modifier.testTag("settings-sign-out-confirm"),
                    ) {
                        Text(
                            if (notBackedUp) com.flagshipserver.app.core.AdminKeyWarning.SIGN_OUT_ANYWAY else stringResource(R.string.sign_out_2),
                            color = FS.colors.danger,
                        )
                    }
                },
                dismissButton = {
                    if (notBackedUp) {
                        TextButton(
                            onClick = { showSignOutConfirm = false; nav.navigate("keyfile-export") },
                            modifier = Modifier.testTag("settings-sign-out-save-first"),
                        ) { Text(com.flagshipserver.app.core.AdminKeyWarning.SAVE_FIRST) }
                    } else {
                        TextButton(onClick = { showSignOutConfirm = false }) { Text(stringResource(R.string.cancel)) }
                    }
                },
                title = { Text(com.flagshipserver.app.core.AdminKeyWarning.SIGN_OUT_TITLE) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                        when (adminWarning) {
                            null -> Text(
                                stringResource(R.string.this_erases_this_devices_account_key),
                            )
                            com.flagshipserver.app.core.AdminKeyWarning.SignOutWarning.NotBackedUp -> Text(
                                com.flagshipserver.app.core.AdminKeyWarning.SIGN_OUT_NOT_BACKED_UP,
                                modifier = Modifier.testTag("settings-sign-out-admin-warning"),
                            )
                            com.flagshipserver.app.core.AdminKeyWarning.SignOutWarning.BackedUp -> Text(
                                com.flagshipserver.app.core.AdminKeyWarning.SIGN_OUT_BACKED_UP,
                                modifier = Modifier.testTag("settings-sign-out-admin-warning"),
                            )
                        }
                    }
                },
            )
        }

    }
}

/** P14 Phase 2 — Companion-requests row subtitle, mirroring iOS's
 *  companionRequestsSubtitle. */
private fun companionRequestsSubtitle(pending: Int): String = when {
    pending == 0 -> FSStrings.get(R.string.approve_writes_from_remote_browsers)
    pending == 1 -> "1 pending write from a remote browser."
    else -> FSStrings.get(R.string.pending_writes_from_remote_browsers, pending)
}

/** Settings → Push notifications: on by default; off drops this device's
 *  push registration and tells every box to send no access-request push. */
@Composable
private fun PushNotificationsCard() {
    val pushSwitch = LocalPushNotificationsSwitch.current ?: return
    val on by pushSwitch.enabled.collectAsState()
    FSGroup(header = stringResource(R.string.notifications)) {
        FSRow(
            title = PushNotificationsSwitch.TITLE,
            subtitle = PushNotificationsSwitch.SUBTEXT,
            icon = Icons.Outlined.Notifications,
            onClick = { pushSwitch.toggle(!on) },
            trailing = {
                Switch(
                    checked = on,
                    onCheckedChange = { v -> pushSwitch.toggle(v) },
                    modifier = Modifier.testTag("settings-push-notifications"),
                )
            },
        )
    }
}
