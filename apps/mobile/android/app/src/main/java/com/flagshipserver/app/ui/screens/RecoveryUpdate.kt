// Cloud recovery set-up shared by Settings → Cloud recovery and "Update your account recovery"
// (SEC-REPAIR-001): one passkey sheet makes a new recovery passkey whose attestation `.com` keeps,
// so it checks that passkey before it releases the recovery copy. A record made before the check
// is offered the update once per account on this device; declining changes nothing.

package com.flagshipserver.app.ui.screens

import android.app.Activity
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import com.flagshipserver.app.R
import com.flagshipserver.app.api.FlagshipServerClient
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.ErrorLog
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.HexUtil
import com.flagshipserver.app.core.HttpException
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.NetworkErrorHumanizer
import com.flagshipserver.app.core.PasskeyCheckError
import com.flagshipserver.app.core.RecoveryPasskeyText
import com.flagshipserver.app.core.RecoveryUpdateOffer
import com.flagshipserver.app.core.RecoveryUpdatePromptStore
import com.flagshipserver.app.keystore.BlockStoreUmkStore
import com.flagshipserver.app.keystore.CloudRecoveryEnrollment
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.KeystoreIrkAccess
import com.flagshipserver.app.keystore.PasskeyCeremonyAdapter
import com.flagshipserver.app.keystore.PasskeyRecoveryManager
import com.flagshipserver.app.keystore.RecoveryDerivation
import com.flagshipserver.app.keystore.WrappedUmk
import com.flagshipserver.app.ui.components.AlertDialog
import com.flagshipserver.app.ui.components.FSField
import com.flagshipserver.app.ui.components.TextButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

object CloudRecoverySetup {
    /** The passkey app the new passkey went to, when known. */
    class Done(val provider: String?)

    /**
     * Make a recovery passkey on this device and send `.com` the signed record with the passkey's
     * attestation. The IRK prompt comes first so the Argon2id and passkey work follow consent.
     */
    suspend fun enroll(
        activity: Activity,
        server: FlagshipServerClient,
        app: AppState,
        passphrase: String,
        passphraseConfirm: String,
        onSecondPrompt: () -> Unit = {},
    ): Done {
        val ctx = activity.applicationContext
        val username = app.currentUser.value ?: "you"
        val irkMaterial = KeystoreIrkAccess().resolve(FSStrings.get(R.string.set_up_cloud_recovery))
        val umk = Keystore.loadOrCreateUmkSeed()
        val acmeScalar = try {
            Keystore.loadOrCreateAcmeAccountKeyScalar()
        } catch (_: Throwable) {
            null
        }
        val ceremony = PasskeyCeremonyAdapter(PasskeyRecoveryManager(ctx), activity, onSecondPrompt)
        val result = withContext(Dispatchers.Default) {
            CloudRecoveryEnrollment.enroll(
                server = server,
                passkeys = ceremony,
                irk = irkMaterial.signer,
                irkPubHex = irkMaterial.pubHex,
                username = username,
                umkSeed = umk,
                passphrase = passphrase,
                passphraseConfirm = passphraseConfirm,
                acmeScalar = acmeScalar,
                now = System.currentTimeMillis(),
                adminRootSeed = Keystore.adminRootSeed(),
            )
        }
        // Block Store lets a new device on the same Google account restore on its own; the escrow on
        // `.com` is done, so a failure here doesn't fail the set-up.
        runCatching {
            BlockStoreUmkStore(ctx).save(WrappedUmk(credentialId = result.credentialId, wrappedUmkBase64 = result.wrappedUmk))
        }.onFailure { ErrorLog.caught("cloud-recovery-blockstore", it, NetworkErrorHumanizer.errorCode(it)) }
        app.setHasCloudRecovery(true)
        RecoveryProviderStore.write(ctx, ceremony.lastProvider)
        return Done(ceremony.lastProvider)
    }

    /** A typed passphrase is the one the record was made with: a typo would replace it. A record
     *  from before the passkey check releases on the passphrase alone, so `.com` answers that. */
    suspend fun checkPassphrase(server: FlagshipServerClient, username: String, passphrase: String) {
        if (passphrase.length < CloudRecoveryEnrollment.MIN_PASSPHRASE) {
            throw CloudRecoveryEnrollment.ValidationError(FSStrings.get(R.string.recovery_passphrase_min))
        }
        val secrets = withContext(Dispatchers.Default) { RecoveryDerivation.derivePassphraseSecrets(passphrase, username) }
        try {
            server.fetchWrappedUmkWithToken(username, HexUtil.encode(secrets.fetchToken), System.currentTimeMillis())
        } catch (e: HttpException) {
            if (RecoveryPasskeyText.codeOf(e) == null && e.status == 403) {
                throw CloudRecoveryEnrollment.ValidationError(FSStrings.get(R.string.that_passphrase_didnt_match))
            }
            throw RecoveryPasskeyText.translate(e)
        }
    }

