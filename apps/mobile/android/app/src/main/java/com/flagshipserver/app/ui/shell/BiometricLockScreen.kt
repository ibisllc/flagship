// C12 — Compose mirror of FlagshipUI/Shell/BiometricLockScreen.swift.
//
// Renders a centered "Flagship is locked" lockout whenever
// AppState.requireBiometricAtLaunch is on and isUnlocked is false.
// Tapping the Unlock button fires BiometricGate.evaluate against the
// hosting FragmentActivity and on success flips the latch via
// AppState.markUnlocked.

package com.flagshipserver.app.ui.shell

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import com.flagshipserver.app.ui.components.FSActionFooter
import android.app.Activity
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.clickable
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
import com.flagshipserver.app.ui.components.AlertDialog
import androidx.compose.material3.Icon
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.fragment.app.FragmentActivity
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.core.WatchApprovalPrompt
import com.flagshipserver.app.keystore.BiometricAuthority
import com.flagshipserver.app.keystore.BiometricCancelled
import com.flagshipserver.app.keystore.BiometricFailed
import com.flagshipserver.app.keystore.BiometricGate
import com.flagshipserver.app.keystore.Keystore
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
    val toasts = com.flagshipserver.app.core.LocalToastCenter.current
    val watchWaiting by WatchApprovalPrompt.shared.waiting.collectAsState()
    // Unlocking here is the session's biometric, so a waiting watch can now
    // approve: say so.
    fun unlocked() {
        app.markUnlocked()
        if (WatchApprovalPrompt.shared.current() != null && BiometricAuthority.current()?.isFresh() == true) {
            WatchApprovalPrompt.shared.clear()
            toasts.success(WatchApprovalPrompt.AFTER_UNLOCK)
        }
    }

    val activity = ctx as? FragmentActivity
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(FS.colors.bg)
            // Edge-to-edge: keep the footer above the navigation bar.
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom))
            // A full-screen lock cover must swallow every touch, not just
            // paint over the shell behind it — Compose only routes taps to
            // composables that actually declare pointer input, so without
            // this a tap landing on empty space here (e.g. the Spacers)
            // fell straight through to whatever was rendered underneath.
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {}
            .padding(horizontal = FS.space.s6)
            .testTag("biometric-lock-screen"),
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
                tint = FS.colors.accent,
                modifier = Modifier.size(64.dp),
            )
            Text(
                stringResource(R.string.flagship_is_locked),
                color = FS.colors.text,
                style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold),
            )
            Text(
                stringResource(R.string.unlock_with_biometrics_to_continue),
                color = FS.colors.textMuted,
                style = MaterialTheme.typography.bodyMedium,
            )
            if (watchWaiting != null && WatchApprovalPrompt.shared.current() != null) {
                Text(
                    WatchApprovalPrompt.LOCK_SCREEN_NOTE,
                    color = FS.colors.text,
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.testTag("lock-watch-waiting"),
                )
            }
            Spacer(Modifier.weight(1f))
            (status as? Status.Failed)?.let {
                Text(
                    it.message,
                    color = FS.colors.danger,
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(FS.space.s2))
            }
            // Same footer as Welcome. Sign out is the always-present escape
            // so broken/absent biometrics can never trap the user on this
            // screen. It's a genuine Tier-2 SIGN OUT — it erases this
            // device's local key material from the Keystore (every profile,
            // since the locked user can't pick one) and drops to Welcome.
            // Like the Settings sign-out it's snoop-hardening, not eviction:
            // the same key comes back via passkey recovery (instant re-pair,
            // no rotation). Confirm copy adapts on cloud recovery.
            FSActionFooter(
                primary = if (status == Status.Authenticating) stringResource(R.string.authenticating) else stringResource(R.string.unlock_2),
                primaryTag = "biometric-unlock-btn",
                primaryEnabled = status != Status.Authenticating,
                onPrimary = {
                    if (activity == null) {
                        status = Status.Failed(FSStrings.get(R.string.lost_activity_context_restart_the_app))
                    } else {
                        scope.launch { tryUnlock(activity) { newStatus ->
                            status = newStatus
                            if (newStatus == Status.Idle) unlocked()
                        } }
                    }
                },
                secondary = stringResource(R.string.sign_out_2),
                secondaryTag = "lock-sign-out-btn",
                onSecondary = {
                    // Biometric or device PIN before the dialog opens, as on
                    // iOS, so both platforms ask alike.
                    if (activity == null) {
                        status = Status.Failed(FSStrings.get(R.string.lost_activity_context_restart_the_app))
                    } else {
                        scope.launch {
                            when (val r = authenticateForSignOut(activity)) {
                                SignOutAuth.Ok -> showSignOut = true
                                SignOutAuth.Cancelled -> {}
                                is SignOutAuth.Failed -> status = Status.Failed(r.message)
                            }
                        }
                    }
                },
                secondaryDescription = stringResource(R.string.sign_out_erases_this_devices_account),
            )
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
                    // returns via passkey recovery. Already authenticated
                    // before this dialog opened.
                    Keystore.wipeAllProfiles()
                    app.signOut()
                }) {
                    Text(
                        if (hasRecovery) stringResource(R.string.sign_out_2) else stringResource(R.string.sign_out_anyway),
                        color = FS.colors.danger,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showSignOut = false }) { Text(stringResource(R.string.cancel)) }
            },
            title = {
                Text(
                    if (hasRecovery) stringResource(R.string.sign_out_of_this_device)
                    else stringResource(R.string.sign_out_without_recovery),
                )
            },
            text = {
                Text(
                    if (hasRecovery)
                        stringResource(R.string.this_erases_this_devices_account_key_2)
                    else
                        stringResource(R.string.you_have_no_cloud_recovery_set),
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
                if (newStatus == Status.Idle) unlocked()
            }
        }
    }
}

