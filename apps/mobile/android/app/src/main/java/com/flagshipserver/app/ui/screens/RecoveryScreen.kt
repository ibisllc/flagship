// Recovery management (Settings): configure cloud recovery on this device —
// create a passkey for flagshipserver.com, run a PRF-extension assertion to
// derive a 32-byte secret, wrap the UMK seed under it, save the envelope to
// Block Store + post a copy to /api/recovery/register so a fresh device can
// fetch. Restoring happens on the new device, from "I already have an
// account" (RecoverAccountViewModel), never from here: this device already
// holds the account key.
//
// MIRRORS: apps/mobile/ios/Sources/FlagshipUI/Screens/RecoveryScreen.swift +
// apps/mobile/ios/Sources/Flagship/Recovery.swift.

package com.flagshipserver.app.ui.screens

import android.app.Activity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
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
import com.flagshipserver.app.keystore.WrappedUmk
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSPill
import com.flagshipserver.app.ui.components.FSPillKind
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private enum class RecoveryMode { Choose, Setup }
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
    // Why a second passkey prompt follows the create (see createPasskey).
    var note by remember { mutableStateOf<String?>(null) }
    var savedIn by remember { mutableStateOf(RecoveryProviderStore.read(ctx)) }

    LaunchedEffect(Unit) {
        cloudStatus = if (RecoveryProviderStore.isConfigured(ctx)) CloudStatus.Configured else try {
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

    FSScreen(
        title = "Cloud recovery",
        onBack = { nav.popBackStack() },
    ) {
        if (showReattachProgress) {
            FSGroup {
                FSRow(
                    title = "Re-attach progress",
                    subtitle = "See per-app re-anchoring after recovery.",
                    icon = Icons.Outlined.Sync,
                    onClick = { nav.navigate("post-recovery") },
                    modifier = Modifier.semantics { testTag = "recovery-open-reattach-progress" },
                )
            }
        }

        if (error != null) {
            ErrorCard(error!!)
        }
        if (working && note != null) {
            FSCard(padding = PaddingValues(FS.space.s3), modifier = Modifier.semantics { testTag = "recovery-second-prompt" }) {
                Text(note!!, color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(FS.space.s2))
        }

        when (mode) {
            RecoveryMode.Choose -> ChooseCard(
                cloudStatus = cloudStatus,
                savedIn = savedIn,
                onSetup = { mode = RecoveryMode.Setup },
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
                        working = true; error = null; note = null
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
                            val ceremony = PasskeyCeremonyAdapter(passkeys, activity) { note = SECOND_PASSKEY_PROMPT }
                            val result = withContext(Dispatchers.Default) {
                                CloudRecoveryEnrollment.enroll(
                                    server = flagshipServer,
                                    passkeys = ceremony,
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
                            // on the same Google account auto-restores. A
                            // convenience: the escrow on `.com` is done, so a
                            // Block Store failure doesn't fail the set-up.
                            runCatching {
                                blockStore.save(
                                    WrappedUmk(
                                        credentialId = result.credentialId,
                                        wrappedUmkBase64 = result.wrappedUmk,
                                    ),
                                )
                            }.onFailure {
                                com.flagshipserver.app.core.ErrorLog.caught(
                                    "cloud-recovery-blockstore", it, NetworkErrorHumanizer.errorCode(it),
                                )
                            }
                            passphrase = ""; passphraseConfirm = ""
                            cloudStatus = CloudStatus.Configured
                            app.setHasCloudRecovery(true)
                            savedIn = ceremony.lastProvider
                            RecoveryProviderStore.write(ctx, savedIn)
                            toasts.success("Cloud recovery configured.")
                            mode = RecoveryMode.Choose
                        } catch (t: Throwable) {
                            error = if (t is CloudRecoveryEnrollment.ValidationError) t.message
                            else NetworkErrorHumanizer.humanize(t, "cloud-recovery-setup")
                        } finally {
                            working = false; note = null
                        }
                    }
                },
                onCancel = {
                    passphrase = ""; passphraseConfirm = ""
                    mode = RecoveryMode.Choose
                },
            )
        }
        HowRecoveryWorksCard()
    }
}

@Composable
private fun ChooseCard(
    cloudStatus: CloudStatus,
    savedIn: String?,
    onSetup: () -> Unit,
) {
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Text("Cloud recovery", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                FSPill(
                    when (cloudStatus) {
                        CloudStatus.Configured -> "Configured"
                        CloudStatus.NotConfigured -> "Not set up"
                        CloudStatus.Failed -> "Couldn't check"
                        CloudStatus.Unknown -> "Checking…"
                    },
                    kind = if (cloudStatus == CloudStatus.Configured) FSPillKind.Online else FSPillKind.Idle,
                )
            }
            if (cloudStatus == CloudStatus.Configured) {
                Text(
                    "Recovery active",
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.semantics { testTag = "recovery-active" },
                )
                if (savedIn != null) {
                    Text(
                        "Your passkey is saved in $savedIn.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                Text(
                    RECOVER_ON_NEW_DEVICE,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.semantics { testTag = "recovery-new-device-hint" },
                )
            } else {
                Text(
                    "Store an encrypted copy of your account key for a new Android device.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
                FSPrimaryButton(
                    label = "Set up cloud recovery",
                    onClick = onSetup,
                    block = true,
                    modifier = Modifier.semantics { testTag = "recovery-setup" },
                )
            }
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
    FSCard {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Text("Set up cloud recovery", style = MaterialTheme.typography.titleMedium)
            Text(
                "Pick a passphrase (8+ characters) — treat it like a password and write it down somewhere safe. You'll need it, plus your passkey, to get back in on a new device. We can't reset it.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
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
            FSSecondaryButton(label = "Cancel", onClick = onCancel, enabled = !working, block = true)
        }
    }
}

@Composable
private fun HowRecoveryWorksCard() {
    FSCard {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Icon(Icons.Outlined.Info, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(24.dp))
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("How this works", style = MaterialTheme.typography.titleSmall)
                Text(
                    RECOVERY_HOW_IT_WORKS,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

/** Provider-neutral: on Android the passkey may land in Google Password
 *  Manager, Samsung Pass or another passkey app. */
internal const val RECOVERY_HOW_IT_WORKS =
    "Recovery needs both your recovery passphrase and the passkey you saved for Flagship, in Google Password Manager, Samsung Pass or another passkey app. Together they unlock the encrypted copy of your account key; we cannot read it or reset your passphrase."

/** Shown while the passkey app asks a second time right after the create. */
internal const val SECOND_PASSKEY_PROMPT =
    "Your passkey app needs one more check to hand Flagship the key it derives from your new passkey."

/** Where restoring happens (iOS RecoveryScreen's line). */
internal const val RECOVER_ON_NEW_DEVICE =
    "If you lose this device, install Flagship on a new one, choose \"Connect to an existing account,\" and recover with your passphrase."
