// v1.2 Phase 4 — Settings → Account security. Kotlin/Compose mirror
// of iOS AccountSecurityScreen.swift. Surfaces the account-type badge
// + the four-step enrollment flow + a disable affordance.

package com.flagshipserver.app.ui.screens

import android.app.Activity
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavController
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalFlagshipServerClient
import com.flagshipserver.app.keystore.CloudRecoveryEnrollment
import com.flagshipserver.app.core.GymSeams
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.keystore.KeystoreIrkAccess
import com.flagshipserver.app.keystore.PasskeyCeremonyAdapter
import com.flagshipserver.app.keystore.PasskeyRecoveryManager
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.viewmodels.AccountSecurityPhase
import com.flagshipserver.app.viewmodels.AccountSecurityViewModel
import com.flagshipserver.app.viewmodels.RotateAdminRootPhase
import com.flagshipserver.app.viewmodels.RotateAdminRootViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun AccountSecurityScreen(nav: NavController) {
    val app = LocalAppState.current
    val server = LocalFlagshipServerClient.current
    val vm: AccountSecurityViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                AccountSecurityViewModel(
                    server = server,
                    username = { app.currentUser.value },
                )
            }
        },
    )
    val phase = vm.phase.collectAsState().value
    val accountType = vm.accountType.collectAsState().value
    val totpEnrolledAt = vm.totpEnrolledAt.collectAsState().value
    val scope = rememberCoroutineScope()

    var showDisableDialog by remember { mutableStateOf(false) }
    var disableCode by remember { mutableStateOf("") }
    var showEnableSheet by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.load() }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = FS.space.s6, vertical = FS.space.s8),
        verticalArrangement = Arrangement.spacedBy(FS.space.s4),
    ) {
        Text(
            "Account security",
            color = FS.colors.text,
            style = TextStyle(fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.Medium),
        )

        FSCard(padding = PaddingValues(FS.space.s4)) {
            Text(
                if (accountType == "multi") "Multi-device + 2FA" else "Single-device account",
                color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                modifier = Modifier.semantics { contentDescription = "account-security-badge" },
            )
            Spacer(Modifier.height(FS.space.s2))
            Text(
                if (accountType == "multi")
                    "Recovery requires a 6-digit TOTP code (or a recovery code) plus a 24-hour grace window."
                else
                    "Recovery uses a 3-day waiting period during which your other devices can object.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
        }

        if (accountType == "multi") {
            Text(
                "Currently enabled",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                "Your TOTP secret was generated on this device on ${formatDate(totpEnrolledAt)}. " +
                    "Store your recovery codes somewhere safe — they're the only way back in if " +
                    "your authenticator app is lost.",
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp),
            )
            FSDangerButton(
                label = "Disable multi-device + 2FA",
                onClick = { showDisableDialog = true },
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = "account-security-disable-btn" },
            )
        } else {
            Text(
                "Why enable this?",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                "A second factor outside Google's account recovery. If your Google password " +
                    "is ever compromised, the attacker still needs a live 6-digit code from " +
                    "your authenticator app to take over your account.",
                color = FS.colors.text,
                style = TextStyle(fontSize = 14.sp),
            )
            FSPrimaryButton(
                label = "Enable multi-device + 2FA",
                onClick = { showEnableSheet = true },
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = "account-security-enable-btn" },
            )
        }
        if (phase is AccountSecurityPhase.Failed) {
            Text(
                phase.message,
                color = FS.colors.danger,
                style = TextStyle(fontSize = 13.sp),
                modifier = Modifier.semantics { contentDescription = "account-security-failed-msg" },
            )
        }

        // Slice D (§5) — "Rotate admin key". Shown ONLY on a device that holds
        // the admin master root (greyed/absent otherwise).
        if (GymSeams.forceAdminRoot || Keystore.hasAdminRoot()) {
            AdminRootRotateCard(server = server, username = app.currentUser.value ?: "")
        }
    }

    if (showEnableSheet) {
        AccountSecurityEnableSheet(
            vm = vm,
            onDone = {
                showEnableSheet = false
                scope.launch { vm.load() }
            },
        )
    }

    if (showDisableDialog) {
        AlertDialog(
            onDismissRequest = { showDisableDialog = false },
            title = { Text("Disable multi-device + 2FA?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Text(
                        "Drops your TOTP secret + recovery codes. The account goes back to " +
                            "single-device + 3-day recovery grace. Refused while other " +
                            "trusted devices exist.",
                    )
                    OutlinedTextField(
                        value = disableCode,
                        onValueChange = { disableCode = it },
                        label = { Text("6-digit code or recovery code") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val code = disableCode
                    disableCode = ""
                    showDisableDialog = false
                    scope.launch { vm.disableEnrollment(code) }
                }) {
                    Text("Disable", color = FS.colors.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = {
                    disableCode = ""
                    showDisableDialog = false
                }) { Text("Cancel") }
            },
        )
    }
}

