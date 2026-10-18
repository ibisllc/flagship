// "Secure your account" — the SKIPPABLE backup nudge on the NEW-account
// onboarding path. Shown once, after the account is opened, before the
// app shell. Cloud (passkey) is pre-selected when available; otherwise
// it's disabled and nothing is pre-selected (file / skip still work).
//
//   Cloud → run the passkey-PRF ceremony inline (reuses
//           PasskeyRecoveryManager + Recovery + BlockStoreUmkStore,
//           exactly like RecoveryScreen) → into the app.
//   File  → open the existing KeyfileExportScreen → into the app.
//   Skip  → confirm dialog → into the app.
//
// Both methods stay reachable later from Settings (Recovery + Back up
// your account key), so the "anytime in Settings" promise holds.
//
// Copy is approved + verbatim; mirror it on the other surfaces.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.ui.components.fsFocusRing
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import android.app.Activity
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.foundation.selection.selectable
import com.flagshipserver.app.ui.components.AlertDialog
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import com.flagshipserver.app.ui.components.RadioButton
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.keystore.BlockStoreUmkStore
import com.flagshipserver.app.keystore.CloudRecoveryEnrollment
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.KeystoreIrkAccess
import com.flagshipserver.app.keystore.PasskeyAvailability
import com.flagshipserver.app.keystore.PasskeyCeremonyAdapter
import com.flagshipserver.app.keystore.PasskeyRecoveryManager
import com.flagshipserver.app.keystore.WrappedUmk
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.SecureAccountOption
import com.flagshipserver.app.viewmodels.SecureAccountViewModel
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Full-screen overlay host for the "Secure your account" step. Rendered
 * by AppRoot ABOVE the shell after a new account opens. Owns its own tiny
 * NavHost so the file option can reuse KeyfileExportScreen verbatim.
 *
 * @param onDismiss clears the nudge flag → the overlay disappears and the
 *                  shell (already mounted underneath) takes over.
 */
@Composable
fun SecureAccountOverlay(onDismiss: () -> Unit) {
    val nav = rememberNavController()
    Box(
        Modifier
            .fillMaxSize()
            .background(FS.colors.bg)
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)),
    ) {
        NavHost(navController = nav, startDestination = "secure",
        enterTransition = com.flagshipserver.app.ui.theme.FSMotion.enter,
        exitTransition = com.flagshipserver.app.ui.theme.FSMotion.exit,
        popEnterTransition = com.flagshipserver.app.ui.theme.FSMotion.popEnter,
        popExitTransition = com.flagshipserver.app.ui.theme.FSMotion.popExit,
    ) {
            composable("secure") {
                SecureAccountScreen(
                    onDone = onDismiss,
                    onSaveFile = { nav.navigate("keyfile-export") },
                )
            }
            composable("keyfile-export") {
                // Reuse the existing keyfile exporter verbatim. The file is
                // saved via SAF inside it; the onSaved seam then dismisses
                // the overlay into the app.
                KeyfileExportScreen(nav, onSaved = onDismiss)
            }
        }
    }
}

/**
 * @param onDone       proceed into the app (after cloud configured / skip).
 * @param onSaveFile   open the existing KeyfileExportScreen.
 * @param passkeyAvailableOverride test seam; null → probe the platform.
 */
