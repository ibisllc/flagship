// "Secure your account" — the SKIPPABLE backup nudge on the NEW-account
// onboarding path. Shown once, after the account is opened, before the
// app shell. Cloud (passkey) backup and a backup file are two independent
// ticks, both off at first; cloud is disabled when the device can't make a
// passkey (file / skip still work). Continue runs every ticked one:
//
//   Cloud → run the passkey-PRF ceremony inline (reuses
//           PasskeyRecoveryManager + Recovery + BlockStoreUmkStore,
//           exactly like RecoveryScreen); its recovery passphrase shows
//           inside the cloud row only while cloud is ticked.
//   File  → then open the existing KeyfileExportScreen (its own
//           passphrase) → into the app.
//   Skip  → a warning anchored to the Skip button → into the app.
//
// Both methods stay reachable later from Settings (Recovery + Back up
// your account key), so the "anytime in Settings" promise holds.
//
// Copy is approved + verbatim; mirror it on the other surfaces.

package com.flagshipserver.app.ui.screens

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
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
import androidx.compose.foundation.selection.toggleable
import com.flagshipserver.app.ui.components.DropdownMenu
import androidx.compose.foundation.layout.widthIn
import com.flagshipserver.app.ui.components.AlertDialog
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Checkbox
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
    val cloudSelected by vm.cloudSelected.collectAsState()
    val fileSelected by vm.fileSelected.collectAsState()
    val showSkipConfirm by vm.showSkipConfirm.collectAsState()

    val passkeys = remember(ctx) { PasskeyRecoveryManager(ctx.applicationContext) }
    val blockStore = remember(ctx) { BlockStoreUmkStore(ctx.applicationContext) }

    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var passphrase by remember { mutableStateOf("") }
    var passphraseConfirm by remember { mutableStateOf("") }
    var note by remember { mutableStateOf<String?>(null) }
    // Cloud backup finished on an earlier Continue (the file is still to do).
    var cloudDone by remember { mutableStateOf(false) }

    fun configureCloudThenContinue(then: () -> Unit) {
        if (activity == null) {
            error = FSStrings.get(R.string.open_this_screen_from_the_foreground)
            return
        }
        scope.launch {
            working = true; error = null; note = null
            try {
                val username = app.currentUser.value ?: "you"
                // Biometric IRK consent up front, then Argon2id + the wrap /
                // sign / upload off the main thread (the shared ceremony
                // mirrors recovery.js, incl. fetchTokenHash + prfSaltHash + #28).
                val irkMaterial = KeystoreIrkAccess().resolve(FSStrings.get(R.string.back_up_your_recovery_key))
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
                        irkPubHex = irkMaterial.pubHex,
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
                toasts.success(FSStrings.get(R.string.cloud_backup_configured))
                cloudDone = true
                then()
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
        largeTitle = false,
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
                checked = cloudSelected || cloudDone,
                enabled = passkeyAvailable && !working && !cloudDone,
                cd = "secure-account-option-cloud",
                onClick = { vm.toggle(SecureAccountOption.Cloud) },
            )
            // The recovery passphrase hardens the cloud blob (mirrors
            // recovery.js #enroll) and belongs to cloud backup only, so it
            // shows inside the cloud row while cloud is ticked.
            if (cloudSelected && !cloudDone) {
                Column(
                    verticalArrangement = Arrangement.spacedBy(FS.space.s2),
                    modifier = Modifier.padding(start = FS.space.s4, end = FS.space.s4, bottom = FS.space.s4),
                ) {
                    FSSectionHeader(stringResource(R.string.recovery_passphrase))
                    FSField(
                        value = passphrase,
                        onValueChange = { passphrase = it },
                        label = stringResource(R.string.recovery_passphrase_8_characters),
                        helper = recoveryPassphraseHelper(passphrase),
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.semantics { contentDescription = "secure-account-passphrase" },
                    )
                    FSField(
                        value = passphraseConfirm,
                        onValueChange = { passphraseConfirm = it },
                        label = stringResource(R.string.confirm_passphrase),
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.semantics { contentDescription = "secure-account-passphrase-confirm" },
                    )
                }
            }
            FSDivider()
            OptionRow(
                title = SecureAccountViewModel.FILE_LABEL,
                subtitle = SecureAccountViewModel.FILE_SUBLABEL,
                checked = fileSelected,
                enabled = !working,
                cd = "secure-account-option-file",
                onClick = { vm.toggle(SecureAccountOption.File) },
            )
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

        val cloudPending = cloudSelected && !cloudDone
        val cloudReady = passphrase.length >= CloudRecoveryEnrollment.MIN_PASSPHRASE &&
            passphrase == passphraseConfirm
        val canContinue = (cloudPending || fileSelected) && (!cloudPending || cloudReady)
        Column(
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
            modifier = Modifier.padding(top = FS.space.s2),
        ) {
            FSPrimaryButton(
                label = if (working) stringResource(R.string.setting_up) else SecureAccountViewModel.CONTINUE,
                onClick = {
                    // Every ticked backup runs: cloud first (it stays here for
                    // its passphrase and passkey), then the file export.
                    val afterCloud = { if (fileSelected) onSaveFile() else onDone() }
                    if (cloudPending) configureCloudThenContinue(afterCloud) else afterCloud()
                },
                block = true,
                enabled = canContinue && !working,
                modifier = Modifier.semantics { contentDescription = "secure-account-continue" },
            )
            // The skip warning drops down from the Skip button itself.
            Box {
                FSSecondaryButton(
                    label = SecureAccountViewModel.SKIP,
                    onClick = { vm.requestSkip() },
                    block = true,
                    enabled = !working,
                    modifier = Modifier.semantics { contentDescription = "secure-account-skip" },
                )
                DropdownMenu(
                    expanded = showSkipConfirm,
                    onDismissRequest = { vm.cancelSkip() },
                    modifier = Modifier.widthIn(max = 320.dp),
                ) {
                    Column(
                        verticalArrangement = Arrangement.spacedBy(FS.space.s2),
                        modifier = Modifier.padding(horizontal = FS.space.s4, vertical = FS.space.s2),
                    ) {
                        Text(
                            SecureAccountViewModel.SKIP_WARNING,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.semantics { contentDescription = "secure-account-skip-warning" },
                        )
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(FS.space.s2, Alignment.End),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            TextButton(
                                onClick = { vm.cancelSkip() },
                                modifier = Modifier.semantics { contentDescription = "secure-account-skip-back" },
                            ) {
                                Text(SecureAccountViewModel.SKIP_BACK)
                            }
                            TextButton(
                                onClick = {
                                    vm.cancelSkip()
                                    onDone()
                                },
                                modifier = Modifier.semantics { contentDescription = "secure-account-skip-anyway" },
                            ) {
                                Text(SecureAccountViewModel.SKIP_CONFIRM, color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun OptionRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    enabled: Boolean,
    cd: String,
    onClick: () -> Unit,
) {
    val alpha = if (enabled || checked) 1f else 0.5f
    ListItem(
        headlineContent = {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface.copy(alpha = alpha))
        },
        supportingContent = {
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha))
        },
        leadingContent = {
            Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
        },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier
            .fillMaxWidth()
            .fsFocusRing(8.dp).toggleable(value = checked, enabled = enabled, role = Role.Checkbox, onValueChange = { onClick() })
            .semantics { contentDescription = cd },
    )
}