/** Slice D (§5) — the owner-facing "Rotate admin key" control. Mints a fresh
 *  admin master root, signs the old→new proof, submits it, and re-pins the new
 *  root locally. Type-to-confirm gate + a hard warning that rotation cuts off
 *  every OTHER admin device that held only the old bare root. When cloud
 *  recovery is enrolled, a follow-up step collects the recovery passphrase and
 *  re-wraps the NEW root under the existing credential (D-3 re-escrow) —
 *  otherwise a post-rotation recovery would restore the dead OLD root. */
@Composable
private fun AdminRootRotateCard(
    server: com.flagshipserver.app.api.FlagshipServerClient,
    username: String,
) {
    val ctx = LocalContext.current
    val activity = ctx as? Activity
    val passkeys = remember(ctx) { PasskeyRecoveryManager(ctx.applicationContext) }
    val vm: RotateAdminRootViewModel = viewModel(
        key = "rotate-admin-root",
        factory = viewModelFactory {
            initializer {
                RotateAdminRootViewModel(
                    server = server,
                    username = username,
                    // D-3 re-escrow — same ceremony wiring as RecoveryScreen's
                    // enroll(): biometric IRK consent up front, Argon2id + the
                    // wrap math off the main thread, the passkey PRF assert via
                    // the Activity-bound adapter.
                    reEscrow = { passphrase, newSeed ->
                        val act = activity
                            ?: throw IllegalStateException("Open this screen from the foreground to use a passkey.")
                        val irkMaterial = KeystoreIrkAccess().resolve("Update your recovery backup")
                        withContext(Dispatchers.Default) {
                            CloudRecoveryEnrollment.reEscrowAdminRoot(
                                server = server,
                                passkeys = PasskeyCeremonyAdapter(passkeys, act),
                                irk = irkMaterial.signer,
                                username = username,
                                passphrase = passphrase,
                                newAdminRootSeed = newSeed,
                                now = System.currentTimeMillis(),
                            )
                        }
                    },
                )
            }
        },
    )
    val phase = vm.phase.collectAsState().value
    val scope = rememberCoroutineScope()
    var showConfirm by remember { mutableStateOf(false) }
    var confirmText by remember { mutableStateOf("") }
    var reEscrowPassphrase by remember { mutableStateOf("") }
    var skippedRecoveryUpdate by remember { mutableStateOf(false) }

    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(
                "Admin key",
                color = FS.colors.text,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                modifier = Modifier.semantics { contentDescription = "admin-root-rotate-title" },
            )
            Text(
                "Rotating your admin key mints a new one and cuts off every OTHER " +
                    "admin device that held the old key. Use this if an admin device " +
                    "was lost or you want to revoke another admin. Your other data and " +
                    "devices stay signed in.",
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
            )
            when (phase) {
                is RotateAdminRootPhase.Rotating -> Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                ) {
                    CircularProgressIndicator()
                    Text("Rotating…", color = FS.colors.textMuted)
                }
                is RotateAdminRootPhase.Done -> {
                    Text(
                        "Admin key rotated. Your boxes adopt the new key on their next check-in.",
                        color = FS.colors.success,
                        style = TextStyle(fontSize = 13.sp),
                        modifier = Modifier.semantics { contentDescription = "admin-root-rotate-done" },
                    )
                    if (skippedRecoveryUpdate) {
                        Text(
                            "Your recovery backup still holds your old admin key. " +
                                "Re-run recovery setup to fix this.",
                            color = FS.colors.danger,
                            style = TextStyle(fontSize = 13.sp),
                            modifier = Modifier.semantics { contentDescription = "admin-root-reescrow-skipped-warning" },
                        )
                    }
                }
                is RotateAdminRootPhase.DoneNeedsRecoveryUpdate -> {
                    Text(
                        "Your admin key changed. Enter your recovery passphrase to update " +
                            "your recovery backup — otherwise recovery would restore the " +
                            "OLD admin key.",
                        color = FS.colors.text,
                        style = TextStyle(fontSize = 13.sp),
                        modifier = Modifier.semantics { contentDescription = "admin-root-reescrow-explainer" },
                    )
                    OutlinedTextField(
                        value = reEscrowPassphrase,
                        onValueChange = { reEscrowPassphrase = it },
                        label = { Text("Recovery passphrase") },
                        visualTransformation = PasswordVisualTransformation(),
                        enabled = !phase.updating,
                        modifier = Modifier
                            .fillMaxWidth()
                            .semantics { contentDescription = "admin-root-reescrow-passphrase" },
                    )
                    if (phase.errorMessage != null) {
                        Text(
                            phase.errorMessage,
                            color = FS.colors.danger,
                            style = TextStyle(fontSize = 13.sp),
                            modifier = Modifier.semantics { contentDescription = "admin-root-reescrow-error" },
                        )
                    }
                    if (phase.updating) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                        ) {
                            CircularProgressIndicator()
                            Text("Updating recovery backup…", color = FS.colors.textMuted)
                        }
                    } else {
                        FSPrimaryButton(
                            label = "Update recovery backup",
                            onClick = {
                                val passphrase = reEscrowPassphrase
                                scope.launch {
                                    vm.updateRecoveryBackup(passphrase)
                                    if (vm.phase.value is RotateAdminRootPhase.Done) {
                                        reEscrowPassphrase = ""
                                    }
                                }
                            },
                            modifier = Modifier
                                .fillMaxWidth()
                                .semantics { contentDescription = "admin-root-reescrow-btn" },
                        )
                        TextButton(
                            onClick = {
                                reEscrowPassphrase = ""
                                skippedRecoveryUpdate = true
                                vm.skipRecoveryUpdate()
                            },
                            modifier = Modifier.semantics { contentDescription = "admin-root-reescrow-skip" },
                        ) { Text("Skip for now") }
                    }
                }
                is RotateAdminRootPhase.Failed -> Text(
                    phase.message,
                    color = FS.colors.danger,
                    style = TextStyle(fontSize = 13.sp),
                    modifier = Modifier.semantics { contentDescription = "admin-root-rotate-failed" },
                )
                RotateAdminRootPhase.Idle -> Unit
            }
            FSDangerButton(
                label = "Rotate admin key",
                onClick = { showConfirm = true },
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = "admin-root-rotate-btn" },
            )
        }
    }

    if (showConfirm) {
        AlertDialog(
            onDismissRequest = { showConfirm = false; confirmText = "" },
            title = { Text("Rotate admin key?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Text(
                        "This cuts off every other admin device that held the old key. " +
                            "It can't be undone. Type ROTATE to confirm.",
                    )
                    OutlinedTextField(
                        value = confirmText,
                        onValueChange = { confirmText = it },
                        label = { Text("Type ROTATE") },
                        modifier = Modifier.semantics { contentDescription = "admin-root-rotate-confirm-field" },
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = confirmText.trim().equals("ROTATE", ignoreCase = true),
                    onClick = {
                        showConfirm = false
                        confirmText = ""
                        scope.launch { vm.rotate() }
                    },
                ) { Text("Rotate", color = FS.colors.danger) }
            },
            dismissButton = {
                TextButton(onClick = { showConfirm = false; confirmText = "" }) { Text("Cancel") }
            },
        )
    }
}

