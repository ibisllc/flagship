// Pair-with-the-desktop-Burner screen. Reached from the create-server delivery
// chooser once the server is designed. The user scans the QR the burner shows
// (or types its short code), confirms the 6-digit SAS, and the recipe is minted
// + delivered over the live `/burner-pipe` session.
//
// ONE-SHOT: delivery is a single deposit. Once the recipe is sent the screen
// shows "Sent ✓ — you can put your phone away" and the phone has no further
// role; the burner keeps the recipe and the laptop user disconnects on the
// burner side. The display is kept awake only while this screen is foreground
// (so the OS auto-lock doesn't suspend the app mid-deposit).
//
// Kotlin mirror of apps/mobile/ios/Sources/FlagshipUI/Screens/BurnerPairScreen.swift,
// driven by core/BurnerPairController.

package com.flagshipserver.app.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.BurnerPairController
import com.flagshipserver.app.core.BurnerPairing
import com.flagshipserver.app.core.QrRelay
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import kotlinx.coroutines.launch

@Composable
fun BurnerPairScreen(
    controller: BurnerPairController,
    onDeliveredVisible: (serverDomain: String, serial: String) -> Unit,
    onClose: (serverDomain: String, serial: String) -> Unit,
    onCancel: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val phase by controller.phase.collectAsState()
    var typedCode by remember { mutableStateOf("") }

    // Fire the visible-delivery callback exactly once when delivery lands (keyed
    // on the delivered domain so it doesn't re-fire on recomposition).
    val deliveredDomain = (phase as? BurnerPairController.Phase.Delivered)?.serverDomain
    LaunchedEffect(deliveredDomain) {
        if (deliveredDomain != null) {
            onDeliveredVisible(deliveredDomain, controller.lastDeliveredSerial ?: "")
        }
    }

    // Keep the display awake while the screen is foreground so the OS auto-lock
    // doesn't suspend the app (and kill the socket) mid-deposit. Reset on exit.
    val view = LocalView.current
    DisposableEffect(Unit) {
        view.keepScreenOn = true
        onDispose { view.keepScreenOn = false }
    }

    val scroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      // Reading column — clamp + center on expanded panes; a no-op on phones.
      Column(
        modifier = Modifier
            .widthIn(max = FSLayout.readingMaxWidth)
            .fillMaxWidth()
            .padding(horizontal = FS.space.s6),
      ) {
        Spacer(Modifier.height(FS.space.s8))
        when (val p = phase) {
            is BurnerPairController.Phase.Scan -> ScanStep(
                onScanned = { code -> scope.launch { controller.begin(code) } },
                onEnterCode = { controller.switchToEnterCode() },
            )
            is BurnerPairController.Phase.EnterCode -> EnterCodeStep(
                code = typedCode,
                onCode = { typedCode = it },
                onConnect = { scope.launch { controller.begin(typedCode) } },
                onScan = { controller.switchToScan() },
            )
            is BurnerPairController.Phase.Connecting -> StepHeaderSpinner(
                title = "Connecting",
                subtitle = "Opening the secure channel to the burner…",
            )
            is BurnerPairController.Phase.Matching -> MatchStep(
                matchCode = p.matchCode,
                onConfirm = { scope.launch { controller.confirmAndDeliver() } },
                onCancel = { controller.cancel(); onCancel() },
            )
            is BurnerPairController.Phase.Delivering -> StepHeaderSpinner(
                title = "Sending",
                subtitle = "Minting your recipe and sending it to the burner…",
            )
            is BurnerPairController.Phase.Delivered -> DeliveredStep(
                domain = p.serverDomain,
                onDone = { onClose(p.serverDomain, controller.lastDeliveredSerial ?: "") },
            )
            is BurnerPairController.Phase.Failed -> FailedStep(
                message = p.message,
                onRetry = { controller.switchToScan() },
                onCancel = { controller.cancel(); onCancel() },
            )
        }
        Spacer(Modifier.height(FS.space.s12))
      }
    }
}

