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
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalScreensClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.keystore.BlockStoreUmkStore
import com.flagshipserver.app.keystore.CloudRecoveryEnrollment
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.KeystoreIrkAccess
import com.flagshipserver.app.keystore.PasskeyCeremonyAdapter
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private enum class RecoveryMode { Choose, Setup, Restore }
private enum class CloudStatus { Unknown, NotConfigured, Configured, Failed }

@Composable
fun RecoveryScreen(nav: NavController) {
    val app = LocalAppState.current
    val flagshipServer = LocalFlagshipServerClient.current
    val screensClient = LocalScreensClient.current
    val toasts = LocalToastCenter.current
    val ctx = LocalContext.current
    val activity = ctx as? Activity
    val scope = rememberCoroutineScope()

    val blockStore = remember(ctx) { BlockStoreUmkStore(ctx.applicationContext) }
    val passkeys = remember(ctx) { PasskeyRecoveryManager(ctx.applicationContext) }

    var mode by remember { mutableStateOf(RecoveryMode.Choose) }
    var cloudStatus by remember { mutableStateOf(CloudStatus.Unknown) }
    var showReattachProgress by remember { mutableStateOf(false) }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var passphrase by remember { mutableStateOf("") }
    var passphraseConfirm by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        cloudStatus = try {
            if (blockStore.fetch() == null) CloudStatus.NotConfigured else CloudStatus.Configured
        } catch (_: Throwable) {
            CloudStatus.Failed
        }
    }
    LaunchedEffect(screensClient) {
        while (true) {
            showReattachProgress = runCatching {
                screensClient.postRecoveryStatus().report?.hasActiveReattach == true
            }.getOrDefault(false)
            delay(5_000)
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
            "CLOUD RECOVERY",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
        )
        Spacer(Modifier.height(FS.space.s4))

        if (showReattachProgress) {
            FSCard(padding = PaddingValues(FS.space.s4)) {
                Text("Re-attach progress", color = FS.colors.text, fontWeight = FontWeight.SemiBold)
                Text(
                    "See per-app re-anchoring after recovery.",
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                )
                FSGhostButton(
                    label = "View progress",
                    onClick = { nav.navigate("post-recovery") },
                    block = true,
                )
            }
            Spacer(Modifier.height(FS.space.s3))
        }

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
            )
            RecoveryMode.Setup -> SetupCard(
                working = working,
                passphrase = passphrase,
                onPassphrase = { passphrase = it },
                passphraseConfirm = passphraseConfirm,
                onPassphraseConfirm = { passphraseConfirm = it },
                onConfigure = {
                    if (activity == null) {
                        error = "Open this screen from the foreground activity to use a passkey."
                        return@SetupCard
                    }
                    scope.launch {
                        working = true; error = null
                        try {
                            val username = app.currentUser.value ?: "you"
                            // IRK access prompt up front (biometric) so the
                            // Argon2id + passkey work happens after consent.
                            val irkMaterial = KeystoreIrkAccess().resolve("Set up cloud recovery")
                            val umk = Keystore.loadOrCreateUmkSeed()
                            val acmeScalar = try {
                                Keystore.loadOrCreateAcmeAccountKeyScalar()
                            } catch (_: Throwable) {
                                null
                            }
                            // Argon2id (~1-2s) + the wrap math off the main
                            // thread; the passkey ceremony resumes on whatever
                            // dispatcher CredentialManager hops to internally.
                            val result = withContext(Dispatchers.Default) {
                                CloudRecoveryEnrollment.enroll(
                                    server = flagshipServer,
                                    passkeys = PasskeyCeremonyAdapter(passkeys, activity),
                                    irk = irkMaterial.signer,
                                    username = username,
                                    umkSeed = umk,
                                    passphrase = passphrase,
                                    passphraseConfirm = passphraseConfirm,
                                    acmeScalar = acmeScalar,
                                    now = System.currentTimeMillis(),
                                    // Slice D (D-3) — escrow the admin master root.
                                    adminRootSeed = Keystore.adminRootSeed(),
                                )
                            }
                            // Keep the Android Block Store copy so a new device
                            // on the same Google account auto-restores.
                            blockStore.save(
                                WrappedUmk(
                                    credentialId = result.credentialId,
                                    wrappedUmkBase64 = result.wrappedUmk,
                                ),
                            )
                            passphrase = ""; passphraseConfirm = ""
                            cloudStatus = CloudStatus.Configured
                            toasts.success("Cloud recovery configured.")
                            mode = RecoveryMode.Choose
                        } catch (t: Throwable) {
                            error = NetworkErrorHumanizer.humanize(t)
                        } finally {
                            working = false
                        }
                    }
                },
                onCancel = {
                    passphrase = ""; passphraseConfirm = ""
                    mode = RecoveryMode.Choose
                },
            )
            RecoveryMode.Restore -> RestoreCard(
                working = working,
                passphrase = passphrase,
                onPassphrase = { passphrase = it },
                onRun = {
                    if (activity == null) { error = "Open from foreground."; return@RestoreCard }
                    scope.launch {
                        working = true; error = null
                        try {
                            val envelope = blockStore.fetch()
                                ?: throw IllegalStateException("no encrypted backup on this device; cross-device restore isn't available yet")
                            val username = app.currentUser.value ?: "you"
                            // The Block Store blob was sealed with the
                            // passphrase-derived prfSalt, so re-derive it here
                            // (Argon2id off the main thread) and assert with it.
                            val secrets = withContext(Dispatchers.Default) {
                                com.flagshipserver.app.keystore.RecoveryDerivation
                                    .derivePassphraseSecrets(passphrase, username)
                            }
                            val prfSecret = passkeys.assertPrf(
                                activity, envelope.credentialId, secrets.prfSalt,
                            )
                            val seed = Recovery.unwrap(
                                wrappedUmkBase64 = envelope.wrappedUmkBase64,
                                prfSecret = prfSecret,
                            )
                            require(seed.size == 32) { "recovered UMK isn't 32 bytes" }
                            // TODO: persist seed into Keystore + invalidate cached IRK seed.
                            passphrase = ""
                            toasts.success("UMK recovered (${seed.size} bytes). Re-pair your servers next.")
                            mode = RecoveryMode.Choose
                        } catch (t: Throwable) {
                            error = NetworkErrorHumanizer.humanize(t)
                        } finally {
                            working = false
                        }
                    }
                },
                onCancel = {
                    passphrase = ""
                    mode = RecoveryMode.Choose
                },
            )
        }
        Spacer(Modifier.height(FS.space.s3))
        HowRecoveryWorksCard()
        Spacer(Modifier.height(FS.space.s8))
    }
}

