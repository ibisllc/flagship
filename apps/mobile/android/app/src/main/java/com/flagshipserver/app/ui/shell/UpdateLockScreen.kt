// The "Update required" lock (docs/security-notices.md section 6.5): a
// full-screen overlay above the whole app for a verified update-required
// notice. It consumes every touch, hides what is behind it from TalkBack, and
// sends system Back out of the app instead of to the screen under it. Nothing
// is deleted. It keeps three things reachable: the update (the app's own store
// listing), the account key backup (the app's existing export, above the lock)
// and Sign out (the app's existing, recovery-gated sign-out).

package com.flagshipserver.app.ui.shell

import com.flagshipserver.app.core.FSStrings
import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.R
import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.SecurityNotice
import com.flagshipserver.app.core.SecurityNoticeCopy
import com.flagshipserver.app.core.SecurityNoticeModels
import com.flagshipserver.app.core.SignOutPolicy
import com.flagshipserver.app.core.Variant
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.AlertDialog
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.TextButton
import com.flagshipserver.app.ui.components.openStoreListing
import com.flagshipserver.app.ui.screens.KeyfileExportScreen
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch

/**
 * @param unlocked the account is open on this device (its key can be exported).
 * @param onNeedUnlock the person asked for the backup while the account is
 *   behind the biometric screen: step aside to that screen, and come back after.
 */
@Composable
fun UpdateLockScreen(notice: SecurityNotice, unlocked: Boolean, onNeedUnlock: () -> Unit) {
    val ctx = LocalContext.current
    // System Back leaves the app instead of reaching what is behind the lock.
    // (Inside the key backup, the nested NavHost takes Back first.)
    BackHandler(enabled = true) { (ctx as? Activity)?.moveTaskToBack(true) }

    Box(
        Modifier
            .fillMaxSize()
            .background(FS.colors.bg)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            // Swallow every touch: Compose routes taps only to composables that declare pointer
            // input. (Not `clickable`: that would merge the whole screen into one TalkBack button.)
            .pointerInput(Unit) { detectTapGestures { } }
            .semantics { paneTitle = SecurityNoticeCopy.LOCK_TITLE }
            .testTag("update-lock"),
    ) {
        val nav = rememberNavController()
        NavHost(navController = nav, startDestination = "lock") {
            composable("lock") {
                LockCard(
                    notice = notice,
                    unlocked = unlocked,
                    onBackup = { if (unlocked) nav.navigate("keyfile-export") else onNeedUnlock() },
                )
            }
            composable("keyfile-export") { KeyfileExportScreen(nav) }
        }
    }
}

@Composable
private fun LockCard(notice: SecurityNotice, unlocked: Boolean, onBackup: () -> Unit) {
    val ctx = LocalContext.current
    val app = LocalAppState.current
    val toasts = LocalToastCenter.current
    val paired by app.isPaired.collectAsState()
    val hasRecovery by app.hasCloudRecovery.collectAsState()
    val pods by app.pods.collectAsState()
    val profiles by app.profiles.collectAsState()
    val activeCloud by app.activeCloudName.collectAsState()
    var confirmSignOut by remember { mutableStateOf(false) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val activity = ctx as? androidx.fragment.app.FragmentActivity
    val model = remember(notice, unlocked) { SecurityNoticeModels.lock(notice, unlocked) }

    Box(Modifier.fillMaxSize().padding(horizontal = FS.space.s6), contentAlignment = Alignment.Center) {
        Column(
            Modifier
                .widthIn(max = 440.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(vertical = FS.space.s6),
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
        ) {
            Text(
                model.kicker.uppercase(),
                color = FS.colors.textMuted,
                style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp, letterSpacing = 1.2.sp),
                modifier = Modifier.semantics { contentDescription = model.kicker }.testTag("update-lock-kicker"),
            )
            Text(
                model.title,
                color = FS.colors.text,
                style = MaterialTheme.typography.headlineMedium.copy(fontSize = 28.sp, fontWeight = FontWeight.Medium),
                modifier = Modifier.semantics { heading() }.testTag("update-lock-title"),
            )
            Text(
                model.body,
                color = FS.colors.text,
                style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
                modifier = Modifier.testTag("update-lock-body"),
            )
            if (model.why.isNotEmpty()) {
                Text(
                    model.why,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 15.sp, lineHeight = 21.sp),
                    modifier = Modifier.testTag("update-lock-why"),
                )
            }
            Text(
                model.reassure,
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
                modifier = Modifier.testTag("update-lock-reassure"),
            )
            Spacer(Modifier.height(FS.space.s2))
            FSPrimaryButton(
                label = model.update,
                onClick = { if (!openStoreListing(ctx)) toasts.error(SecurityNoticeCopy.UPDATE_FAILED) },
                block = true,
                large = true,
                modifier = Modifier.testTag("update-lock-update"),
            )
            // With no account on this device there is no key to back up and nothing to sign out of.
            if (paired) {
                FSSecondaryButton(
                    label = model.backup,
                    onClick = onBackup,
                    block = true,
                    large = true,
                    modifier = Modifier.testTag("update-lock-backup"),
                )
                FSSecondaryButton(
                    label = model.signOut,
                    onClick = {
                        val policy = SignOutPolicy.evaluate(
                            hasCloudRecovery = hasRecovery,
                            isDemoAccount = Variant.usesMockClients || AppState.isDemoAccount(profiles.firstOrNull { it.cloudName == activeCloud }, pods),
                        )
                        if (policy != SignOutPolicy.ALLOWED) {
                            toasts.info(FSStrings.get(R.string.set_up_account_recovery_to_use))
                        } else if (unlocked || activity == null) {
                            // `activity == null` cannot ask; the account is only
                            // let through when it is already open this session.
                            if (unlocked) confirmSignOut = true
                            else toasts.error(FSStrings.get(R.string.lost_activity_context_restart_the_app))
                        } else {
                            // This screen sits above the app lock: prove it is
                            // the owner before the sign-out question.
                            scope.launch {
                                when (val r = authenticateForSignOut(activity)) {
                                    SignOutAuth.Ok -> confirmSignOut = true
                                    SignOutAuth.Cancelled -> {}
                                    is SignOutAuth.Failed -> toasts.error(r.message)
                                }
                            }
                        }
                    },
                    block = true,
                    large = true,
                    modifier = Modifier.testTag("update-lock-signout"),
                )
            }
            Text(
                model.meta,
                color = FS.colors.textMuted.copy(alpha = 0.8f),
                style = TextStyle(fontSize = 12.sp),
                modifier = Modifier.padding(top = FS.space.s1).testTag("update-lock-meta"),
            )
        }
    }
    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            confirmButton = {
                TextButton(onClick = {
                    confirmSignOut = false
                    // Same Tier-2 sign-out as Settings: erase this device's local key
                    // material; the account and its servers are untouched.
                    Keystore.wipe()
                    app.signOut()
                }) { Text(stringResource(R.string.sign_out_2), color = FS.colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text(stringResource(R.string.cancel)) } },
            title = { Text(stringResource(R.string.sign_out)) },
            text = {
                Text(
                    stringResource(R.string.this_erases_this_devices_account_key_3),
                )
            },
        )
    }
}