/** Four-step enrollment dialog. Step indices follow the spec literally:
 *  1. Explainer + Continue.
 *  2. POST /enroll-begin → QR + manual key.
 *  3. Sample code → POST /enroll-confirm.
 *  4. Recovery codes display, gated by "I've saved these".
 */
@Composable
private fun AccountSecurityEnableSheet(
    vm: AccountSecurityViewModel,
    onDone: () -> Unit,
) {
    val phase = vm.phase.collectAsState().value
    val scope = rememberCoroutineScope()
    var sampleCode by remember { mutableStateOf("") }
    var savedRecoveryCodes by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = {
            // Step-4 (Confirmed) MUST gate dismissal — losing the
            // codes is too dangerous to let a stray tap drop them.
            if (phase !is AccountSecurityPhase.Confirmed || savedRecoveryCodes) {
                vm.dismissEnrollment()
                onDone()
            }
        },
        title = { Text("Enable multi-device + 2FA") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                when (phase) {
                    is AccountSecurityPhase.Idle, AccountSecurityPhase.Beginning ->
                        Step1(beginning = phase is AccountSecurityPhase.Beginning)
                    is AccountSecurityPhase.Staged -> Step2(
                        staged = phase,
                        sampleCode = sampleCode,
                        onSampleCodeChange = { sampleCode = it },
                    )
                    AccountSecurityPhase.Confirming -> Step3Pending()
                    is AccountSecurityPhase.Confirmed -> Step4(
                        codes = phase.recoveryCodes,
                        saved = savedRecoveryCodes,
                        onSavedChange = { savedRecoveryCodes = it },
                    )
                    is AccountSecurityPhase.Failed -> FailedRow(phase.message)
                    AccountSecurityPhase.Disabling, AccountSecurityPhase.Disabled -> Unit
                }
            }
        },
        confirmButton = {
            when (phase) {
                is AccountSecurityPhase.Idle, AccountSecurityPhase.Beginning -> TextButton(
                    onClick = { scope.launch { vm.beginEnrollment() } },
                    enabled = phase !is AccountSecurityPhase.Beginning,
                    modifier = Modifier.semantics { contentDescription = "account-security-step1-continue" },
                ) { Text("Continue") }
                is AccountSecurityPhase.Staged -> TextButton(
                    onClick = { scope.launch { vm.confirmEnrollment(sampleCode) } },
                    enabled = sampleCode.trim().length == 6,
                    modifier = Modifier.semantics { contentDescription = "account-security-verify-btn" },
                ) { Text("Verify code") }
                AccountSecurityPhase.Confirming -> Unit
                is AccountSecurityPhase.Confirmed -> TextButton(
                    onClick = { vm.dismissEnrollment(); onDone() },
                    enabled = savedRecoveryCodes,
                    modifier = Modifier.semantics { contentDescription = "account-security-done-btn" },
                ) { Text("Done") }
                is AccountSecurityPhase.Failed -> TextButton(
                    onClick = { vm.dismissEnrollment(); sampleCode = "" },
                ) { Text("Start over") }
                AccountSecurityPhase.Disabling, AccountSecurityPhase.Disabled -> Unit
            }
        },
        dismissButton = {
            TextButton(
                onClick = {
                    if (phase !is AccountSecurityPhase.Confirmed || savedRecoveryCodes) {
                        vm.dismissEnrollment()
                        onDone()
                    }
                },
                enabled = phase !is AccountSecurityPhase.Confirmed || savedRecoveryCodes,
            ) { Text("Cancel") }
        },
    )
}