    fun errorText(t: Throwable): String = when (t) {
        is CloudRecoveryEnrollment.ValidationError -> t.message ?: FSStrings.get(R.string.recovery_passphrase_min)
        is PasskeyCheckError -> t.message ?: FSStrings.get(R.string.recovery_passkey_invalid)
        else -> NetworkErrorHumanizer.humanize(t, "cloud-recovery-update")
    }
}

/** The helper line under a recovery passphrase field: the hint, or the minimum once typing. */
fun recoveryPassphraseHelper(passphrase: String): String =
    if (passphrase.isNotEmpty() && passphrase.length < CloudRecoveryEnrollment.MIN_PASSPHRASE) {
        FSStrings.get(R.string.recovery_passphrase_min)
    } else {
        FSStrings.get(R.string.recovery_passphrase_hint)
    }

/**
 * "Update your account recovery": [knownPassphrase] is the one just used to recover (no field
 * then); otherwise the owner types it and `.com` confirms it before anything changes.
 */
@Composable
fun RecoveryUpdateDialog(
    knownPassphrase: String?,
    onDecline: () -> Unit,
    onUpdated: () -> Unit,
) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val activity = LocalContext.current as? Activity
    val scope = rememberCoroutineScope()
    var passphrase by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val ready = knownPassphrase != null || passphrase.length >= CloudRecoveryEnrollment.MIN_PASSPHRASE
    AlertDialog(
        onDismissRequest = { if (!working) onDecline() },
        title = { Text(stringResource(R.string.recovery_update_title), modifier = Modifier.testTag("recovery-update-title")) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Text(
                    stringResource(if (knownPassphrase == null) R.string.recovery_update_body else R.string.recovery_update_body_after_recovery),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.testTag("recovery-update-body"),
                )
                if (knownPassphrase == null) {
                    FSField(
                        value = passphrase,
                        onValueChange = { passphrase = it; error = null },
                        label = stringResource(R.string.recovery_passphrase),
                        helper = recoveryPassphraseHelper(passphrase),
                        visualTransformation = PasswordVisualTransformation(),
                        enabled = !working,
                        modifier = Modifier.testTag("recovery-update-passphrase"),
                    )
                }
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("recovery-update-error"))
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = ready && !working && activity != null,
                onClick = {
                    val act = activity ?: return@TextButton
                    scope.launch {
                        working = true
                        error = null
                        try {
                            val p = knownPassphrase ?: passphrase.also { CloudRecoverySetup.checkPassphrase(server, app.currentUser.value ?: "", it) }
                            CloudRecoverySetup.enroll(act, server, app, p, p)
                            onUpdated()
                        } catch (e: kotlinx.coroutines.CancellationException) {
                            throw e
                        } catch (t: Throwable) {
                            error = CloudRecoverySetup.errorText(t)
                        } finally {
                            working = false
                        }
                    }
                },
                modifier = Modifier.testTag("recovery-update-confirm"),
            ) { Text(if (working) stringResource(R.string.recovery_update_working) else stringResource(R.string.update_2)) }
        },
        dismissButton = {
            TextButton(enabled = !working, onClick = onDecline, modifier = Modifier.testTag("recovery-update-not-now")) {
                Text(stringResource(R.string.not_now))
            }
        },
        modifier = Modifier.testTag("recovery-update"),
    )
}

/**
 * Raises "Update your account recovery" once per account on this device: right after a recovery
 * `.com` released on the passphrase alone, or when this account's record predates the check.
 */
@Composable
fun RecoveryUpdateHost() {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val toasts = LocalToastCenter.current
    val ctx: Context = LocalContext.current
    val user by app.currentUser.collectAsState()
    val pending by RecoveryUpdateOffer.pending.collectAsState()
    val checks by RecoveryUpdateOffer.checks.collectAsState()
    val store = remember(ctx) { RecoveryUpdatePromptStore.fromContext(ctx.applicationContext) }
    // null: nothing to ask; "": ask for the passphrase; else the passphrase just used.
    var shown by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(user, pending, checks) {
        val u = user?.takeIf { it.isNotEmpty() } ?: return@LaunchedEffect
        if (app.isRestrictedDevice() || app.isDemoAccountNow() || store.asked(u)) return@LaunchedEffect
        RecoveryUpdateOffer.take(u)?.let {
            shown = it.passphrase
            return@LaunchedEffect
        }
        val meta = try {
            server.recoveryRecordState(u)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }
        if (RecoveryUpdatePromptStore.shouldAsk(meta != null, meta?.passkeyRequired == true, store.asked(u))) shown = ""
    }
    val s = shown ?: return
    val u = user ?: return
    RecoveryUpdateDialog(
        knownPassphrase = s.ifEmpty { null },
        onDecline = {
            store.markAsked(u)
            RecoveryUpdateOffer.clear()
            shown = null
        },
        onUpdated = {
            store.markAsked(u)
            RecoveryUpdateOffer.clear()
            shown = null
            toasts.success(FSStrings.get(R.string.recovery_update_done))
        },
    )
}
