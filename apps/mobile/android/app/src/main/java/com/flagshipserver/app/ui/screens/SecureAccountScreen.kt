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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.RecoveryEnvelopeRequest
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.keystore.BlockStoreUmkStore
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.PasskeyAvailability
import com.flagshipserver.app.keystore.PasskeyRecoveryManager
import com.flagshipserver.app.keystore.Recovery
import com.flagshipserver.app.keystore.WrappedUmk
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.SecureAccountOption
import com.flagshipserver.app.viewmodels.SecureAccountViewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import kotlinx.coroutines.launch

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
            .background(FS.colors.bg),
    ) {
        NavHost(navController = nav, startDestination = "secure") {
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

    fun configureCloudThenContinue() {
        if (activity == null) {
            error = "Open this screen from the foreground to use a passkey."
            return
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
                app.setHasCloudRecovery(true)
                toasts.success("Cloud backup configured.")
                onDone()
            } catch (t: Throwable) {
                // Never trap the user: surface the error and let them
                // pick the file option or skip instead.
                error = t.message ?: "Couldn't set up cloud backup. Try a backup file instead."
            } finally {
                working = false
            }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6, vertical = FS.space.s12)
            .semantics { contentDescription = "secure-account" },
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            text = SecureAccountViewModel.TITLE,
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )
        Text(
            text = SecureAccountViewModel.BODY,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        )

        Spacer(Modifier.height(FS.space.s2))

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
        OptionRow(
            title = SecureAccountViewModel.FILE_LABEL,
            subtitle = SecureAccountViewModel.FILE_SUBLABEL,
            selected = selected == SecureAccountOption.File,
            enabled = !working,
            cd = "secure-account-option-file",
            onClick = { vm.select(SecureAccountOption.File) },
        )

        if (error != null) {
            FSCard(padding = PaddingValues(FS.space.s3)) {
                Text(error!!, color = FS.colors.danger, style = TextStyle(fontSize = 13.sp))
            }
        }

        Spacer(Modifier.height(FS.space.s2))

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
            large = true,
            enabled = vm.canContinue && !working,
            modifier = Modifier.semantics { contentDescription = "secure-account-continue" },
        )
        FSGhostButton(
            label = SecureAccountViewModel.SKIP,
            onClick = { vm.requestSkip() },
            block = true,
            enabled = !working,
            modifier = Modifier.semantics { contentDescription = "secure-account-skip" },
        )
    }

    if (showSkipConfirm) {
        AlertDialog(
            onDismissRequest = { vm.cancelSkip() },
            confirmButton = {
                TextButton(onClick = {
                    vm.cancelSkip()
                    onDone()
                }) {
                    Text(SecureAccountViewModel.SKIP_CONFIRM, color = FS.colors.danger)
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
    val border = if (selected) FS.colors.primary else FS.colors.border
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FS.radius.md))
            .background(FS.colors.surface)
            .border(BorderStroke(if (selected) 2.dp else 1.dp, border), RoundedCornerShape(FS.radius.md))
            .let { if (enabled) it.clickable { onClick() } else it }
            .alpha(if (enabled) 1f else 0.5f)
            .padding(FS.space.s4)
            .semantics { contentDescription = cd },
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
    ) {
        Icon(
            if (selected) Icons.Filled.RadioButtonChecked else Icons.Filled.RadioButtonUnchecked,
            contentDescription = null,
            tint = if (selected) FS.colors.primary else FS.colors.textMuted,
            modifier = Modifier.size(22.dp),
        )
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
            Text(
                title,
                color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                subtitle,
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp, lineHeight = 19.sp),
            )
        }
    }
}
