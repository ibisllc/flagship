// Settings landing. Routes to providers, recovery, paired sessions,
// add-control-device, developer pane.

package com.flagshipserver.app.ui.screens

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import com.flagshipserver.app.core.LocalPrivacySettings
import com.flagshipserver.app.core.ThemeMode
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.api.PushTokenRevokeRequest
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.LocalDeveloperSettings
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.PushTokenRevoke
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
    val privacy = LocalPrivacySettings.current
    val themeMode = privacy?.themeMode?.collectAsState()?.value ?: ThemeMode.AUTO
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
    // The recovery-gated buttons ("Lock with passkey" + "Remove this
    // device") stay greyed-but-tappable until recovery is enrolled; a
    // tap-while-greyed surfaces this toast instead of the destructive path.
    val ctx = LocalContext.current
    val showRecoveryRequiredToast = {
        Toast.makeText(ctx, "Set up account recovery to use this.", Toast.LENGTH_LONG).show()
    }
    val sessionGated = signOutPolicy == SignOutPolicy.BLOCKED_NO_RECOVERY

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

        // Account-security + providers.
        FSSettingsGroup(
            header = "ACCOUNT",
            rows = listOf(
                FSSettingsRowData(
                    icon = "🔑",
                    title = "AI keys",
                    subtitle = "BYO LLM keys, saved on this device (Anthropic, OpenAI, Google…).",
                    onClick = { nav.navigate("ai-keys") },
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

        // APPEARANCE — Light / Dark / Auto as one horizontal segmented control
        // (sun, moon, and a small "AUTO"). Applied app-wide by MainActivity.
        Text(
            "APPEARANCE",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
        )
        Spacer(Modifier.height(FS.space.s2))
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            ThemeSegment(Modifier.weight(1f), label = "☀️", selected = themeMode == ThemeMode.LIGHT) {
                privacy?.setThemeMode(ThemeMode.LIGHT)
            }
            ThemeSegment(Modifier.weight(1f), label = "🌙", selected = themeMode == ThemeMode.DARK) {
                privacy?.setThemeMode(ThemeMode.DARK)
            }
            ThemeSegment(Modifier.weight(1f), label = "AUTO", small = true, selected = themeMode == ThemeMode.AUTO) {
                privacy?.setThemeMode(ThemeMode.AUTO)
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
            "Locks Flagship behind biometrics. Nothing is interrupted.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
        )
        Spacer(Modifier.height(FS.space.s2))
        FSGhostButton(
            label = "Lock with biometrics",
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
            "Erases account key and deletes data. Sign back in with your recovery passkey.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
        )
        Spacer(Modifier.height(FS.space.s2))
        FSDangerButton(
            label = "Lock with passkey",
            muted = sessionGated,
            onClick = {
                if (sessionGated) showRecoveryRequiredToast() else showSignOutConfirm = true
            },
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
            "Remove this device from your account. You may need account recovery to resume.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 13.sp),
        )
        Spacer(Modifier.height(FS.space.s2))
        FSDangerButton(
            label = "Remove this device from account",
            muted = sessionGated,
            onClick = {
                if (sessionGated) showRecoveryRequiredToast() else showRemoveConfirm = true
            },
            block = true,
        )

        if (showRemoveConfirm) {
            AlertDialog(
                onDismissRequest = { showRemoveConfirm = false },
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
                                    val irk = Keystore.deriveIRK(reason = "Remove this device from Flagship")
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
            // Only reachable when recovery is enrolled (or in demo mode) —
            // the "Lock with passkey" button is greyed and routes to a
            // toast otherwise.
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
                        Text("Lock with passkey", color = FS.colors.danger)
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showSignOutConfirm = false }) {
                        Text("Cancel")
                    }
                },
                title = { Text("Lock with passkey?") },
                text = {
                    Text(
                        "This erases this device's account key and data so nothing " +
                            "sensitive is left at rest. Your account and your servers are " +
                            "untouched — sign back in with your recovery passkey and the " +
                            "same key is restored, no re-pair.",
                    )
                },
            )
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

/** One segment of the APPEARANCE control: a sun / moon / "AUTO" pill that
 *  highlights when selected. */
@Composable
private fun ThemeSegment(
    modifier: Modifier = Modifier,
    label: String,
    small: Boolean = false,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Box(
        modifier
            .height(46.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) FS.colors.primary else FS.colors.surfaceSunken)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            color = if (selected) Color.White else FS.colors.text,
            style = TextStyle(
                fontSize = if (small) 11.sp else 18.sp,
                fontWeight = if (small) FontWeight.Bold else FontWeight.Medium,
                letterSpacing = if (small) 1.5.sp else 0.sp,
            ),
        )
    }
}
