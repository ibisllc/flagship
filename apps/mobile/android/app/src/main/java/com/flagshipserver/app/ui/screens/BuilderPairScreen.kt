// Pair-with-the-desktop-Builder screen. Reached from the create-server delivery
// chooser once the server is designed. The user scans the QR the builder shows
// (or types its short code), confirms the 6-digit SAS, and the recipe is minted
// + delivered over the live `/builder-pipe` session.
//
// ONE-SHOT: delivery is a single deposit. Once the builder acknowledges that it
// staged the recipe, the screen shows "Sent ✓ — you can put your phone away"
// and the phone has no further
// role; the builder keeps the recipe and the laptop user disconnects on the
// builder side. The display is kept awake only while this screen is foreground
// (so the OS auto-lock doesn't suspend the app mid-deposit).
//
// Kotlin mirror of apps/mobile/ios/Sources/FlagshipUI/Screens/BuilderPairScreen.swift,
// driven by core/BuilderPairController.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
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
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.core.BuilderPairController
import com.flagshipserver.app.core.BuilderPairing
import com.flagshipserver.app.core.QrRelay
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSLayout
import kotlinx.coroutines.launch

@Composable
fun BuilderPairScreen(
    controller: BuilderPairController,
    onDeliveredVisible: (serverDomain: String, serial: String) -> Unit,
    onClose: (serverDomain: String, serial: String) -> Unit,
    onCancel: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val phase by controller.phase.collectAsState()
    var typedCode by remember { mutableStateOf("") }

    // Fire the visible-delivery callback exactly once when delivery lands (keyed
    // on the delivered domain so it doesn't re-fire on recomposition).
    val deliveredDomain = (phase as? BuilderPairController.Phase.Delivered)?.serverDomain
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
        onDispose {
            view.keepScreenOn = false
            controller.cancel()
        }
    }

    val title = when (phase) {
        is BuilderPairController.Phase.Scan -> stringResource(R.string.pair_with_the_builder)
        is BuilderPairController.Phase.EnterCode -> stringResource(R.string.enter_the_builder_code)
        is BuilderPairController.Phase.Connecting -> stringResource(R.string.connecting_2)
        is BuilderPairController.Phase.Matching -> stringResource(R.string.confirm_the_security_code)
        is BuilderPairController.Phase.Delivering -> stringResource(R.string.sending)
        is BuilderPairController.Phase.Delivered -> stringResource(R.string.sent)
        is BuilderPairController.Phase.Failed -> stringResource(R.string.pairing_failed)
    }
    FSScreen(
        title = title,
        onBack = { controller.cancel(); onCancel() },
        spacing = 0.dp,
    ) {
        when (val p = phase) {
            is BuilderPairController.Phase.Scan -> ScanStep(
                onScanned = { code -> scope.launch { controller.begin(code) } },
                onEnterCode = { controller.switchToEnterCode() },
            )
            is BuilderPairController.Phase.EnterCode -> EnterCodeStep(
                code = typedCode,
                onCode = { typedCode = it },
                onConnect = { scope.launch { controller.begin(typedCode) } },
                onScan = { controller.switchToScan() },
            )
            is BuilderPairController.Phase.Connecting -> StepHeaderSpinner(
                title = stringResource(R.string.connecting_2),
                subtitle = stringResource(R.string.opening_the_secure_channel_to_the),
            )
            is BuilderPairController.Phase.Matching -> MatchStep(
                matchCode = p.matchCode,
                onConfirm = { scope.launch { controller.confirmAndDeliver() } },
                onCancel = { controller.cancel(); onCancel() },
            )
            is BuilderPairController.Phase.Delivering -> StepHeaderSpinner(
                title = stringResource(R.string.sending),
                subtitle = stringResource(R.string.minting_your_recipe_and_sending_it),
            )
            is BuilderPairController.Phase.Delivered -> DeliveredStep(
                domain = p.serverDomain,
                onDone = { onClose(p.serverDomain, controller.lastDeliveredSerial ?: "") },
            )
            is BuilderPairController.Phase.Failed -> FailedStep(
                message = p.message,
                onRetry = { controller.switchToScan() },
                onCancel = { controller.cancel(); onCancel() },
            )
        }
    }
}

