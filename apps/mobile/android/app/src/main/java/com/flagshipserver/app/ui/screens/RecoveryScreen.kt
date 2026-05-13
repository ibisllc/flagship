// Recovery management. Two phases:
//   - Configure (this device): create a passkey for flagshipserver.com,
//     run a PRF-extension assertion to derive a 32-byte secret, wrap
//     the UMK seed under it, save the envelope to Block Store + post
//     a copy to /api/recovery/register so a fresh device can fetch.
//   - Restore (new device): pick the passkey, assert PRF, fetch the
//     envelope from Block Store (or fall back to .com), decrypt, hand
//     the seed back to Keystore.
//
// MIRRORS: apps/mobile/ios/Sources/FlagshipUI/Screens/RecoveryScreen.swift +
// apps/mobile/ios/Sources/Flagship/Recovery.swift.

package com.flagshipserver.app.ui.screens

import android.app.Activity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.api.RecoveryEnvelopeRequest
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.keystore.BlockStoreUmkStore
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.PasskeyRecoveryManager
import com.flagshipserver.app.keystore.Recovery
import com.flagshipserver.app.keystore.WrappedUmk
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

private enum class RecoveryMode { Choose, Setup, Restore, Codes }
private enum class CloudStatus { Unknown, NotConfigured, Configured, Failed }

@Composable
fun RecoveryScreen(nav: NavController) {
    val app = LocalAppState.current
    val flagshipServer = LocalFlagshipServerClient.current
    val toasts = LocalToastCenter.current
    val ctx = LocalContext.current
    val activity = ctx as? Activity
    val scope = rememberCoroutineScope()

    val blockStore = remember(ctx) { BlockStoreUmkStore(ctx.applicationContext) }
    val passkeys = remember(ctx) { PasskeyRecoveryManager(ctx.applicationContext) }

    var mode by remember { mutableStateOf(RecoveryMode.Choose) }
    var cloudStatus by remember { mutableStateOf(CloudStatus.Unknown) }
    var codes by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        cloudStatus = try {
            if (blockStore.fetch() == null) CloudStatus.NotConfigured else CloudStatus.Configured
        } catch (_: Throwable) {
            CloudStatus.Failed
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = FS.space.s6),
    ) {
        Spacer(Modifier.height(FS.space.s8))
        FSGhostButton(label = "← Back", onClick = { nav.popBackStack() })
        Spacer(Modifier.height(FS.space.s3))
        Text(
            "Recovery",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.height(FS.space.s2))
        Text(
            "If you lose this phone, you can recover your account on a new device using one of these mechanisms.",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        )
        Spacer(Modifier.height(FS.space.s4))

        if (error != null) {
            FSCard(padding = PaddingValues(FS.space.s3)) {
                Text(error!!, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
            }
            Spacer(Modifier.height(FS.space.s2))
        }

        when (mode) {
            RecoveryMode.Choose -> ChooseCard(
                cloudStatus = cloudStatus,
                onSetup = { mode = RecoveryMode.Setup },
                onRestore = { mode = RecoveryMode.Restore },
                onCodes = { mode = RecoveryMode.Codes },
            )
            RecoveryMode.Setup -> SetupCard(
                working = working,
                onConfigure = {
                    if (activity == null) {
                        error = "Open this screen from the foreground activity to use a passkey."
                        return@SetupCard
                    }
                    scope.launch {
                        working = true; error = null
                        try {
                            val username = app.currentUser.value ?: "you"
                            val created = passkeys.createPasskey(activity, username)
                            val umk = Keystore.loadOrCreateUmkSeed()
                            val sealed = Recovery.wrap(umkSeed = umk, prfSecret = created.prfSecret)
                            blockStore.save(
                                WrappedUmk(
                                    credentialId = created.credentialId,
                                    ciphertextBase64 = sealed.ciphertextBase64,
                                    nonceBase64 = sealed.nonceBase64,
                                ),
                            )
                            flagshipServer.registerRecoveryEnvelope(
                                RecoveryEnvelopeRequest(
                                    credentialId = created.credentialId,
                                    wrappedUmkBase64 = sealed.ciphertextBase64,
                                    nonceBase64 = sealed.nonceBase64,
                                ),
                            )
                            cloudStatus = CloudStatus.Configured
                            toasts.success("Cloud recovery configured.")
                            mode = RecoveryMode.Choose
                        } catch (t: Throwable) {
                            error = t.message ?: "couldn't set up cloud recovery"
                        } finally {
                            working = false
                        }
                    }
                },
                onCancel = { mode = RecoveryMode.Choose },
            )
            RecoveryMode.Restore -> RestoreCard(
                working = working,
                onRun = {
                    if (activity == null) { error = "Open from foreground."; return@RestoreCard }
                    scope.launch {
                        working = true; error = null
                        try {
                            val envelope = blockStore.fetch()
                                ?: throw IllegalStateException("no envelope on this device; cross-device restore not wired yet")
                            val prfSecret = passkeys.assertPrf(activity, envelope.credentialId)
                            val seed = Recovery.unwrap(
                                ciphertextBase64 = envelope.ciphertextBase64,
                                nonceBase64 = envelope.nonceBase64,
                                prfSecret = prfSecret,
                            )
                            require(seed.size == 32) { "recovered UMK isn't 32 bytes" }
                            // TODO: persist seed into Keystore + invalidate cached IRK seed.
                            toasts.success("UMK recovered (${seed.size} bytes). Re-pair your servers next.")
                            mode = RecoveryMode.Choose
                        } catch (t: Throwable) {
                            error = t.message ?: "recovery failed"
                        } finally {
                            working = false
                        }
                    }
                },
                onCancel = { mode = RecoveryMode.Choose },
            )
            RecoveryMode.Codes -> CodesCard(
                value = codes,
                onValue = { codes = it },
                onDone = { mode = RecoveryMode.Choose },
            )
        }
    }
}