@Composable
private fun Step1(beginning: Boolean) {
    Text(
        "Step 1 of 4",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
    )
    Text(
        "You'll need an authenticator app like 1Password, Google Authenticator, or Authy. " +
            "We'll show a QR code and a manual key — scan or paste either one.",
        color = FS.colors.text,
    )
    Text(
        "After 2FA is on, account recovery becomes a 24-hour grace window that requires " +
            "your 6-digit code (or a recovery code) instead of the 3-day waiting period.",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 13.sp),
    )
    if (beginning) {
        CircularProgressIndicator()
    }
}

@Composable
private fun Step2(
    staged: AccountSecurityPhase.Staged,
    sampleCode: String,
    onSampleCodeChange: (String) -> Unit,
) {
    Text(
        "Step 2 of 4 — scan or paste",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
    )
    FSCard(padding = PaddingValues(FS.space.s4)) {
        val image = decodeBase64Png(staged.qrPngBase64)
        if (image != null) {
            Image(
                bitmap = image.asImageBitmap(),
                contentDescription = "TOTP QR code",
                modifier = Modifier
                    .size(200.dp())
                    .semantics { contentDescription = "account-security-qr" },
            )
        } else {
            Text(
                staged.otpauthUrl,
                color = FS.colors.text,
                style = TextStyle(fontSize = 12.sp, fontFamily = FontFamily.Monospace),
            )
        }
    }
    Text(
        "Or paste this manual key:",
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 12.sp),
    )
    Text(
        staged.secret,
        color = FS.colors.text,
        style = TextStyle(fontSize = 14.sp, fontFamily = FontFamily.Monospace),
        modifier = Modifier.semantics { contentDescription = "account-security-manual-secret" },
    )
    OutlinedTextField(
        value = sampleCode,
        onValueChange = onSampleCodeChange,
        label = { Text("6-digit code") },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        modifier = Modifier
            .fillMaxWidth()
            .semantics { contentDescription = "account-security-sample-code" },
    )
}