@Composable
private fun ScanStep(onScanned: (String) -> Unit, onEnterCode: () -> Unit) {
    Header(
        stringResource(R.string.pair_with_the_builder),
        stringResource(R.string.on_your_computer_open_the_flagship),
    )
    Spacer(Modifier.height(FS.space.s4))
    QRScanner(onScanned = onScanned)
    Spacer(Modifier.height(FS.space.s3))
    FSSecondaryButton(label = stringResource(R.string.enter_the_code_instead), onClick = onEnterCode, block = true)
    Spacer(Modifier.height(FS.space.s4))
    WhereToGetBuilder()
}

@Composable
private fun EnterCodeStep(
    code: String,
    onCode: (String) -> Unit,
    onConnect: () -> Unit,
    onScan: () -> Unit,
) {
    Header(
        stringResource(R.string.enter_the_builder_code),
        stringResource(R.string.type_the_short_code_shown_under),
    )
    Spacer(Modifier.height(FS.space.s4))
    FSCard {
        FSField(value = code, onValueChange = onCode, label = stringResource(R.string.builder_code))
    }
    Spacer(Modifier.height(FS.space.s4))
    FSPrimaryButton(
        label = stringResource(R.string.connect),
        onClick = onConnect,
        enabled = BuilderPairing.looksLikeBuilderCode(code),
        block = true,
    )
    Spacer(Modifier.height(FS.space.s2))
    FSSecondaryButton(label = stringResource(R.string.scan_the_qr_instead), onClick = onScan, block = true)
    Spacer(Modifier.height(FS.space.s4))
    WhereToGetBuilder()
}

@Composable
private fun MatchStep(matchCode: String, onConfirm: () -> Unit, onCancel: () -> Unit) {
    Header(
        stringResource(R.string.confirm_the_security_code),
        stringResource(R.string.check_that_this_matches_the_code),
    )
    Spacer(Modifier.height(FS.space.s4))
    FSCard {
        Column(
            Modifier.fillMaxWidth().padding(vertical = FS.space.s4),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                QrRelay.formatMatchCode(matchCode),
                style = MaterialTheme.typography.displayMedium.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
            )
        }
    }
    Spacer(Modifier.height(FS.space.s6))
    FSPrimaryButton(label = stringResource(R.string.they_match_pair_send), onClick = onConfirm, block = true)
    Spacer(Modifier.height(FS.space.s2))
    FSSecondaryButton(label = stringResource(R.string.cancel), onClick = onCancel, block = true)
}

@Composable
private fun DeliveredStep(domain: String, onDone: () -> Unit) {
    Header(
        stringResource(R.string.sent),
        stringResource(R.string.your_computers_builder_has_the_recipe),
    )
    Spacer(Modifier.height(FS.space.s4))
    FSCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(FS.space.s3)) {
            Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = FS.colors.success)
            Column {
                Text(stringResource(R.string.you_can_put_your_phone_away), style = MaterialTheme.typography.titleMedium)
                Text(domain, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
    Spacer(Modifier.height(FS.space.s6))
    FSPrimaryButton(label = stringResource(R.string.done), onClick = onDone, block = true)
}

@Composable
private fun FailedStep(message: String, onRetry: () -> Unit, onCancel: () -> Unit) {
    Header(stringResource(R.string.pairing_failed), message)
    Spacer(Modifier.height(FS.space.s6))
    FSPrimaryButton(label = stringResource(R.string.try_again), onClick = onRetry, block = true)
    Spacer(Modifier.height(FS.space.s2))
    FSSecondaryButton(label = stringResource(R.string.cancel), onClick = onCancel, block = true)
}

@Composable
private fun WhereToGetBuilder() {
    FSCard {
        Column {
            Text(stringResource(R.string.dont_have_the_builder), style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(FS.space.s1))
            Text(
                stringResource(R.string.the_flagship_studio_is_a_small),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun Header(@Suppress("UNUSED_PARAMETER") title: String, subtitle: String) {
    // The app bar carries the step's title; this is its explanation.
    Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
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
