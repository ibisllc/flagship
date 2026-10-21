// H5 — Replace-device FINALIZE screen. Kotlin/Compose mirror of
// FlagshipUI/Screens/ReplaceDeviceFinalizeScreen.swift.
//
// Reached after ReplaceDeviceViewModel.initiate returns Pending (or the
// M4 banner's "Finalize now"). Shows the 24-hour grace countdown, gates
// the "Complete replacement" button until the window elapses, fires
// complete() on tap, and renders the terminal completed / failed states.
// On completion the stale session is signed out — the IRK just rotated.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.ReplaceDevicePhase
import com.flagshipserver.app.viewmodels.ReplaceDeviceViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import com.flagshipserver.app.core.FlagshipDateFormat
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

    FSScreen(
        title = stringResource(R.string.replacing_this_device),
        onBack = { nav.popBackStack() },
        subtitle = stringResource(R.string.this_rotates_your_accounts_identity_key),
    ) {
        when (phase) {
            is ReplaceDevicePhase.Completed -> CompletedCard(onDone = { nav.popBackStack() })
            is ReplaceDevicePhase.Completing -> WorkingCard(stringResource(R.string.finishing_the_swap))
            is ReplaceDevicePhase.Signing, is ReplaceDevicePhase.Posting -> WorkingCard(stringResource(R.string.re_confirming))
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
                if (elapsed) stringResource(R.string.grace_window_complete) else stringResource(R.string.takes_effect_in),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelLarge,
            )
            Text(
                if (elapsed) stringResource(R.string.ready_to_complete) else remainingLabel(completesAt, nowTick),
                color = if (elapsed) FS.colors.success else MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.semantics { contentDescription = "replace-finalize-countdown" },
            )
            Text(
                stringResource(R.string.your_other_devices_are_notified_during),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
            FSPrimaryButton(
                label = stringResource(R.string.complete_replacement),
                onClick = onComplete,
                enabled = elapsed && !inFlight,
                block = true,
                modifier = Modifier.semantics { contentDescription = "replace-finalize-complete" },
            )
            if (!elapsed) {
                Text(
                    stringResource(R.string.available_once_the_countdown_reaches_zero),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
    if (failure != null) {
        FSCard {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Text(
                    stringResource(R.string.couldnt_complete),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    failure,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
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
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = FS.colors.success)
                Text(stringResource(R.string.replacement_complete), style = MaterialTheme.typography.titleMedium)
            }
            Text(
                stringResource(R.string.your_identity_key_has_rotated_other),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
            FSPrimaryButton(label = stringResource(R.string.done), onClick = onDone, block = true)
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
            Text(label, style = MaterialTheme.typography.bodyLarge)
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
    FlagshipDateFormat.format(ms, includeTime = true)
