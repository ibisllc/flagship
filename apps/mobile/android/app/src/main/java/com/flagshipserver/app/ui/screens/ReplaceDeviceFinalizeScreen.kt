// H5 — Replace-device FINALIZE screen. Kotlin/Compose mirror of
// FlagshipUI/Screens/ReplaceDeviceFinalizeScreen.swift.
//
// Reached after ReplaceDeviceViewModel.initiate returns Pending (or the
// M4 banner's "Finalize now"). Shows the 24-hour grace countdown, gates
// the "Complete replacement" button until the window elapses, fires
// complete() on tap, and renders the terminal completed / failed states.
// On completion the stale session is signed out — the IRK just rotated.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.ReplaceDevicePhase
import com.flagshipserver.app.viewmodels.ReplaceDeviceViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * @param completesAt server-reported deadline (Unix ms) carried on the
 *   route. The screen re-seats the VM into Pending with it on first
 *   composition so the countdown + Complete gate are correct.
 */
@Composable
fun ReplaceDeviceFinalizeScreen(nav: NavController, completesAt: Long) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val scope = rememberCoroutineScope()
    val vm: ReplaceDeviceViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                ReplaceDeviceViewModel(
                    server = server,
                    username = { app.currentUser.value },
                )
            }
        },
    )
    val phase = vm.phase.collectAsState().value

    // Re-seat into Pending so a (re)opened screen shows the countdown even
    // if the VM was freshly constructed (e.g. arrived from the M4 banner).
    LaunchedEffect(completesAt) { vm.resume(completesAt) }

    // 1s ticker so the countdown + button-gate refresh while waiting.
    var nowTick by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            nowTick = System.currentTimeMillis()
            delay(1000)
        }
    }

    // On completion the IRK has rotated — the in-memory session is stale.
    // Sign out so the app re-pairs cleanly on next open (mirror iOS
    // onCompleted; Android push revoke rides the next sign-in).
    LaunchedEffect(phase) {
        if (phase is ReplaceDevicePhase.Completed) {
            app.signOut()
        }
    }

    val elapsed = ReplaceDeviceViewModel.graceElapsed(completesAt, nowTick)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6, vertical = FS.space.s8),
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            "Replacing this device",
            color = FS.colors.text,
            style = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
        )
        Text(
            "This rotates your account's identity key. Once the grace window " +
                "ends, every other device on the account must re-pair the next " +
                "time it opens — including this phone. Your pods keep running " +
                "and your services stay installed.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp),
        )

        when (phase) {
            is ReplaceDevicePhase.Completed -> CompletedCard(onDone = { nav.popBackStack() })
            is ReplaceDevicePhase.Completing -> WorkingCard("Finishing the swap…")
            is ReplaceDevicePhase.Signing, is ReplaceDevicePhase.Posting -> WorkingCard("Re-confirming…")
            else -> PendingBody(
                completesAt = completesAt,
                elapsed = elapsed,
                nowTick = nowTick,
                inFlight = false,
                failure = (phase as? ReplaceDevicePhase.Failed)?.message,
                onComplete = { scope.launch { vm.complete() } },
            )
        }
    }
}

@Composable
private fun PendingBody(
    completesAt: Long,
    elapsed: Boolean,
    nowTick: Long,
    inFlight: Boolean,
    failure: String?,
    onComplete: () -> Unit,
) {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(
                if (elapsed) "Grace window complete" else "Takes effect in",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp),
            )
            Text(
                if (elapsed) "Ready to complete" else remainingLabel(completesAt, nowTick),
                color = if (elapsed) FS.colors.success else FS.colors.text,
                style = TextStyle(fontSize = 30.sp, fontWeight = FontWeight.SemiBold),
                modifier = Modifier.semantics { contentDescription = "replace-finalize-countdown" },
            )
            Text(
                "During this window, another device on your account can object " +
                    "and cancel the replacement.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp),
            )
            FSPrimaryButton(
                label = "Complete replacement",
                onClick = onComplete,
                enabled = elapsed && !inFlight,
                block = true,
                large = true,
                modifier = Modifier.semantics { contentDescription = "replace-finalize-complete" },
            )
            if (!elapsed) {
                Text(
                    "Available once the countdown reaches zero.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 12.sp),
                )
            }
        }
    }
    if (failure != null) {
        Spacer(Modifier.height(FS.space.s3))
        FSCard {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    "Couldn't complete",
                    color = FS.colors.danger,
                    style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                )
                Text(
                    failure,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                    modifier = Modifier.semantics { contentDescription = "replace-finalize-error" },
                )
            }
        }
    }
}

@Composable
private fun CompletedCard(onDone: () -> Unit) {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                "Replacement complete",
                color = FS.colors.success,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                "Your identity key has rotated. Other devices on this account " +
                    "will be asked to re-pair the next time they open the app.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            FSPrimaryButton(label = "Done", onClick = onDone, block = true, large = true)
        }
    }
}

@Composable
private fun WorkingCard(label: String) {
    FSCard {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
        ) {
            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
            Text(label, color = FS.colors.text, style = TextStyle(fontSize = 15.sp))
        }
    }
}

/** Positional H:MM:SS / MM:SS remaining label. Mirrors iOS's
 *  DateComponentsFormatter positional style. */
internal fun remainingLabel(completesAt: Long, nowMs: Long): String {
    val remainingMs = (completesAt - nowMs).coerceAtLeast(0)
    val totalSecs = remainingMs / 1000
    val h = totalSecs / 3600
    val m = (totalSecs % 3600) / 60
    val s = totalSecs % 60
    return if (h > 0) {
        String.format(Locale.US, "%d:%02d:%02d", h, m, s)
    } else {
        String.format(Locale.US, "%02d:%02d", m, s)
    }
}

/** Absolute locale timestamp (used nowhere on this screen directly but
 *  kept for parity with the banner's formatter helper). */
@Suppress("unused")
internal fun absoluteCompletesAt(ms: Long): String =
    SimpleDateFormat("MMM d, yyyy 'at' h:mm a", Locale.getDefault()).format(Date(ms))