@Composable
private fun Step3Pending() {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
        CircularProgressIndicator()
        Text("Verifying your code…", color = FS.colors.textMuted)
    }
}

@Composable
private fun Step4(
    codes: List<String>,
    saved: Boolean,
    onSavedChange: (Boolean) -> Unit,
) {
    Text(
        "Step 4 of 4 — save your recovery codes",
        color = FS.colors.text,
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
    )
    Text(
        "Print these or store them in a password manager. Each code works once if you " +
            "lose your authenticator. They're the ONLY way back in.",
        color = FS.colors.text,
    )
    FSCard(padding = PaddingValues(FS.space.s4)) {
        Column(
            verticalArrangement = Arrangement.spacedBy(4.dp()),
            modifier = Modifier.semantics { contentDescription = "account-security-recovery-codes" },
        ) {
            codes.forEach { code ->
                Text(
                    code,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 14.sp, fontFamily = FontFamily.Monospace),
                )
            }
        }
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.semantics { contentDescription = "account-security-saved-toggle" },
    ) {
        Checkbox(checked = saved, onCheckedChange = onSavedChange)
        Text("I've saved these somewhere safe", color = FS.colors.text)
    }
}

@Composable
private fun FailedRow(message: String) {
    Text(
        "Something went wrong",
        color = FS.colors.danger,
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
    )
    Text(
        message,
        color = FS.colors.text,
        style = TextStyle(fontSize = 13.sp),
        modifier = Modifier.semantics { contentDescription = "account-security-failed-msg" },
    )
}

private fun decodeBase64Png(base64: String): android.graphics.Bitmap? {
    return try {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    } catch (_: Throwable) {
        null
    }
}

private fun formatDate(ms: Long?): String {
    if (ms == null) return "an unknown date"
    val f = SimpleDateFormat("MMM d, yyyy", Locale.getDefault())
    return f.format(Date(ms))
}

private fun Int.dp(): androidx.compose.ui.unit.Dp = androidx.compose.ui.unit.Dp(this.toFloat())
