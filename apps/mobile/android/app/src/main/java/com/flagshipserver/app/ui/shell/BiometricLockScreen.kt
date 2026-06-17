// C12 — Compose mirror of FlagshipUI/Shell/BiometricLockScreen.swift.
//
// Renders a centered "Flagship is locked" lockout whenever
// AppState.requireBiometricAtLaunch is on and isUnlocked is false.
// Tapping the Unlock button fires BiometricGate.evaluate against the
// hosting FragmentActivity and on success flips the latch via
// AppState.markUnlocked.

package com.flagshipserver.app.ui.shell

import android.app.Activity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.fragment.app.FragmentActivity
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.keystore.BiometricCancelled
import com.flagshipserver.app.keystore.BiometricGate
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

@Composable
fun BiometricLockScreen() {
    val app = LocalAppState.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<Status>(Status.Idle) }
    var attemptedAuto by remember { mutableStateOf(false) }
    // Tier 2 — drives the lock-screen Sign-out confirmation. Copy +
    // severity adapt on cloud recovery (same framing as Settings).
    var showSignOut by remember { mutableStateOf(false) }
    val hasRecovery by app.hasCloudRecovery.collectAsState()

    val activity = ctx as? FragmentActivity
    Box(
        modifier = Modifier.fillMaxSize().padding(horizontal = FS.space.s6),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(FS.space.s4),
            modifier = Modifier.fillMaxSize(),
        ) {
            Spacer(Modifier.weight(1f))
            Icon(
                Icons.Outlined.Lock,
                contentDescription = null,
                tint = FS.colors.primary,
                modifier = Modifier.size(64.dp),
            )
            Text(
                "Flagship is locked",
                color = FS.colors.text,
                style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                "Unlock with biometrics to continue.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp),
            )
            Spacer(Modifier.weight(1f))
            (status as? Status.Failed)?.let {
                Text(
                    it.message,
                    color = FS.colors.danger,
                    style = TextStyle(fontSize = 12.sp),
                )
                Spacer(Modifier.height(FS.space.s2))
            }
            FSPrimaryButton(
                label = if (status == Status.Authenticating) "Authenticating…" else "Unlock with biometrics",
                onClick = {
                    if (activity == null) {
                        status = Status.Failed("Lost activity context — restart the app to retry.")
                        return@FSPrimaryButton
                    }
                    scope.launch { tryUnlock(activity) { newStatus ->
                        status = newStatus
                        if (newStatus == Status.Idle) app.markUnlocked()
                    } }
                },
                enabled = status != Status.Authenticating,
                block = true,
                large = true,
            )
            Spacer(Modifier.height(FS.space.s4))
            // Always-present escape so broken/absent biometrics can never
            // trap the user on this screen with no way forward. This is a
            // genuine Tier-2 SIGN OUT — it erases this device's local key
            // material from the Keystore (every profile, since the locked
            // user can't pick one) and drops to Welcome. Like the Settings
            // sign-out it's snoop-hardening, not eviction: the same key
            // comes back via passkey recovery (instant re-pair, no
            // rotation). Confirm copy adapts on cloud recovery.
            FSGhostButton(
                label = "Sign out",
                onClick = { showSignOut = true },
                block = true,
            )
            Spacer(Modifier.height(FS.space.s8))
        }
    }
    if (showSignOut) {
        AlertDialog(
            onDismissRequest = { showSignOut = false },
            confirmButton = {
                TextButton(onClick = {
                    showSignOut = false
                    // Tier-2 sign out from the lock screen: erase ALL
                    // Keystore profiles (the locked user can't choose one)
                    // — the UMK / IRK that survive an app reinstall — then
                    // drop to Welcome. No server-side revoke; the same key
                    // returns via passkey recovery.
                    Keystore.wipeAllProfiles()
                    app.signOut()
                }) {
                    Text(
                        if (hasRecovery) "Sign out" else "Sign out anyway",
                        color = FS.colors.danger,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showSignOut = false }) { Text("Cancel") }
            },
            title = {
                Text(
                    if (hasRecovery) "Sign out of this device?"
                    else "Sign out without recovery?",
                )
            },
            text = {
                Text(
                    if (hasRecovery)
                        "This erases this device's account key from the Keystore and returns " +
                            "you to the start. Sign back in with your recovery passkey to " +
                            "restore it — your account and servers stay put."
                    else
                        "⚠️ You have NO cloud recovery enrolled. Erasing this device's key with " +
                            "no backup means there's no way to sign back in — your account " +
                            "access is lost for good.",
                )
            },
        )
    }
    // Auto-prompt once on first appearance — EXCEPT when the user reached this
    // screen by tapping "Lock" in Settings. A deliberate lock that instantly
    // auto-unlocks itself is pointless, so in that case we wait for an explicit
    // tap. Launch + return-from-background still auto-prompt.
    LaunchedEffect(Unit) {
        if (!attemptedAuto && activity != null && !app.awaitingManualUnlock.value) {
            attemptedAuto = true
            tryUnlock(activity) { newStatus ->
                status = newStatus
                if (newStatus == Status.Idle) app.markUnlocked()
            }
        }
    }
}

private sealed class Status {
    data object Idle : Status()
    data object Authenticating : Status()
    data class Failed(val message: String) : Status()
}

private suspend fun tryUnlock(
    activity: FragmentActivity,
    setStatus: (Status) -> Unit,
) {
    setStatus(Status.Authenticating)
    try {
        BiometricGate.evaluate(activity, title = "Unlock Flagship", subtitle = "Use biometrics to continue")
        setStatus(Status.Idle)
    } catch (_: BiometricCancelled) {
        setStatus(Status.Failed("Cancelled. Tap above to try again."))
    } catch (e: Throwable) {
        // UX-B — never leak the raw exception text to the user.
        setStatus(Status.Failed(NetworkErrorHumanizer.humanize(e)))
    }
}
