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
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
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
import com.flagshipserver.app.viewmodels.LedSasCapture
import com.flagshipserver.app.viewmodels.NfcPairPhase
import com.flagshipserver.app.viewmodels.NfcPairViewModel
import com.flagshipserver.app.viewmodels.PairConfirmation

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

            is NfcPairPhase.AskingForWifi -> AskingForWifiCard(vm = vm, confirmation = p.confirmation)

            NfcPairPhase.Sealing -> SpinnerCard(label = "Sealing Wi-Fi credentials…")

            NfcPairPhase.Depositing -> SpinnerCard(label = "Sending to the box…")

            is NfcPairPhase.Success -> SuccessCard(message = p.message, onDone = { vm.reset() })

            is NfcPairPhase.Failure -> FailureCard(
                message = p.message,
                fallbackAvailable = p.ledSasFallbackAvailable,
                onRetry = { vm.reset() },
                onLedSasFallback = { vm.startLedSasFallback() },
            )

            NfcPairPhase.LedSasFallback -> LedSasFallbackCard(onRetry = { vm.reset() })
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

/** Maps a LED-SAS symbol to its display color (RGBY alphabet, N-PROTO-4). */
private fun ledSymbolColor(symbol: Char): Color = when (symbol) {
    'R' -> Color(0xFFE53935)
    'G' -> Color(0xFF43A047)
    'B' -> Color(0xFF1E88E5)
    else -> Color(0xFFFDD835)
}

@Composable
private fun AskingForWifiCard(vm: NfcPairViewModel, confirmation: PairConfirmation) {
    // FSField is uncontrolled (the VM holds the strings) so wrap each in
    // a local saver mirror that pushes back into vm.ssid / vm.psk / vm.regulatoryRegion.
    var ssid by rememberSaveable { mutableStateOf(vm.ssid) }
    var psk by rememberSaveable { mutableStateOf(vm.psk) }
    var region by rememberSaveable { mutableStateOf(vm.regulatoryRegion) }

    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(
                "Paired with ${confirmation.boxLabel}",
                color = FS.colors.text,
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Medium),
            )
            Text(
                "Box ID ${confirmation.suffix6} · send your Wi-Fi within " +
                    "30 seconds of the tap — after that the box rolls a " +
                    "fresh pairing session.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp),
            )
            if (confirmation.sasLed.isNotEmpty()) {
                LedSasCaptureBlock(vm = vm, confirmation = confirmation)
            }
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

/**
 * N-PHONE-6 — the active "optional SAS glance". Shows the expected LED
 * pattern and lets the user record what the box actually blinked, one
 * glance at a time, then renders the strict 3-of-3 verdict.
 */
@Composable
private fun LedSasCaptureBlock(vm: NfcPairViewModel, confirmation: PairConfirmation) {
    val capture by vm.ledCapture.collectAsState()
    // The in-progress glance the user is assembling (3 taps → one glance).
    var working by remember { mutableStateOf("") }

    Text(
        "Check the box's LED — it blinks this 3×3 pattern " +
            "(${confirmation.sasDisplay}). Optional, but it catches a wrong " +
            "box in a crowded room.",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 12.sp),
    )
    // The full expected pattern, grouped into 3 glances of 3.
    Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
        for (g in 0 until 3) {
            val lo = g * 3
            if (lo + 3 <= confirmation.sasLed.length) {
                Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                    confirmation.sasLed.substring(lo, lo + 3).forEach { symbol ->
                        Box(
                            Modifier
                                .size(12.dp)
                                .background(ledSymbolColor(symbol), CircleShape),
                        )
                    }
                }
            }
        }
    }

    val cap = capture
    when {
        cap == null -> {
            FSGhostButton(
                label = "Verify the LED pattern",
                onClick = { working = ""; vm.beginLedSasCapture() },
            )
        }
        cap.verdict == LedSasCapture.Verdict.CONFIRMED -> {
            Text(
                "✓ LED pattern matched — this is your box.",
                color = FS.colors.success,
                style = TextStyle(fontSize = 14.sp),
            )
        }
        cap.verdict == LedSasCapture.Verdict.MISMATCH -> {
            Text(
                "✗ That didn't match. Don't send Wi-Fi — you may be looking " +
                    "at the wrong box.",
                color = FS.colors.danger,
                style = TextStyle(fontSize = 14.sp),
            )
            FSGhostButton(
                label = "Try the LED check again",
                onClick = { working = ""; vm.resetLedSasCapture() },
            )
        }
        else -> {
            val g = cap.currentGlance ?: 0
            Text(
                "Glance ${g + 1} of 3 — tap the 3 colors the LED just blinked:",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp),
            )
            // In-progress glance chips.
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                working.forEach { sym ->
                    Box(
                        Modifier
                            .size(16.dp)
                            .background(ledSymbolColor(sym), CircleShape),
                    )
                }
                repeat(3 - working.length) {
                    Box(
                        Modifier
                            .size(16.dp)
                            .border(1.dp, FS.colors.textMuted, CircleShape),
                    )
                }
            }
            // The 4-color tap pad.
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                listOf('R', 'G', 'B', 'Y').forEach { sym ->
                    Box(
                        Modifier
                            .size(32.dp)
                            .background(ledSymbolColor(sym), CircleShape)
                            .semantics { contentDescription = "led-color-$sym" }
                            .clickable {
                                if (working.length < 3) {
                                    working += sym
                                    if (working.length == 3) {
                                        vm.recordLedGlance(working)
                                        working = ""
                                    }
                                }
                            },
                    )
                }
            }
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
private fun FailureCard(
    message: String,
    fallbackAvailable: Boolean,
    onRetry: () -> Unit,
    onLedSasFallback: () -> Unit,
) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(
                "Couldn't pair",
                color = FS.colors.danger,
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Medium),
            )
            Text(message, color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
            FSPrimaryButton(label = "Try again", onClick = onRetry)
            if (fallbackAvailable) {
                FSGhostButton(
                    label = "Pair using the box's LED instead",
                    onClick = onLedSasFallback,
                )
            }
        }
    }
}

/** Q2 fallback seam — the LED capture + decode flow (N-PHONE-6) mounts
 *  here. Until it lands this card explains the degrade path and routes
 *  back to the tap or the DIY monitor+QR path. */
@Composable
private fun LedSasFallbackCard(onRetry: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text(
                "Pair with the box's LED",
                color = FS.colors.text,
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Medium),
            )
            Text(
                "Your phone finishes pairing over Wi-Fi and confirms the " +
                    "box by its status-LED blink pattern.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp),
            )
            Text(
                "LED pairing isn't available in this build yet. You can " +
                    "retry the tap, or plug a monitor into the box and pair " +
                    "with the on-screen QR code.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp),
            )
            FSPrimaryButton(label = "Try the tap again", onClick = onRetry)
        }
    }
}