@Composable
private fun ChooseCard(
    cloudStatus: CloudStatus,
    onSetup: () -> Unit,
    onRestore: () -> Unit,
) {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text("Cloud recovery", color = FS.colors.text,
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
                "Store an encrypted copy of your account key for a new Android device.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            FSPrimaryButton(label = "Set up cloud recovery", onClick = onSetup, block = true)
            FSGhostButton(label = "Restore from cloud", onClick = onRestore, block = true)
        }
    }
}

@Composable
private fun SetupCard(
    working: Boolean,
    passphrase: String,
    onPassphrase: (String) -> Unit,
    passphraseConfirm: String,
    onPassphraseConfirm: (String) -> Unit,
    onConfigure: () -> Unit,
    onCancel: () -> Unit,
) {
    val canSubmit = !working &&
        passphrase.length >= CloudRecoveryEnrollment.MIN_PASSPHRASE &&
        passphrase == passphraseConfirm
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text("Set up cloud recovery", color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
            FSField(
                value = passphrase,
                onValueChange = onPassphrase,
                label = "Recovery passphrase",
                helper = "8 characters minimum",
                visualTransformation = PasswordVisualTransformation(),
            )
            FSField(
                value = passphraseConfirm,
                onValueChange = onPassphraseConfirm,
                label = "Confirm passphrase",
                visualTransformation = PasswordVisualTransformation(),
            )
            FSPrimaryButton(
                label = if (working) "Configuring…" else "Configure",
                onClick = onConfigure,
                enabled = canSubmit,
                block = true,
            )
            FSGhostButton(label = "Back", onClick = onCancel)
        }
    }
}

@Composable
private fun RestoreCard(
    working: Boolean,
    passphrase: String,
    onPassphrase: (String) -> Unit,
    onRun: () -> Unit,
    onCancel: () -> Unit,
) {
    val canSubmit = !working && passphrase.length >= CloudRecoveryEnrollment.MIN_PASSPHRASE
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text("Restore from cloud", color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
            Text(
                "Enter your recovery passphrase, then confirm the passkey prompt.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            FSField(
                value = passphrase,
                onValueChange = onPassphrase,
                label = "Recovery passphrase",
                visualTransformation = PasswordVisualTransformation(),
            )
            FSPrimaryButton(
                label = if (working) "Restoring…" else "Restore",
                onClick = onRun,
                enabled = canSubmit,
                block = true,
            )
            FSGhostButton(label = "Back", onClick = onCancel)
        }
    }
}

@Composable
private fun HowRecoveryWorksCard() {
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                "How this works",
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
            )
            Text(
                "Recovery requires both your recovery passphrase and access to the Google account that holds your Flagship passkey. Together they unlock the encrypted copy of your account key; we cannot read it or reset your passphrase.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
        }
    }
}
