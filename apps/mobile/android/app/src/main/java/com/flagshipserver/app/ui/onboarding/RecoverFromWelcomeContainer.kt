// Kotlin mirror of FlagshipUI/Onboarding/RecoverFromWelcomeContainer.swift.
//
// Hosts the "I already have an account" branch from Welcome. Auto-runs
// CredentialManager + PRF assertion on first compose, surfaces a
// PostRecoveryChoice screen on success, and shows a clear "no recovery
// passkey on this device" failure state when CredentialManager
// reports NoCredentialException.
//
// On choice, the container hands the recovered UMK seed back to the
// host (OnboardingFlow) which is responsible for persisting it into
// Keystore + flipping AppState.isPaired. v1 keeps the
// `wipeAndRestartEnabled` flag false — flipped on in E5.

package com.flagshipserver.app.ui.onboarding

import android.app.Activity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.RecoveryChoice
import com.flagshipserver.app.keystore.PasskeyRecoveryManager
import com.flagshipserver.app.keystore.Recovery
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.screens.PostRecoveryChoiceScreen
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

@Composable
fun RecoverFromWelcomeContainer(
    onComplete: (RecoveryChoice, ByteArray) -> Unit,
    onBack: () -> Unit,
) {
    val ctx = LocalContext.current
    val activity = ctx as? Activity
    val server = LocalFlagshipServerClient.current
    val passkeys = remember(ctx) { PasskeyRecoveryManager(ctx.applicationContext) }
    val scope = rememberCoroutineScope()

    var recoveredSeed by remember { mutableStateOf<ByteArray?>(null) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var working by remember { mutableStateOf(false) }

    suspend fun runRecovery() {
        if (activity == null) {
            errorMessage = "Open from foreground."
            return
        }
        working = true
        errorMessage = null
        try {
            // Without a credentialId we don't know which envelope on
            // .com to fetch yet. On Android, the user's CredentialManager
            // picker will let them choose any passkey for our RP; we
            // pull credentialId out of the resulting assertion response.
            // For now: take the locally stored envelope's credentialId
            // (set during setup) — cross-device CTAP2 hybrid transport
            // is v1.1 work (see docs/multi-device.md).
            val blockStore = com.flagshipserver.app.keystore.BlockStoreUmkStore(ctx.applicationContext)
            val envelope = blockStore.fetch()
                ?: throw IllegalStateException("No recovery passkey on this device")
            val prfSecret = passkeys.assertPrf(activity, envelope.credentialId)
            val seed = Recovery.unwrap(
                ciphertextBase64 = envelope.ciphertextBase64,
                nonceBase64 = envelope.nonceBase64,
                prfSecret = prfSecret,
            )
            require(seed.size == 32) { "recovered UMK isn't 32 bytes" }
            recoveredSeed = seed
        } catch (t: Throwable) {
            errorMessage = humanizedError(t)
        } finally {
            working = false
        }
    }

    LaunchedEffect(Unit) { runRecovery() }

    if (recoveredSeed != null) {
        // Wipe-enabled stays false in v1; E5 flips it on.
        PostRecoveryChoiceScreen(
            wipeAndRestartEnabled = false,
            onContinue = { choice -> onComplete(choice, recoveredSeed!!) },
        )
    } else if (errorMessage != null) {
        FailureView(message = errorMessage!!, onRetry = { scope.launch { runRecovery() } }, onBack = onBack)
    } else {
        RecoveringView(onCancel = onBack)
    }
}

@Composable
private fun RecoveringView(onCancel: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(FS.space.s6).semantics { contentDescription = "recover-recovering" },
        verticalArrangement = Arrangement.SpaceBetween,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(FS.space.s12))
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(FS.space.s4)) {
            CircularProgressIndicator()
            Text(
                "Authenticate with your passkey",
                color = FS.colors.text,
                style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Medium),
            )
            Text(
                "We'll fetch your wrapped account key and bring this device into your existing Flagship account.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                modifier = Modifier.padding(horizontal = FS.space.s8),
            )
        }
        FSGhostButton(label = "Cancel", onClick = onCancel, block = true)
    }
}

@Composable
private fun FailureView(message: String, onRetry: () -> Unit, onBack: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6, vertical = FS.space.s8)
            .semantics { contentDescription = "recover-failed" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            "Couldn't recover account",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            message,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )
        FSCard(padding = PaddingValues(FS.space.s4)) {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                Icon(Icons.Outlined.Info, contentDescription = null, tint = FS.colors.primary, modifier = Modifier.size(20.dp))
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("What this usually means", color = FS.colors.text, style = TextStyle(fontSize = 14.sp))
                    Text(
                        "Your recovery passkey isn't on this device. If you set up recovery on another device, make sure you're signed into the same Google account here — or use a security key. If you've never set up recovery, you'll need to do that on a device that already holds your account.",
                        color = FS.colors.textMuted,
                        style = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
                    )
                }
            }
        }
        Box(Modifier.height(FS.space.s4))
        FSPrimaryButton(label = "Try again", onClick = onRetry, block = true, large = true)
        FSGhostButton(label = "Back", onClick = onBack, block = true)
    }
}

private fun humanizedError(t: Throwable): String {
    val m = t.message?.lowercase() ?: ""
    if (m.contains("no credential") || m.contains("no recovery passkey") ||
        m.contains("nomatchingcredential") || m.contains("interrupted")
    ) {
        return "We couldn't find a recovery passkey on this device."
    }
    return t.message ?: "Recovery cancelled or unavailable."
}
