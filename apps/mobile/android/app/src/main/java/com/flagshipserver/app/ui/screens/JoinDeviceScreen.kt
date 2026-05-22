// Phase 3b — INCOMING cross-device pairing screen. Reached two ways:
//   - in-app scanner (Welcome → "Join with a pairing code"), or
//   - the App-Links / flagship://join deeplink (the collaborator's native
//     camera follows the admin's QR).
//
// Drives the JoinDeviceViewModel: connect → show SAS for the USER to
// verify → receive + open the bundle → verify the admit → install into a
// NEW profile → admit (lands QUARANTINED). Surfaces the 14-day quarantine
// countdown on success.
//
// Safeguards: SecureWindow() (FLAG_SECURE — no screenshots) + a risk
// warning. Mock relay seam in tests; live Credential Manager NOT involved.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.JoinLink
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.MockDevicePairingRelay
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.SecureWindow
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.JoinDevicePhase
import com.flagshipserver.app.viewmodels.JoinDeviceViewModel
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * @param initialLink non-null when arriving via deeplink (skips the
 *        scanner). Null shows the in-app scanner first.
 */
@Composable
fun JoinDeviceScreen(
    initialLink: JoinLink? = null,
    onJoined: () -> Unit,
    onCancel: () -> Unit,
) {
    // No screenshots — the SAS + relay are the join doorway.
    SecureWindow()

    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val scope = rememberCoroutineScope()

    var link by remember { mutableStateOf(initialLink) }
    var scanError by remember { mutableStateOf<String?>(null) }

    if (link == null) {
        ScannerEntry(
            error = scanError,
            onScanned = { raw ->
                val parsed = JoinLink.parse(raw)
                if (parsed == null) {
                    scanError = "That QR isn't a Flagship pairing invite."
                } else {
                    scanError = null
                    link = parsed
                }
            },
            onCancel = onCancel,
        )
        return
    }

    // The live phone↔phone relay lands with the server's role plumbing;
    // until then the screen uses the Mock so the surface is exercisable.
    // Tests drive the VM directly with their own relay.
    val relay = remember { MockDevicePairingRelay() }
    val vm = remember(link) {
        JoinDeviceViewModel(
            joinLink = link!!,
            relay = relay.incoming,
            server = server,
            app = app,
        )
    }
    val phase by vm.phase.collectAsState()

    LaunchedEffect(vm) { vm.start() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6, vertical = FS.space.s8)
            .semantics { contentDescription = "join-device" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            "Join an account",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )

        RiskWarning(
            "You're about to bring this device into someone else's Flagship " +
                "account. It will hold that account's keys. Only continue if " +
                "the account owner is adding you right now and the codes match.",
        )

        when (val p = phase) {
            JoinDevicePhase.Connecting -> StatusPanel("Connecting…", spinner = true)
            is JoinDevicePhase.VerifySas -> VerifyPanel(
                matchCode = p.matchCode,
                onConfirm = { scope.launch { vm.verifyAndJoin() } },
                onCancel = { vm.cancel(); onCancel() },
            )
            JoinDevicePhase.Joining -> StatusPanel("Joining the account…", spinner = true)
            is JoinDevicePhase.Joined -> JoinedPanel(quarantineUntil = p.quarantineUntil, onDone = onJoined)
            is JoinDevicePhase.Failed -> {
                StatusPanel(p.message, danger = true)
                FSGhostButton(label = "Back", onClick = onCancel, block = true)
            }
        }
    }
}

@Composable
private fun ScannerEntry(error: String?, onScanned: (String) -> Unit, onCancel: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6, vertical = FS.space.s8)
            .semantics { contentDescription = "join-device-scan" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            "Scan the pairing code",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "Point your camera at the “Add a device” code on the account owner's phone.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
        )
        RiskWarning(
            "Scanning brings this device into the owner's account and shares " +
                "their account keys with it. Only scan a code the owner is " +
                "showing you right now.",
        )
        QRScanner(onScanned = onScanned)
        error?.let {
            Text(it, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
        }
        FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
    }
}

@Composable
private fun VerifyPanel(matchCode: String, onConfirm: () -> Unit, onCancel: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                "Confirm this code",
                color = FS.colors.text,
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                formatSas(matchCode),
                color = FS.colors.primary,
                style = TextStyle(fontSize = 40.sp, fontWeight = FontWeight.Bold, letterSpacing = 4.sp),
                modifier = Modifier.semantics { contentDescription = "join-device-sas" },
            )
            Text(
                "It must match the code on the account owner's phone.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
        }
    }
    Spacer(Modifier.height(FS.space.s2))
    FSPrimaryButton(label = "Codes match — join", onClick = onConfirm, block = true, large = true)
    FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
}

@Composable
private fun JoinedPanel(quarantineUntil: Long?, onDone: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s5)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                "You're in",
                color = FS.colors.success,
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                quarantineCopy(quarantineUntil),
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, lineHeight = 19.sp),
                modifier = Modifier.semantics { contentDescription = "join-device-quarantine" },
            )
        }
    }
    Spacer(Modifier.height(FS.space.s2))
    FSPrimaryButton(label = "Continue", onClick = onDone, block = true, large = true)
}

@Composable
private fun StatusPanel(message: String, spinner: Boolean = false, danger: Boolean = false) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            if (spinner) CircularProgressIndicator()
            Text(
                message,
                color = if (danger) FS.colors.danger else FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp),
            )
        }
    }
}

/** Quarantine countdown copy for the joined panel. Kept top-level so a
 *  test can assert the byte-string without Compose scaffolding. */
internal fun quarantineCopy(quarantineUntil: Long?, now: Long = System.currentTimeMillis()): String {
    if (quarantineUntil == null || quarantineUntil <= now) {
        return "This device is now on the account. It starts as a non-admin device."
    }
    val days = ((quarantineUntil - now) + 86_399_999) / 86_400_000  // ceil to days
    val until = SimpleDateFormat("MMM d, yyyy", Locale.getDefault()).format(Date(quarantineUntil))
    return "This device is a non-admin device for about $days more day" +
        (if (days == 1L) "" else "s") +
        " (until $until). The account owner is being reminded to review trusted devices."
}
