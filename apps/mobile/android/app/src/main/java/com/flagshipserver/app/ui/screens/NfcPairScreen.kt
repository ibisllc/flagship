// C3 Wave 2 (Android) — NFC retail-tier pair screen.
//
// Reached from Settings in debug builds only (developer mode is gone).
// When the owner has a real branded box in-hand we'll lift this onto the
// main onboarding nav. Until then this is the surface where a developer can
// exercise the LiveNfcPairReader against a fixture tag emulated by a
// hello-daemon build, or run through MockNfcPairReader (when no NFC
// hardware is around).

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.R
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
import com.flagshipserver.app.api.NfcRendezvousClient
import com.flagshipserver.app.core.LiveNfcPairReader
import com.flagshipserver.app.core.NfcPairReader
import com.flagshipserver.app.core.OkHttpJsonTransport
import com.flagshipserver.app.core.Variant
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
 * NFC pair screen (reached from Settings in debug builds until retail boxes ship). The live reader uses the host
 * ComponentActivity (MainActivity is a FragmentActivity → ComponentActivity).
 */
@Composable
fun NfcPairScreen(
    nav: NavController,
    reader: NfcPairReader = remember { LiveNfcPairReader() },
    rendezvous: NfcRendezvousClient = remember { LiveNfcRendezvousClient(OkHttpJsonTransport()) },
) {
    val ctx = LocalContext.current
    // A mock run (debug gym) swaps in a rendezvous that posts nothing, so it
    // never reaches the production Worker; every other launch is live.
    val override = remember { Variant.nfcRendezvousOverride() }
    val useLive = override == null
    val effectiveRendezvous = remember(override, rendezvous) { override ?: rendezvous }

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
        FSGhostButton(label = stringResource(R.string.back_2), onClick = { nav.popBackStack() })

        Text(
            stringResource(R.string.tap_to_pair),
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            stringResource(R.string.bring_your_phone_to_the_back) +
                if (useLive) stringResource(R.string.live_worker_rendezvous) else stringResource(R.string.mock_mode_no_cloud_post),
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp),
        )

        when (val p = phase) {
            NfcPairPhase.Idle -> IdleCard(
                onTap = { vm.startTap(ctx as ComponentActivity) },
            )

            NfcPairPhase.ReadingTag -> ReadingCard()

            is NfcPairPhase.AskingForWifi -> AskingForWifiCard(vm = vm, confirmation = p.confirmation)

            NfcPairPhase.Sealing -> SpinnerCard(label = stringResource(R.string.sealing_wi_fi_credentials))

            NfcPairPhase.Depositing -> SpinnerCard(label = stringResource(R.string.sending_to_the_box))

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
                stringResource(R.string.tap_your_box),
                color = FS.colors.text,
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Medium),
            )
            Text(
                stringResource(R.string.hold_your_phone_to_the_back),
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp),
            )
            FSPrimaryButton(label = stringResource(R.string.tap_your_box), onClick = onTap)
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
                stringResource(R.string.hold_your_phone_to_the_box),
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
                fsString(R.string.paired_with, confirmation.boxLabel),
                color = FS.colors.text,
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Medium),
            )
            Text(
                fsString(R.string.box_id_send_your_wi_fi, confirmation.suffix6),
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp),
            )
            if (confirmation.sasLed.isNotEmpty()) {
                LedSasCaptureBlock(vm = vm, confirmation = confirmation)
            }
            Text(
                stringResource(R.string.tell_the_box_how_to_reach),
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp),
            )

            FSField(
                value = ssid,
                onValueChange = { ssid = it; vm.ssid = it },
                label = stringResource(R.string.wi_fi_name_ssid),
                placeholder = stringResource(R.string.home_network),
            )
            FSField(
                value = psk,
                onValueChange = { psk = it; vm.psk = it },
                label = stringResource(R.string.password),
                placeholder = stringResource(R.string.wi_fi_password),
                visualTransformation = PasswordVisualTransformation(),
                keyboardType = KeyboardType.Password,
            )
            FSField(
                value = region,
                onValueChange = { region = it.uppercase().take(2); vm.regulatoryRegion = region },
                label = stringResource(R.string.region_iso_3166_1_alpha_2),
                placeholder = "US",
                keyboardType = KeyboardType.Text,
                helper = stringResource(R.string.optional_used_by_the_box_to),
            )

            FSPrimaryButton(label = stringResource(R.string.send), onClick = { vm.sendSealedWifi() })
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
        fsString(R.string.check_the_boxs_led_it_blinks, confirmation.sasDisplay),
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
                label = stringResource(R.string.verify_the_led_pattern),
                onClick = { working = ""; vm.beginLedSasCapture() },
            )
        }
        cap.verdict == LedSasCapture.Verdict.CONFIRMED -> {
            Text(
                stringResource(R.string.led_pattern_matched_this_is_your),
                color = FS.colors.success,
                style = TextStyle(fontSize = 14.sp),
            )
        }
        cap.verdict == LedSasCapture.Verdict.MISMATCH -> {
            Text(
                stringResource(R.string.that_didnt_match_dont_send_wi),
                color = FS.colors.danger,
                style = TextStyle(fontSize = 14.sp),
            )
            FSGhostButton(
                label = stringResource(R.string.try_the_led_check_again),
                onClick = { working = ""; vm.resetLedSasCapture() },
            )
        }
        else -> {
            val g = cap.currentGlance ?: 0
            Text(
                fsString(R.string.glance_of_3_tap_the_3, g + 1),
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
                stringResource(R.string.sent_2),
                color = FS.colors.success,
                style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Medium),
            )
            Text(message, color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
            FSPrimaryButton(label = stringResource(R.string.local_ai_job_completed), onClick = onDone)
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
                stringResource(R.string.couldnt_pair),
                color = FS.colors.danger,
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Medium),
            )
            Text(message, color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
            FSPrimaryButton(label = stringResource(R.string.try_again), onClick = onRetry)
            if (fallbackAvailable) {
                FSGhostButton(
                    label = stringResource(R.string.pair_using_the_boxs_led_instead),
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
                stringResource(R.string.pair_with_the_boxs_led),
                color = FS.colors.text,
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Medium),
            )
            Text(
                stringResource(R.string.your_phone_finishes_pairing_over_wi),
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp),
            )
            Text(
                stringResource(R.string.led_pairing_isnt_available_in_this),
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp),
            )
            FSPrimaryButton(label = stringResource(R.string.try_the_tap_again), onClick = onRetry)
        }
    }
}
