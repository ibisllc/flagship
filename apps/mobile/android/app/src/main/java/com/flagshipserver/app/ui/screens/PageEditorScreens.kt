// A post's editor (docs/social-tab.md): New post and a post's Edit, opened from the Social tab's Profile. The post is a
// draft, grayed on the page until it is published; link previews are fetched here. Also the one-time rules dialog.

package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.voici.VoiciCard
import com.flagshipserver.app.core.voici.VoiciCopy
import com.flagshipserver.app.core.voici.VoiciJpeg
import com.flagshipserver.app.core.voici.VoiciOwner
import com.flagshipserver.app.core.voici.VoiciPageState
import com.flagshipserver.app.core.voici.VoiciPageUi
import com.flagshipserver.app.core.voici.VoiciPost
import com.flagshipserver.app.core.voici.VoiciPostLink
import com.flagshipserver.app.core.voici.VoiciProfile
import com.flagshipserver.app.core.voici.VoiciProfileLink
import com.flagshipserver.app.core.voici.VoiciText
import com.flagshipserver.app.core.voici.VoiciTextField
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSNote
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSSecondaryButton
import com.flagshipserver.app.ui.components.FSSectionHeader
import com.flagshipserver.app.ui.components.OutlinedTextField
import com.flagshipserver.app.ui.components.Switch
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date

private fun cps(s: String) = s.codePointCount(0, s.length)

/** "Page and message rules", once per device before the first publish or the first sign-in approval (§9.7). */
@Composable
fun VoiciRulesDialog(onAgree: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.voici_rules_title)) },
        text = { Text(stringResource(R.string.voici_rules_body)) },
        confirmButton = { FSGhostButton(stringResource(R.string.voici_rules_agree), onAgree, modifier = Modifier.testTag("voici-rules-agree")) },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), onDismiss) },
    )
}

private class PostLinkDraft(val url: String, val host: String, card: VoiciCard?, var fetched: Boolean) {
    var card by mutableStateOf(card)
    var removed by mutableStateOf(false)
}

@Composable
fun PostEditorScreen(nav: NavController, postId: String) {
    val center = LocalVoiciCenter.current ?: return
    val page by center.page.collectAsState()
    val existing = page.working?.chunks?.flatten()?.firstOrNull { it.id == postId }
    val scope = rememberCoroutineScope()
    val toasts = LocalToastCenter.current
    var text by remember(postId) { mutableStateOf(existing?.text ?: "") }
    var saving by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    val found = remember(text) { VoiciText.findVoiciLinks(text).map { it.url }.distinct().take(3) }
    val drafts = remember(postId) { HashMap<String, PostLinkDraft>() }
    existing?.links?.forEach { l -> if (l.url !in drafts) drafts[l.url] = PostLinkDraft(l.url, VoiciText.voiciUrlHost(l.url) ?: "", l.card, true) }

    FSScreen(title = stringResource(if (existing == null) R.string.voici_new_post else R.string.voici_edit), onBack = { nav.popBackStack() }, titleTag = "post-editor-title") {
        OutlinedTextField(
            value = text, onValueChange = { if (cps(it) <= 2000) text = it },
            label = { Text(stringResource(R.string.voici_post_text)) }, minLines = 5,
            supportingText = { Text(stringResource(R.string.voici_counter, cps(text), 2000)) },
            modifier = Modifier.fillMaxWidth().testTag("post-text"),
        )
        if (found.isNotEmpty()) {
            FSSectionHeader(stringResource(R.string.voici_post_links_found))
            found.forEach { url ->
                val d = drafts.getOrPut(url) { PostLinkDraft(url, VoiciText.voiciUrlHost(url) ?: "", null, false) }
                FSCard {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                        Icon(Icons.Outlined.Link, contentDescription = null)
                        Column(Modifier.weight(1f)) {
                            Text(d.card?.title ?: d.host, style = MaterialTheme.typography.bodyMedium)
                            Text(
                                when {
                                    d.removed -> stringResource(R.string.voici_card_none)
                                    d.card != null -> d.card!!.site
                                    else -> url
                                },
                                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (!d.removed) FSGhostButton(stringResource(R.string.voici_remove_card), { d.removed = true; d.card = null })
                    }
                }
            }
            Text(stringResource(R.string.voici_card_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (saving) Text(stringResource(R.string.voici_card_fetching), style = MaterialTheme.typography.bodySmall)
        FSPrimaryButton(stringResource(R.string.voici_post_save), {
            val prepared = VoiciText.prepareVoiciText(VoiciTextField.postText, text.trim())
            val t = prepared.valueOrNull()
            if (t == null) {
                toasts.error(VoiciCopy.sendError(prepared.code))
                return@FSPrimaryButton
            }
            saving = true
            scope.launch {
                val links = VoiciText.findVoiciLinks(t).map { it.url }.distinct().take(3).map { url ->
                    val d = drafts[url]
                    val card = when {
                        d?.removed == true -> null
                        d?.fetched == true -> d.card
                        else -> withContext(Dispatchers.IO) { center.fetchCard(url) }
                    }
                    VoiciPostLink(url, card)
                }
                val now = System.currentTimeMillis()
                if (existing == null) center.edit("post-add", post = VoiciPost(VoiciOwner.randomHex(16), now, null, t, links))
                else center.edit("post-edit", post = existing.copy(text = t, links = links, editedAt = now))
                saving = false
                nav.popBackStack()
            }
        }, enabled = !saving && text.isNotBlank(), block = true, modifier = Modifier.testTag("post-save"))
        if (existing != null) FSGhostButton(stringResource(R.string.voici_delete_post), { deleting = true }, modifier = Modifier.testTag("post-delete"))
    }
    if (deleting && existing != null) AlertDialog(
        onDismissRequest = { deleting = false },
        title = { Text(stringResource(R.string.voici_delete_post_title)) },
        confirmButton = {
            FSGhostButton(stringResource(R.string.voici_delete), {
                deleting = false
                scope.launch { center.edit("post-delete", postId = existing.id); nav.popBackStack() }
            }, modifier = Modifier.testTag("post-delete-confirm"))
        },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), { deleting = false }) },
    )
}