private sealed class Status {
    data object Idle : Status()
    data object Authenticating : Status()
    data class Failed(val message: String) : Status()
}

private sealed class SignOutAuth {
    data object Ok : SignOutAuth()
    data object Cancelled : SignOutAuth()
    data class Failed(val message: String) : SignOutAuth()
}

/** Ok also when the device has nothing to authenticate with (no screen
 *  lock), where the sign-out is the only way out of this screen. */
private suspend fun authenticateForSignOut(activity: FragmentActivity): SignOutAuth = try {
    BiometricGate.evaluate(activity, title = "Sign out of Flagship", subtitle = "Confirm it's you")
    SignOutAuth.Ok
} catch (e: BiometricFailed) {
    if (e.code in setOf(
            androidx.biometric.BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL,
            androidx.biometric.BiometricPrompt.ERROR_NO_BIOMETRICS,
            androidx.biometric.BiometricPrompt.ERROR_HW_NOT_PRESENT,
        )
    ) SignOutAuth.Ok
    else SignOutAuth.Failed(NetworkErrorHumanizer.humanize(e, "app-lock"))
} catch (_: BiometricCancelled) {
    SignOutAuth.Cancelled
}

private suspend fun tryUnlock(
    activity: FragmentActivity,
    setStatus: (Status) -> Unit,
) {
    setStatus(Status.Authenticating)
    try {
        BiometricGate.evaluate(activity, title = FSStrings.get(R.string.unlock_flagship), subtitle = FSStrings.get(R.string.use_biometrics_to_continue))
        BiometricAuthority.current()?.markFresh()
        setStatus(Status.Idle)
    } catch (_: BiometricCancelled) {
        setStatus(Status.Failed(FSStrings.get(R.string.cancelled_tap_below_to_try_again)))
    } catch (e: kotlinx.coroutines.CancellationException) {
        // The screen went away mid-request: back to idle, never a spinner.
        setStatus(Status.Failed(FSStrings.get(R.string.tap_below_to_unlock)))
        throw e
    } catch (e: Throwable) {
        // UX-B — never leak the raw exception text to the user.
        setStatus(Status.Failed(NetworkErrorHumanizer.humanize(e, "app-lock")))
    }
}
