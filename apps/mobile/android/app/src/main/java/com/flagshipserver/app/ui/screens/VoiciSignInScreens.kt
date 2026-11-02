// The visitor's approval of "Sign in with Flagship" (docs/voici-and-messages.md §6.1, §11.4), and Settings →
// Messages (§11.3): the websites this account is signed in to, rotating the inbox key, the rules.

package com.flagshipserver.app.ui.screens

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.navigation.NavController
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.QrRelay
import com.flagshipserver.app.core.voici.VoiciCopy
import com.flagshipserver.app.core.voici.VoiciSignInFlow
import com.flagshipserver.app.core.voici.VoiciSignInLink
import com.flagshipserver.app.core.voici.VoiciSignInPhase
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSNote
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

/** Builds the flow for a link: MainActivity provides the live pipe; the gym a scripted one. */
fun interface VoiciSignInFlows {
    fun create(): VoiciSignInFlow?
}

val LocalVoiciSignInFlows = androidx.compose.runtime.staticCompositionLocalOf<VoiciSignInFlows?> { null }

@Composable
fun VoiciSignInDialog(rawLink: String, onDismiss: () -> Unit) {
    val factory = LocalVoiciSignInFlows.current
    val center = LocalVoiciCenter.current
    val link = remember(rawLink) { VoiciSignInLink.parse(rawLink) }
    val flow = remember(rawLink) { factory?.create() }
    val scope = rememberCoroutineScope()
    var askRules by remember { mutableStateOf(false) }
    val page = center?.page?.collectAsState()?.value
    val phase by (flow?.phase ?: kotlinx.coroutines.flow.MutableStateFlow<VoiciSignInPhase>(VoiciSignInPhase.Failed("malformed"))).collectAsState()
    LaunchedEffect(flow, link) {
        if (flow == null || link == null) return@LaunchedEffect
        flow.start(link)
    }
    DisposableEffect(flow) { onDispose { flow?.cancel() } }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        FSScreen(title = stringResource(R.string.voici_signin_title), onBack = onDismiss, titleTag = "voici-signin-title") {
            when (val p = if (link == null || flow == null) VoiciSignInPhase.Failed("malformed") else phase) {
                VoiciSignInPhase.Connecting -> Busy(stringResource(R.string.voici_signin_connecting))
                is VoiciSignInPhase.Waiting -> Busy(stringResource(R.string.voici_signin_waiting, QrRelay.formatMatchCode(p.code)))
                is VoiciSignInPhase.Review -> {
                    FSCard(Modifier.testTag("voici-signin-review")) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(FS.space.s3), modifier = Modifier.fillMaxWidth()) {
                            val bmp = remember(p.avatar) { p.avatar?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() } }
                            if (bmp != null) Image(bmp, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(72.dp).clip(CircleShape))
                            Text(stringResource(R.string.voici_signin_question, p.displayName), style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("voici-signin-question"))
                            Text(stringResource(R.string.voici_signin_code, QrRelay.formatMatchCode(p.code)), style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace), modifier = Modifier.testTag("voici-signin-code"))
                        }
                    }
                    FSNote(stringResource(R.string.voici_signin_pseudonym, VoiciCopy.visitorName(p.pseudonymPub)))
                    FSNote(stringResource(R.string.voici_signin_privacy))
                    FSPrimaryButton(stringResource(R.string.voici_approve), {
                        if (page?.rulesAccepted == false) askRules = true
                        else scope.launch { flow!!.approve(FSStrings.get(R.string.voici_signin_reason)) }
                    }, block = true, modifier = Modifier.testTag("voici-signin-approve"))
                    FSSecondaryButton(stringResource(R.string.voici_cancel), onDismiss, block = true, modifier = Modifier.testTag("voici-signin-cancel"))
                }
                VoiciSignInPhase.Working -> Busy(stringResource(R.string.voici_signin_working))
                VoiciSignInPhase.Done -> {
                    FSNote(stringResource(R.string.voici_signin_done), Modifier.testTag("voici-signin-done"))
                    FSPrimaryButton(stringResource(R.string.voici_close), onDismiss, block = true, modifier = Modifier.testTag("voici-signin-done-close"))
                }
                is VoiciSignInPhase.Failed -> {
                    FSNote(VoiciCopy.signInRefusal(p.code, p.retryAfterSec), Modifier.testTag("voici-signin-failed"))
                    FSPrimaryButton(stringResource(R.string.voici_close), onDismiss, block = true)
                }
            }
        }
    }
    if (askRules) VoiciRulesDialog(onAgree = {
        askRules = false
        scope.launch {
            center?.acceptRules()
            flow?.approve(FSStrings.get(R.string.voici_signin_reason))
        }
    }, onDismiss = { askRules = false })
}

@Composable
private fun Busy(text: String) {
    FSCard {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(FS.space.s3), modifier = Modifier.fillMaxWidth()) {
            CircularProgressIndicator()
            Text(text, modifier = Modifier.testTag("voici-signin-status"))
        }
    }
}

@Composable
fun MessagesSettingsScreen(nav: NavController) {
    val center = LocalVoiciCenter.current ?: return
    val ui by center.messages.collectAsState()
    val page by center.page.collectAsState()
    val scope = rememberCoroutineScope()
    val toasts = LocalToastCenter.current
    var rules by remember { mutableStateOf(false) }
    LaunchedEffect(center) { runCatching { center.syncState() } }
    FSScreen(title = stringResource(R.string.voici_settings_title), onBack = { nav.popBackStack() }, titleTag = "messages-settings-title") {
        FSGroup(header = stringResource(R.string.voici_sites)) {
            if (ui.state.signedInSites.isEmpty()) {
                FSRow(title = stringResource(R.string.voici_sites_none), modifier = Modifier.testTag("messages-sites-none"))
            }
            ui.state.signedInSites.forEach { s ->
                FSRow(
                    title = stringResource(R.string.voici_site_row, s.pageId.take(8)),
                    subtitle = stringResource(R.string.voici_site_signed_in, DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(s.at))),
                    icon = Icons.Outlined.Public,
                    trailing = {
                        FSGhostButton(stringResource(R.string.voici_sign_out), {
                            scope.launch { center.signOutSite(s)?.let { toasts.error(VoiciCopy.sendError(it)) } }
                        }, modifier = Modifier.testTag("messages-site-sign-out"))
                    },
                )
            }
        }
        if (page.canPublish && page.publishedSeq > 0) {
            FSCard {
                Text(stringResource(R.string.voici_rotate_body), style = MaterialTheme.typography.bodyMedium)
                FSSecondaryButton(stringResource(R.string.voici_rotate), {
                    scope.launch {
                        if (center.rotateInbox(FSStrings.get(R.string.voici_publish_reason))) toasts.success(FSStrings.get(R.string.voici_rotate_done))
                        else center.page.value.error?.let { toasts.error(VoiciCopy.publishError(it)) }
                    }
                }, modifier = Modifier.testTag("messages-rotate"))
            }
        }
        FSGroup {
            FSRow(title = stringResource(R.string.voici_rules_open), onClick = { rules = true }, modifier = Modifier.testTag("messages-rules"))
        }
    }
    if (rules) VoiciRulesDialog(onAgree = { rules = false; scope.launch { center.acceptRules() } }, onDismiss = { rules = false })
}