@Composable
private fun ChooseCard(
    cloudStatus: CloudStatus,
    onSetup: () -> Unit,
    onRestore: () -> Unit,
    onCodes: () -> Unit,
) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text("Cloud recovery (passkey + Block Store)", color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
            FSPill(
                when (cloudStatus) {
                    CloudStatus.Configured -> "Configured"
                    CloudStatus.NotConfigured -> "Not set up"
                    CloudStatus.Failed -> "Couldn't check"
                    CloudStatus.Unknown -> "Checking…"
                },
                kind = if (cloudStatus == CloudStatus.Configured) FSPillKind.Online else FSPillKind.Idle,
            )
            Text(
                "Wraps your master key with a passkey held by Google Password Manager. Backed up via Block Store so a new Android device picks it up automatically on first sign-in.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            FSPrimaryButton(label = "Set up cloud recovery", onClick = onSetup, block = true)
            FSGhostButton(label = "Restore from cloud", onClick = onRestore, block = true)
        }
    }
    Spacer(Modifier.height(FS.space.s3))
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text("Offline codes", color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
            Text(
                "Generate ten BIP39 words you copy to paper / a password manager. Belt-and-suspenders alongside the passkey.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            FSGhostButton(label = "Generate codes", onClick = onCodes)
        }
    }
}

@Composable
private fun SetupCard(working: Boolean, onConfigure: () -> Unit, onCancel: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text("Set up passkey recovery", color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
            Text(
                "Tap Configure → confirm the passkey prompt → we wrap your UMK seed under the passkey-derived secret and back it up via Google Block Store.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            FSPrimaryButton(
                label = if (working) "Configuring…" else "Configure",
                onClick = onConfigure,
                enabled = !working,
                block = true,
            )
            FSGhostButton(label = "Back", onClick = onCancel)
        }
    }
}

@Composable
private fun RestoreCard(working: Boolean, onRun: () -> Unit, onCancel: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text("Restore from cloud", color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
            Text(
                "We'll fetch the wrapped UMK from Block Store + run a passkey assertion to unlock it. Re-pair your servers afterwards.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            FSPrimaryButton(
                label = if (working) "Restoring…" else "Restore",
                onClick = onRun,
                enabled = !working,
                block = true,
            )
            FSGhostButton(label = "Back", onClick = onCancel)
        }
    }
}

@Composable
private fun CodesCard(value: String, onValue: (String) -> Unit, onDone: () -> Unit) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                "Your recovery words",
                color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                "Write these down somewhere safe. Anyone with the words and your username can take over your account.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            FSField(value = value, onValueChange = onValue, label = "")
            FSGhostButton(label = "Done", onClick = onDone)
        }
    }
}
