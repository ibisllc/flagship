// C3 Wave 2 (Android) — NFC retail-tier pair screen.
//
// Dev-mode-only entry today (wired from DeveloperScreen). When the
// owner has a real branded box in-hand we'll lift this onto the main
// onboarding nav. Until then this is the surface where a developer can
// exercise the LiveNfcPairReader against a fixture tag emulated by a
// hello-daemon build, or run through MockNfcPairReader (when no NFC
// hardware is around).

package com.flagshipserver.app.ui.screens

import androidx.activity.ComponentActivity
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.LiveNfcRendezvousClient
import com.flagshipserver.app.api.MockNfcRendezvousClient
import com.flagshipserver.app.api.NfcRendezvousClient
import com.flagshipserver.app.core.LiveNfcPairReader
import com.flagshipserver.app.core.LocalDeveloperSettings
import com.flagshipserver.app.core.NfcPairReader
import com.flagshipserver.app.core.OkHttpJsonTransport
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.NfcPairPhase
import com.flagshipserver.app.viewmodels.NfcPairViewModel

/**
 * Dev-mode NFC pair screen. The live reader uses the host
 * ComponentActivity (MainActivity is a FragmentActivity → ComponentActivity).
 */
@Composable
fun NfcPairScreen(
    nav: NavController,
    reader: NfcPairReader = remember { LiveNfcPairReader() },
    rendezvous: NfcRendezvousClient = remember { LiveNfcRendezvousClient(OkHttpJsonTransport()) },
) {
    val ctx = LocalContext.current
    val dev = LocalDeveloperSettings.current
    val useLive = dev?.useLiveClient?.collectAsState()?.value ?: false

    // Swap in a no-op rendezvous when the dev toggle is OFF so a Mock-mode
    // tester doesn't blast the production Worker by accident. Keeps the
    // Live reader wired for real hardware probing without forcing a code
    // path through the production cloud.
    val effectiveRendezvous = remember(useLive, rendezvous) {
        if (useLive) rendezvous else MockNfcRendezvousClient()
    }

    val vm = remember(reader, effectiveRendezvous) {
        NfcPairViewModel(reader, effectiveRendezvous)
    }
    val phase by vm.phase.collectAsState()

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6, vertical = FS.space.s8)
            .semantics { contentDescription = "nfc-pair" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })

        Text(
            "Tap to pair",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            "Bring your phone to the back of a Flagship box to pair it. " +
                if (useLive) "Live Worker rendezvous." else "Mock mode (no cloud post).",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp),
        )

        when (val p = phase) {
            NfcPairPhase.Idle -> IdleCard(
                onTap = { vm.startTap(ctx as ComponentActivity) },
            )

            NfcPairPhase.ReadingTag -> ReadingCard()

            is NfcPairPhase.AskingForWifi -> AskingForWifiCard(vm = vm, boxLabel = p.boxLabel)

            NfcPairPhase.Sealing -> SpinnerCard(label = "Sealing Wi-Fi credentials…")

            NfcPairPhase.Depositing -> SpinnerCard(label = "Sending to the box…")

            is NfcPairPhase.Success -> SuccessCard(message = p.message, onDone = { vm.reset() })

            is NfcPairPhase.Failure -> FailureCard(message = p.message, onRetry = { vm.reset() })
        }
    }
}

@Composable
private fun IdleCard(onTap: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(
                "Tap your box",
                color = FS.colors.text,
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Medium),
            )
            Text(
                "Hold your phone to the back of the box. We'll read the " +
                    "pairing tag and then ask for your Wi-Fi credentials.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp),
            )
            FSPrimaryButton(label = "Tap your box", onClick = onTap)
        }
    }
}

@Composable
private fun ReadingCard() {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
            modifier = Modifier.fillMaxWidth(),
        ) {
            CircularProgressIndicator(color = FS.colors.primary)
            Text(
                "Hold your phone to the box…",
                color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp),
            )
        }
    }
}

@Composable
private fun AskingForWifiCard(vm: NfcPairViewModel, boxLabel: String) {
    // FSField is uncontrolled (the VM holds the strings) so wrap each in
    // a local saver mirror that pushes back into vm.ssid / vm.psk / vm.regulatoryRegion.
    var ssid by rememberSaveable { mutableStateOf(vm.ssid) }
    var psk by rememberSaveable { mutableStateOf(vm.psk) }
    var region by rememberSaveable { mutableStateOf(vm.regulatoryRegion) }

    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(
                "Paired with $boxLabel",
                color = FS.colors.text,
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Medium),
            )
            Text(
                "Tell the box how to reach your network. These credentials " +
                    "are encrypted on this phone before they leave — we " +
                    "never see them in the clear.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp),
            )

            FSField(
                value = ssid,
                onValueChange = { ssid = it; vm.ssid = it },
                label = "Wi-Fi name (SSID)",
                placeholder = "Home network",
            )
            FSField(
                value = psk,
                onValueChange = { psk = it; vm.psk = it },
                label = "Password",
                placeholder = "Wi-Fi password",
                visualTransformation = PasswordVisualTransformation(),
                keyboardType = KeyboardType.Password,
            )
            FSField(
                value = region,
                onValueChange = { region = it.uppercase().take(2); vm.regulatoryRegion = region },
                label = "Region (ISO 3166-1 alpha-2)",
                placeholder = "US",
                keyboardType = KeyboardType.Text,
                helper = "Optional — used by the box to pick a Wi-Fi regulatory domain.",
            )

            FSPrimaryButton(label = "Send", onClick = { vm.sendSealedWifi() })
        }
    }
}

@Composable
private fun SpinnerCard(label: String) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
            modifier = Modifier.fillMaxWidth(),
        ) {
            CircularProgressIndicator(color = FS.colors.primary)
            Text(label, color = FS.colors.text, style = TextStyle(fontSize = 16.sp))
        }
    }
}

@Composable
private fun SuccessCard(message: String, onDone: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(
                "✓ Sent",
                color = FS.colors.success,
                style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Medium),
            )
            Text(message, color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
            FSPrimaryButton(label = "Done", onClick = onDone)
        }
    }
}

@Composable
private fun FailureCard(message: String, onRetry: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(
                "Couldn't pair",
                color = FS.colors.danger,
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Medium),
            )
            Text(message, color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
            FSPrimaryButton(label = "Try again", onClick = onRetry)
        }
    }
}
