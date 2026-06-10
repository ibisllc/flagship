// Settings landing. Routes to providers, recovery, paired sessions,
// add-control-device, developer pane.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.core.CertValidityStore
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalDeveloperSettings
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.SignOutPolicy
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(nav: NavController) {
    val app = LocalAppState.current
    val dev = LocalDeveloperSettings.current
    val server = LocalFlagshipServerClient.current
    val devUnlocked = dev?.unlocked?.collectAsState()?.value ?: false
    var versionTaps by remember { mutableIntStateOf(0) }
    // C6a — drives the Remove-this-device confirmation dialog.
    var showRemoveConfirm by remember { mutableStateOf(false) }
    // Tier 2 — drives the key-wipe Sign-out confirmation dialog. Copy +
    // severity adapt on hasCloudRecovery (a wipe without recovery is
    // permanent account loss, so it gets the danger-zone framing).
    var showSignOutConfirm by remember { mutableStateOf(false) }
    // Account-wide certificate-validity window. Mirrors iOS CertValidityScreen.
    val context = LocalContext.current
    val certStore = remember { CertValidityStore.from(context) }
    var certDays by remember { mutableIntStateOf(certStore.days) }
    var showCertDialog by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val hasRecovery by app.hasCloudRecovery.collectAsState()
    // #52 — the Tier-2 sign-out gate. Demo/mock sessions (the mock screens
    // client, i.e. !useLiveClient) are exempt: they never wrap a real UMK.
    // Absent DeveloperSettings ⇒ NOT demo (fail-closed: the gate applies).
    val isDemoAccount = dev?.useLiveClient?.collectAsState()?.value?.let { !it } ?: false
    val signOutPolicy = SignOutPolicy.evaluate(
        hasCloudRecovery = hasRecovery,
        isDemoAccount = isDemoAccount,
    )

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        Text(
            "Settings",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            app.currentUser.collectAsState().value ?: "no account",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp),
        )

        Spacer(Modifier.height(FS.space.s6))

        // P7 — dedicated tier-status / subscription screen. Mirrors the
        // iOS SettingsScreen subscription nav row + webapp tier-status.js.
        SettingsRow(
            label = "Plan / Subscription",
            description = "Tier, LLM credits, dispatcher usage, custom domains, reserved names.",
        ) {
            nav.navigate("tier-status")
        }
        SettingsRow(label = "AI providers", description = "BYO LLM provider keys (Anthropic, OpenAI, Google, Groq, Ollama).") {
            nav.navigate("providers")
        }
        // v1.2 Phase 4 — Account security badge + drill-down. Placed
        // immediately under AI providers so the account-type state is
        // one of the first things the user notices.
        SettingsRow(
            label = "Account security",
            description = "Single-device vs multi-device + 2FA.",
        ) {
            nav.navigate("account-security")
        }
        SettingsRow(label = "Trusted devices", description = "Phones and tablets that hold your account keys.") {
            nav.navigate("trusted-devices")
        }
        SettingsRow(label = "Browser sessions", description = "Per-pod browser tabs paired with this account.") {
            nav.navigate("paired-sessions")
        }
        SettingsRow(label = "Add a control device", description = "Pair a browser or tablet with the current account.") {
            nav.navigate("add-control-device")
        }
        SettingsRow(label = "Recovery", description = "Cloud recovery + offline recovery codes.") {
            nav.navigate("recovery")
        }
        SettingsRow(label = "Back up your account key", description = "Save an encrypted key file you can use to recover or move your account.") {
            nav.navigate("keyfile-export")
        }
        SettingsRow(label = "Profiles", description = "Switch between your clouds.") {
            nav.navigate("profiles")
        }
        // P14 — companion-dock: mint a 60s pairing ticket → 4h read-only browser.
        SettingsRow(label = "Dock a browser", description = "Scan a one-time QR from a desktop browser to view your cloud read-only for 4 hours.") {
            nav.navigate("companion-dock")
        }
        // P14 Phase 2 — companion-requests inbox. Badge reflects the
        // pending count fetched once when this screen appears.
        CompanionRequestsRow(nav)
        // P9 — peer-backup management.
        SettingsRow(label = "Peer-backup", description = "Shard health across peers + repair status.") {
            nav.navigate("peer-backup")
        }
        SettingsRow(label = "Privacy", description = "Face unlock at launch, app-level gating.") {
            nav.navigate("privacy")
        }
        SettingsRow(
            label = "Certificate validity",
            description = "Renewal window for servers your devices manage — $certDays days.",
        ) {
            showCertDialog = true
        }
        if (devUnlocked) {
            SettingsRow(label = "Developer", description = "Toggle the live screens client + dev fixtures.") {
                nav.navigate("developer")
            }
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

        if (showCertDialog) {
            AlertDialog(
                onDismissRequest = { showCertDialog = false },
                confirmButton = {
                    TextButton(onClick = { showCertDialog = false }) { Text("Close") }
                },
                title = { Text("Certificate validity") },
                text = {
                    Column {
                        Text(
                            "How long a server your devices manage keeps serving before its " +
                                "certificate must be renewed. If every admin device stays offline " +
                                "past this window, the certificate lapses — the safety cut-off if " +
                                "you lose your phone. Account-wide; only admin devices mint.",
                            color = FS.colors.textMuted,
                            style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                        )
                        Spacer(Modifier.height(FS.space.s2))
                        CertValidityStore.PRESETS.forEach { d ->
                            TextButton(onClick = {
                                certStore.days = d
                                certDays = certStore.days
                            }) {
                                Text(
                                    if (certDays == d) "✓ $d days" else "$d days",
                                    color = if (certDays == d) FS.colors.primary else FS.colors.text,
                                )
                            }
                        }
                    }
                },
            )
        }

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

@Composable
private fun SettingsRow(label: String, description: String, badge: Int? = null, onClick: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(label, color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
                if (badge != null && badge > 0) {
                    Spacer(Modifier.width(FS.space.s2))
                    Text(
                        text = badge.toString(),
                        color = Color.White,
                        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                        modifier = Modifier
                            .background(color = FS.colors.danger, shape = RoundedCornerShape(8.dp))
                            .padding(horizontal = 8.dp, vertical = 2.dp)
                            .semantics { contentDescription = "settings-link-badge-$label" },
                    )
                }
            }
            Text(description, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
            FSGhostButton(label = "Open", onClick = onClick)
        }
    }
    Spacer(Modifier.height(FS.space.s2))
}

/** P14 Phase 2 — owns its own state so the count can refresh on
 *  appearance without prop-drilling through SettingsScreen. */
@Composable
private fun CompanionRequestsRow(nav: NavController) {
    val client = LocalScreensClient.current
    var pending by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        pending = runCatching { client.companionPendingWrites() }
            .map { it.pending.size }
            .getOrDefault(0)
    }
    val description = when {
        pending == 0 -> "Approve writes from docked browsers."
        pending == 1 -> "1 pending write from a docked browser."
        else -> "$pending pending writes from docked browsers."
    }
    SettingsRow(
        label = "Companion requests",
        description = description,
        badge = pending.takeIf { it > 0 },
    ) {
        nav.navigate("companion-requests")
    }
}