@Composable
fun SecureAccountScreen(
    onDone: () -> Unit,
    onSaveFile: () -> Unit,
    passkeyAvailableOverride: Boolean? = null,
) {
    val ctx = LocalContext.current
    val app = LocalAppState.current
    val flagshipServer = LocalFlagshipServerClient.current
    val toasts = LocalToastCenter.current
    val activity = ctx as? Activity
    val scope = rememberCoroutineScope()

    val passkeyAvailable = passkeyAvailableOverride
        ?: remember(ctx) { PasskeyAvailability.isAvailable(ctx.applicationContext) }

    val vm = remember(passkeyAvailable) {
        SecureAccountViewModel(passkeyAvailable = passkeyAvailable)
    }
    val selected by vm.selected.collectAsState()
    val showSkipConfirm by vm.showSkipConfirm.collectAsState()

    val passkeys = remember(ctx) { PasskeyRecoveryManager(ctx.applicationContext) }
    val blockStore = remember(ctx) { BlockStoreUmkStore(ctx.applicationContext) }

    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var passphrase by remember { mutableStateOf("") }
    var passphraseConfirm by remember { mutableStateOf("") }
    var note by remember { mutableStateOf<String?>(null) }

    fun configureCloudThenContinue() {
        if (activity == null) {
            error = "Open this screen from the foreground to use a passkey."
            return
        }
        scope.launch {
            working = true; error = null; note = null
            try {
                val username = app.currentUser.value ?: "you"
                // Biometric IRK consent up front, then Argon2id + the wrap /
                // sign / upload off the main thread (the shared ceremony
                // mirrors recovery.js, incl. fetchTokenHash + prfSaltHash + #28).
                val irkMaterial = KeystoreIrkAccess().resolve("Back up your recovery key")
                val umk = Keystore.loadOrCreateUmkSeed()
                val acmeScalar = try {
                    Keystore.loadOrCreateAcmeAccountKeyScalar()
                } catch (_: Throwable) {
                    null
                }
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
                // Block Store is a convenience copy; the escrow is done.
                runCatching {
                    blockStore.save(
                        WrappedUmk(
                            credentialId = result.credentialId,
                            wrappedUmkBase64 = result.wrappedUmk,
                        ),
                    )
                }.onFailure {
                    com.flagshipserver.app.core.ErrorLog.caught(
                        "secure-account-blockstore", it, NetworkErrorHumanizer.errorCode(it),
                    )
                }
                app.setHasCloudRecovery(true)
                RecoveryProviderStore.write(ctx, ceremony.lastProvider)
                passphrase = ""; passphraseConfirm = ""
                toasts.success("Cloud backup configured.")
                onDone()
            } catch (t: Throwable) {
                // Never trap the user: surface the error and let them
                // pick the file option or skip instead.
                error = if (t is CloudRecoveryEnrollment.ValidationError) t.message
                else NetworkErrorHumanizer.humanize(t, "secure-account-cloud")
            } finally {
                working = false; note = null
            }
        }
    }

    FSScreen(
        title = SecureAccountViewModel.TITLE,
        modifier = Modifier.semantics { contentDescription = "secure-account" },
        subtitle = SecureAccountViewModel.BODY,
    ) {
        FSGroup {
            OptionRow(
                title = SecureAccountViewModel.CLOUD_LABEL,
                subtitle = if (passkeyAvailable)
                    SecureAccountViewModel.CLOUD_SUBLABEL
                else
                    SecureAccountViewModel.CLOUD_UNAVAILABLE_HINT,
                selected = selected == SecureAccountOption.Cloud,
                enabled = passkeyAvailable && !working,
                cd = "secure-account-option-cloud",
                onClick = { vm.select(SecureAccountOption.Cloud) },
            )
            FSDivider()
            OptionRow(
                title = SecureAccountViewModel.FILE_LABEL,
                subtitle = SecureAccountViewModel.FILE_SUBLABEL,
                selected = selected == SecureAccountOption.File,
                enabled = !working,
                cd = "secure-account-option-file",
                onClick = { vm.select(SecureAccountOption.File) },
            )
        }

        // Cloud backup is gated on a recovery passphrase that hardens the
        // cloud blob (mirrors recovery.js #enroll). Surfaced only when the
        // cloud option is selected so the file / skip flows stay one-tap.
        if (selected == SecureAccountOption.Cloud) {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                FSSectionHeader("Recovery passphrase")
                FSField(
                    value = passphrase,
                    onValueChange = { passphrase = it },
                    label = "Recovery passphrase (8+ characters)",
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.semantics { contentDescription = "secure-account-passphrase" },
                )
                FSField(
                    value = passphraseConfirm,
                    onValueChange = { passphraseConfirm = it },
                    label = "Confirm passphrase",
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.semantics { contentDescription = "secure-account-passphrase-confirm" },
                )
            }
        }
        if (working && note != null) {
            FSCard(padding = PaddingValues(FS.space.s3)) {
                Text(note!!, color = FS.colors.textMuted, style = MaterialTheme.typography.bodySmall)
            }
        }

        if (error != null) {
            FSCard {
                Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
        }

        val cloudReady = passphrase.length >= CloudRecoveryEnrollment.MIN_PASSPHRASE &&
            passphrase == passphraseConfirm
        val canContinue = when (selected) {
            SecureAccountOption.Cloud -> cloudReady
            SecureAccountOption.File -> true
            null -> false
        }
        Column(
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
            modifier = Modifier.padding(top = FS.space.s2),
        ) {
            FSPrimaryButton(
                label = if (working) "Setting up…" else SecureAccountViewModel.CONTINUE,
                onClick = {
                    when (selected) {
                        SecureAccountOption.Cloud -> configureCloudThenContinue()
                        SecureAccountOption.File -> onSaveFile()
                        null -> {}
                    }
                },
                block = true,
                enabled = canContinue && !working,
                modifier = Modifier.semantics { contentDescription = "secure-account-continue" },
            )
            FSSecondaryButton(
                label = SecureAccountViewModel.SKIP,
                onClick = { vm.requestSkip() },
                block = true,
                enabled = !working,
                modifier = Modifier.semantics { contentDescription = "secure-account-skip" },
            )
        }
    }

    if (showSkipConfirm) {
        AlertDialog(
            onDismissRequest = { vm.cancelSkip() },
            confirmButton = {
                TextButton(onClick = {
                    vm.cancelSkip()
                    onDone()
                }) {
                    Text(SecureAccountViewModel.SKIP_CONFIRM, color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { vm.cancelSkip() }) {
                    Text(SecureAccountViewModel.SKIP_BACK)
                }
            },
            title = { Text(SecureAccountViewModel.TITLE) },
            text = { Text(SecureAccountViewModel.SKIP_WARNING) },
        )
    }
}

@Composable
private fun OptionRow(
    title: String,
    subtitle: String,
    selected: Boolean,
    enabled: Boolean,
    cd: String,
    onClick: () -> Unit,
) {
    val alpha = if (enabled) 1f else 0.5f
    ListItem(
        headlineContent = {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface.copy(alpha = alpha))
        },
        supportingContent = {
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha))
        },
        leadingContent = {
            RadioButton(selected = selected, onClick = null, enabled = enabled)
        },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier
            .fillMaxWidth()
            .fsFocusRing(8.dp).selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .semantics { contentDescription = cd },
    )
}
