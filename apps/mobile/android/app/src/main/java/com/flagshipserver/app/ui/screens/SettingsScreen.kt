// Settings landing. Routes to providers, recovery, paired sessions,
// add-control-device, developer pane.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalDeveloperSettings
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.SignOutPolicy
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.FSAnnouncementCard
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSProfileCard
import com.flagshipserver.app.ui.components.FSSettingsGroup
import com.flagshipserver.app.ui.components.FSSettingsRowData
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(nav: NavController) {
    val app = LocalAppState.current
    val dev = LocalDeveloperSettings.current
    val server = LocalFlagshipServerClient.current
    val client = LocalScreensClient.current
    val devUnlocked = dev?.unlocked?.collectAsState()?.value ?: false
    var versionTaps by remember { mutableIntStateOf(0) }
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
    // #52 — the Tier-2 sign-out gate. Demo/mock sessions (the mock screens
    // client, i.e. !useLiveClient) are exempt: they never wrap a real UMK.
    // Absent DeveloperSettings ⇒ NOT demo (fail-closed: the gate applies).
    val isDemoAccount = dev?.useLiveClient?.collectAsState()?.value?.let { !it } ?: false
    val signOutPolicy = SignOutPolicy.evaluate(
        hasCloudRecovery = hasRecovery,
        isDemoAccount = isDemoAccount,
    )

    // Account-type one-liner under the username on the profile hero. We
    // don't yet surface a multi/single account-type flag on Android, so
    // we lean on the recovery state we already hold (mirrors iOS's
    // default "Tap to manage account security" framing).
    val profileSubtitle = if (hasRecovery)
        "Cloud recovery on · Tap to manage account security"
    else
        "Tap to manage account security"

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      // Reading column — clamp + center on expanded panes; a no-op on phones.
      Column(
        Modifier
            .widthIn(max = FSLayout.readingMaxWidth)
            .fillMaxWidth()
            .padding(horizontal = FS.space.s6),
      ) {
        Spacer(Modifier.height(FS.space.s8))

        // Account hero — teal monogram + username + account subtitle.
        // Drills into Account security (the most relevant account-level
        // destination), reusing the existing nav target.
        FSProfileCard(
            name = username,
            subtitle = profileSubtitle,
            onClick = { nav.navigate("account-security") },
        )

        // Optional promo slot (empty unless flipped on).
        if (showPromo) {
            Spacer(Modifier.height(FS.space.s4))
            FSAnnouncementCard(
                icon = "✦",
                title = "Welcome to Flagship",
                message = "Your stuff, on your hardware, with a real green padlock.",
                onDismiss = { showPromo = false },
            )
        }

        Spacer(Modifier.height(FS.space.s6))

        // P7 + account-security: subscription/tier, providers, security.
        FSSettingsGroup(
            header = "ACCOUNT",
            rows = listOf(
                // P7 — dedicated tier-status / subscription screen.
                FSSettingsRowData(
                    icon = "💳",
                    title = "Plan / Subscription",
                    subtitle = "Tier, LLM credits, dispatcher usage, custom domains.",
                    onClick = { nav.navigate("tier-status") },
                ),
                FSSettingsRowData(
                    icon = "🔑",
                    title = "AI providers",
                    subtitle = "BYO LLM provider keys (Anthropic, OpenAI, Google…).",
                    onClick = { nav.navigate("providers") },
                ),
                // v1.2 Phase 4 — Account security badge + drill-down.
                FSSettingsRowData(
                    icon = "🛡",
                    title = "Account security",
                    subtitle = "Single-device vs multi-device + 2FA.",
                    onClick = { nav.navigate("account-security") },
                ),
            ),
        )

        Spacer(Modifier.height(FS.space.s4))

        // Devices + recovery cluster.
        FSSettingsGroup(
            header = "DEVICES & RECOVERY",
            rows = listOf(
                FSSettingsRowData(
                    icon = "📱",
                    title = "Trusted devices",
                    subtitle = "Phones and tablets that hold your account keys.",
                    onClick = { nav.navigate("trusted-devices") },
                ),
                FSSettingsRowData(
                    icon = "🖥",
                    title = "Browser sessions",
                    subtitle = "Per-pod browser tabs paired with this account.",
                    onClick = { nav.navigate("paired-sessions") },
                ),
                FSSettingsRowData(
                    icon = "➕",
                    title = "Add a control device",
                    subtitle = "Pair a browser or tablet with the current account.",
                    onClick = { nav.navigate("add-control-device") },
                ),
                FSSettingsRowData(
                    icon = "♻",
                    title = "Recovery",
                    subtitle = "Cloud recovery + offline recovery codes.",
                    onClick = { nav.navigate("recovery") },
                ),
                FSSettingsRowData(
                    icon = "💾",
                    title = "Back up your account key",
                    subtitle = "Save an encrypted key file to recover or move your account.",
                    onClick = { nav.navigate("keyfile-export") },
                ),
                FSSettingsRowData(
                    icon = "☁",
                    title = "Profiles",
                    subtitle = "Switch between your clouds.",
                    onClick = { nav.navigate("profiles") },
                ),
            ),
        )

        Spacer(Modifier.height(FS.space.s4))

        // Companion + peer-backup + privacy cluster.
        FSSettingsGroup(
            header = "SHARING & BACKUP",
            rows = listOf(
                // P14 — companion-dock: mint a 60s pairing ticket → 4h read-only browser.
                FSSettingsRowData(
                    icon = "🖥",
                    title = "Dock a browser",
                    subtitle = "Scan a one-time QR for a 4-hour read-only desktop view.",
                    onClick = { nav.navigate("companion-dock") },
                ),
                // P14 Phase 2 — companion-requests inbox. Badge reflects
                // the pending count fetched once when this screen appears.
                FSSettingsRowData(
                    icon = "📥",
                    title = "Companion requests",
                    subtitle = companionRequestsSubtitle(companionPending),
                    badge = companionPending.takeIf { it > 0 },
                    onClick = { nav.navigate("companion-requests") },
                ),
                // P9 — peer-backup management.
                FSSettingsRowData(
                    icon = "🗄",
                    title = "Peer-backup",
                    subtitle = "Shard health across peers + repair status.",
                    onClick = { nav.navigate("peer-backup") },
                ),
                FSSettingsRowData(
                    icon = "🔒",
                    title = "Privacy",
                    subtitle = "Face unlock at launch, app-level gating.",
                    onClick = { nav.navigate("privacy") },
                ),
            ),
        )

        if (devUnlocked) {
            Spacer(Modifier.height(FS.space.s4))
            FSSettingsGroup(
                header = "DEVELOPER",
                rows = listOf(
                    FSSettingsRowData(
                        icon = "🛠",
                        title = "Developer",
                        subtitle = "Toggle the live screens client + dev fixtures.",
                        onClick = { nav.navigate("developer") },
                    ),
                ),
            )
        }

        Spacer(Modifier.height(FS.space.s6))

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Column {
                Text(
                    "Flagship Android",
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
                )
                Text(
                    "v0.0.1 · BUSL-1.1",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp),
                    modifier = Modifier
                        .padding(top = FS.space.s1),
                )
                FSGhostButton(
                    label = if (devUnlocked) "Developer unlocked" else "Tap version to unlock developer",
                    onClick = {
                        versionTaps += 1
                        if (versionTaps >= 3) dev?.setUnlocked(true)
                    },
                )
            }
        }

        Spacer(Modifier.height(FS.space.s6))

        // The three-tier "leave the app" cluster, ordered by increasing
        // severity (mirror of iOS SettingsScreen.sessionActions). Tier 3
        // (Remove this device) lives in the danger zone just below.
        //
        //   - LOCK (tier 1): re-gate behind BiometricPrompt. Removes
        //     NOTHING — no network, the key + session stay in the
        //     AndroidKeyStore. Cheapest; re-entry is the lock screen.
        //   - SIGN OUT (tier 2): erase this device's local key material
        //     from the Keystore WITHOUT revoking server-side. The device
        //     stays a valid account member; this just hardens against an
        //     at-rest / memory snoop while signed out. Re-entry is a
        //     recovery sign-in that restores the SAME key (instant
        //     re-pair, no rotation). Gated on cloud recovery — see the
        //     confirmation dialog below.
        Text(
            "Locks Flagship behind biometrics. Nothing is removed and your " +
                "servers keep running — just hides the screen until you unlock.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
        )
        Spacer(Modifier.height(FS.space.s2))
        FSGhostButton(
            label = "Lock",
            onClick = {
                // Tier 1 — LOCK. Re-gate behind biometrics with zero side
                // effects: no network, the key + session stay in the
                // Keystore. Re-entry is the BiometricLockScreen.
                app.lock()
            },
            block = true,
        )
        Spacer(Modifier.height(FS.space.s4))
        Text(
            when {
                signOutPolicy == SignOutPolicy.BLOCKED_NO_RECOVERY ->
                    "Sign out is disabled until you set up cloud recovery — this " +
                        "device holds the only copy of your account key, and erasing " +
                        "it would permanently lose access."
                hasRecovery ->
                    "Erases this device's account key from the Keystore so nothing's " +
                        "left at rest while you're signed out. Sign back in with your " +
                        "recovery passkey to restore it — your account and servers stay put."
                else ->
                    "Erases this device's account key. ⚠️ You have NO cloud recovery — " +
                        "this would permanently lose access."
            },
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
        )
        Spacer(Modifier.height(FS.space.s2))
        FSDangerButton(
            label = "Sign out",
            onClick = { showSignOutConfirm = true },
            block = true,
        )

        Spacer(Modifier.height(FS.space.s6))

        // C6a — danger zone. Same UX semantics as iOS SettingsScreen
        // dangerZone(): two-stage confirm, copy adapts based on
        // whether cloud recovery is enrolled. Strictly destructive —
        // revokes the push token on .com AND wipes local Keystore.
        Text(
            "DANGER ZONE",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
        )
        Spacer(Modifier.height(FS.space.s2))
        Text(
            if (hasRecovery)
                "Remove this device from your account. You'll need your recovery passkey to come back."
            else
                "Remove this device from your account. ⚠️ You have NO cloud recovery " +
                    "enrolled — this will permanently lose access.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
        )
        Spacer(Modifier.height(FS.space.s2))
        FSDangerButton(
            label = "Remove this device from account",
            onClick = { showRemoveConfirm = true },
            block = true,
        )

        if (showRemoveConfirm) {
            AlertDialog(
                onDismissRequest = { showRemoveConfirm = false },
                confirmButton = {
                    TextButton(onClick = {
                        showRemoveConfirm = false
                        scope.launch {
                            // Best-effort push revoke (network failure
                            // tolerated — local wipe still proceeds).
                            val tokenId = Keystore.pushTokenId()
                            if (!tokenId.isNullOrEmpty()) {
                                runCatching { server.revokePushToken(tokenId) }
                            }
                            Keystore.wipe()
                            Keystore.setPushTokenId(null)
                            app.signOut()
                        }
                    }) {
                        Text("Remove this device", color = FS.colors.danger)
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showRemoveConfirm = false }) {
                        Text("Cancel")
                    }
                },
                title = {
                    Text(
                        if (hasRecovery) "Remove this device from your account?"
                        else "Permanently remove this device?",
                    )
                },
                text = {
                    Text(
                        if (hasRecovery)
                            "We'll revoke this device's notification access and erase its local keys. " +
                                "Use your recovery passkey to sign in again later."
                        else
                            "You have no cloud recovery on this account. After removal, no other " +
                                "device can take over — your account is gone for good. Set up " +
                                "recovery first if you might want to come back.",
                    )
                },
            )
        }

        if (showSignOutConfirm) {
            if (signOutPolicy == SignOutPolicy.BLOCKED_NO_RECOVERY) {
                // #52 — without cloud recovery a key-wipe sign-out is
                // permanent account loss, so there is NO destructive
                // proceed at all: the only forward action routes into
                // the existing recovery-enrollment screen.
                AlertDialog(
                    onDismissRequest = { showSignOutConfirm = false },
                    confirmButton = {
                        TextButton(onClick = {
                            showSignOutConfirm = false
                            nav.navigate("recovery")
                        }) {
                            Text("Set up recovery", color = FS.colors.primary)
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { showSignOutConfirm = false }) {
                            Text("Cancel")
                        }
                    },
                    title = { Text("Set up recovery first") },
                    text = {
                        Text(
                            "Enroll cloud recovery first — signing out now would " +
                                "permanently lose access to this account. This device " +
                                "holds the only copy of your account key.",
                        )
                    },
                )
            } else {
                AlertDialog(
                    onDismissRequest = { showSignOutConfirm = false },
                    confirmButton = {
                        TextButton(onClick = {
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
                                ) == SignOutPolicy.ALLOWED
                            ) {
                                Keystore.wipe()
                                app.signOut()
                            }
                        }) {
                            Text("Sign out", color = FS.colors.danger)
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { showSignOutConfirm = false }) {
                            Text("Cancel")
                        }
                    },
                    title = { Text("Sign out of this device?") },
                    text = {
                        Text(
                            "This erases this device's account key from the Keystore so " +
                                "nothing sensitive is left at rest while you're signed out. " +
                                "Your account and your servers are untouched — sign back in " +
                                "with your recovery passkey and the same key is restored, no re-pair.",
                        )
                    },
                )
            }
        }

        Spacer(Modifier.height(FS.space.s12))
      }
    }
}

/** P14 Phase 2 — Companion-requests row subtitle, mirroring iOS's
 *  companionRequestsSubtitle. */
private fun companionRequestsSubtitle(pending: Int): String = when {
    pending == 0 -> "Approve writes from docked browsers."
    pending == 1 -> "1 pending write from a docked browser."
    else -> "$pending pending writes from docked browsers."
}
