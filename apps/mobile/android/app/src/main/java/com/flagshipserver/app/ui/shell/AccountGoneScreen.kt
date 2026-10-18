// The "This account was removed" screen (docs/account-gone.md): a full-screen
// overlay over whatever is on screen when `.com` says this device's own account
// no longer exists. Like the update lock it is an overlay, not a screen: the
// sheets, menus and dialogs behind it are closed first (LocalAppLocked) and the
// app under it is hidden from TalkBack.
//
// The first button saves the person's servers' data (the rescue, which needs
// nothing from `.com` and so works with the account gone); it is disabled with
// "Coming soon" until Android has the rescue, and "Save my data first" opens the
// account-key backup meanwhile. The two ways out remove this device's copy of
// the account, and both show a warning in place of the buttons first while the
// device holds an admin key or a server session, because removing them ends the
// rescue. Only "Remove anyway" removes.

package com.flagshipserver.app.ui.shell

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.flagshipserver.app.api.SessionStoring
import com.flagshipserver.app.core.AccountGone
import com.flagshipserver.app.core.AccountGoneCopy
import com.flagshipserver.app.core.AdminKeyWarning
import com.flagshipserver.app.core.AppState
import com.flagshipserver.app.core.LocalAppState
import com.flagshipserver.app.core.LocalSessionStore
import com.flagshipserver.app.core.Variant
import com.flagshipserver.app.keystore.Keystore
import com.flagshipserver.app.ui.components.FSDangerButton
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.screens.KeyfileExportScreen
import com.flagshipserver.app.ui.theme.FS

/** Forget this device's copy of the gone account. Talks to no server. */
fun removeGoneAccountFromDevice(context: android.content.Context, app: AppState, sessions: SessionStoring) {
    com.flagshipserver.app.core.KeyBackupStore.forget(context, app.currentUser.value)
    runCatching { Keystore.wipe() }
    runCatching { Keystore.setPushTokenId(null) }
    runCatching {
        sessions.podTokenIds().forEach { sessions.setSessionToken(null, forPodId = it) }
        sessions.clear()
    }
    app.signOut()
}

@Composable
fun AccountGoneScreen(name: String) {
    val ctx = LocalContext.current
    BackHandler(enabled = true) { (ctx as? Activity)?.moveTaskToBack(true) }
    Box(
        Modifier
            .fillMaxSize()
            .background(FS.colors.bg)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .pointerInput(Unit) { detectTapGestures { } }
            .semantics { paneTitle = AccountGoneCopy.TITLE }
            .testTag("account-gone"),
    ) {
        val nav = rememberNavController()
        NavHost(navController = nav, startDestination = "gone") {
            composable("gone") { GoneCard(name, nav) }
            // Until the rescue lands here, "Save my data first" opens the account-key backup.
            composable("keyfile-export") { KeyfileExportScreen(nav) }
        }
    }
}

@Composable
private fun GoneCard(name: String, nav: NavController) {
    val ctx = LocalContext.current
    val app = LocalAppState.current
    val sessions = LocalSessionStore.current
    // Set while the removal warning stands in place of the buttons: true = after "Create a new account".
    var warning by remember { mutableStateOf<Boolean?>(null) }
    val needsWarning = remember {
        AdminKeyWarning.needsRemovalWarning(
            holdsAdminRoot = Variant.forceAdminRoot || runCatching { Keystore.hasAdminRoot() }.getOrDefault(false),
            holdsServerSession = sessions.podTokenIds().isNotEmpty(),
        )
    }
    fun leave(thenCreate: Boolean) {
        AccountGone.createNext = thenCreate
        removeGoneAccountFromDevice(ctx, app, sessions)
    }

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
                AccountGoneCopy.TITLE,
                color = FS.colors.text,
                style = MaterialTheme.typography.headlineMedium.copy(fontSize = 28.sp, fontWeight = FontWeight.Medium),
                modifier = Modifier.semantics { heading() }.testTag("account-gone-title"),
            )
            Text(
                AccountGoneCopy.BODY,
                color = FS.colors.text,
                style = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
                modifier = Modifier.testTag("account-gone-body"),
            )
            Text(
                AccountGoneCopy.account(name),
                color = FS.colors.textMuted,
                style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp),
                modifier = Modifier.testTag("account-gone-name"),
            )
            val thenCreate = warning
            if (thenCreate == null) {
                // The rescue is not built on Android yet: the button leads, disabled, and says so.
                FSPrimaryButton(
                    label = AccountGoneCopy.SAVE,
                    onClick = { },
                    enabled = false,
                    block = true,
                    large = true,
                    modifier = Modifier.testTag("account-gone-save"),
                )
                Text(
                    AccountGoneCopy.COMING_SOON,
                    color = FS.colors.textMuted,
                    style = TextStyle(fontSize = 13.sp),
                    modifier = Modifier.testTag("account-gone-coming-soon"),
                )
                FSSecondaryButton(
                    label = AccountGoneCopy.CREATE,
                    onClick = { if (needsWarning) warning = true else leave(true) },
                    block = true,
                    large = true,
                    modifier = Modifier.testTag("account-gone-create"),
                )
                FSGhostButton(
                    label = AccountGoneCopy.REMOVE,
                    onClick = { if (needsWarning) warning = false else leave(false) },
                    block = true,
                    modifier = Modifier.testTag("account-gone-remove"),
                )
            } else {
                // In place of the buttons; only "Remove anyway" removes (back and taps elsewhere do nothing).
                Text(
                    AdminKeyWarning.REMOVE_TITLE,
                    color = FS.colors.text,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.semantics { heading() }.testTag("account-gone-warning-title"),
                )
                Text(
                    AdminKeyWarning.REMOVE_MESSAGE,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 15.sp, lineHeight = 21.sp),
                    modifier = Modifier.testTag("account-gone-warning-text"),
                )
                FSPrimaryButton(
                    label = AdminKeyWarning.SAVE_FIRST,
                    onClick = { warning = null; nav.navigate("keyfile-export") },
                    block = true,
                    large = true,
                    modifier = Modifier.testTag("account-gone-save-first"),
                )
                FSDangerButton(
                    label = AdminKeyWarning.REMOVE_ANYWAY,
                    onClick = { leave(thenCreate) },
                    block = true,
                    modifier = Modifier.testTag("account-gone-remove-anyway"),
                )
            }
        }
    }
}