@Composable
private fun ScanStep(onScanned: (String) -> Unit, onEnterCode: () -> Unit) {
    Header(
        "Pair with the burner",
        "On your computer, open the Flagship Burner — it shows a QR code and a short code. Point your camera at it.",
    )
    Spacer(Modifier.height(FS.space.s4))
    QRScanner(onScanned = onScanned)
    Spacer(Modifier.height(FS.space.s3))
    FSGhostButton(label = "Enter the code instead", onClick = onEnterCode, block = true)
    Spacer(Modifier.height(FS.space.s4))
    WhereToGetBurner()
}

@Composable
private fun EnterCodeStep(
    code: String,
    onCode: (String) -> Unit,
    onConnect: () -> Unit,
    onScan: () -> Unit,
) {
    Header(
        "Enter the burner code",
        "Type the short code shown under the QR on your computer (like ABCD-EFGH).",
    )
    Spacer(Modifier.height(FS.space.s4))
    FSCard {
        FSField(value = code, onValueChange = onCode, label = "Burner code")
    }
    Spacer(Modifier.height(FS.space.s4))
    FSPrimaryButton(
        label = "Connect",
        onClick = onConnect,
        enabled = BurnerPairing.looksLikeBurnerCode(code),
        block = true,
    )
    FSGhostButton(label = "Scan the QR instead", onClick = onScan, block = true)
    Spacer(Modifier.height(FS.space.s4))
    WhereToGetBurner()
}

@Composable
private fun MatchStep(matchCode: String, onConfirm: () -> Unit, onCancel: () -> Unit) {
    Header(
        "Confirm the security code",
        "Check that this matches the code on your computer. Only confirm if they're the same.",
    )
    Spacer(Modifier.height(FS.space.s4))
    FSCard {
        Column(
            Modifier.fillMaxWidth().padding(vertical = FS.space.s4),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                QrRelay.formatMatchCode(matchCode),
                color = FS.colors.text,
                style = TextStyle(fontSize = 40.sp, lineHeight = 48.sp, fontWeight = FontWeight.Bold),
            )
        }
    }
    Spacer(Modifier.height(FS.space.s6))
    FSPrimaryButton(label = "They match — pair & send", onClick = onConfirm, block = true)
    FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
}

@Composable
private fun DeliveredStep(domain: String, onDone: () -> Unit) {
    Header(
        "Sent ✓ — you can put your phone away",
        "Your computer's burner has the recipe. Pick the USB drive and any Advanced options on the computer; nothing more is needed from your phone.",
    )
    Spacer(Modifier.height(FS.space.s4))
    FSCard {
        Text(domain, color = FS.colors.text, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
    }
    Spacer(Modifier.height(FS.space.s6))
    FSPrimaryButton(label = "Done", onClick = onDone, block = true)
}

@Composable
private fun FailedStep(message: String, onRetry: () -> Unit, onCancel: () -> Unit) {
    Header("Pairing failed", message)
    Spacer(Modifier.height(FS.space.s6))
    FSPrimaryButton(label = "Try again", onClick = onRetry, block = true)
    FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
}

@Composable
private fun WhereToGetBurner() {
    FSCard {
        Column {
            Text(
                "Don't have the burner?",
                color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
            )
            Spacer(Modifier.height(FS.space.s1))
            Text(
                "The Flagship Burner is a small desktop app that writes your server to a USB stick. Get it at flagshipserver.com, open it, and it'll show the code to scan here.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
            )
        }
    }
}

@Composable
private fun Header(title: String, subtitle: String) {
    Text(
        title,
        color = FS.colors.text,
        style = TextStyle(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold),
    )
    Spacer(Modifier.height(FS.space.s2))
    Text(subtitle, color = FS.colors.textMuted, style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp))
}

@Composable
private fun StepHeaderSpinner(title: String, subtitle: String) {
    Header(title, subtitle)
    Spacer(Modifier.height(FS.space.s6))
    FSCard {
        Row(Modifier.fillMaxWidth().padding(vertical = FS.space.s6), horizontalArrangement = androidx.compose.foundation.layout.Arrangement.Center) {
            CircularProgressIndicator(color = FS.colors.primary)
        }
    }
}
