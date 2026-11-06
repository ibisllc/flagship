// The voi.ci page editor (docs/voici-and-messages.md §11.2): the Public switch and the linkability warning (O1), photo,
// name, bio, links, theme, Accept messages, posts, a preview drawn by the page's own rules. Every change is a draft,
// grayed ("Not published yet"), until the one bottom bar's Publish on an admin device; elsewhere it waits for one.

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

@Composable
private fun VoiciAvatar(bytes: ByteArray?, size: androidx.compose.ui.unit.Dp, name: String) {
    val bmp = remember(bytes) { bytes?.let { runCatching { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }.getOrNull() } }
    if (bmp != null) {
        Image(bmp, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(size).clip(CircleShape))
    } else {
        Box(Modifier.size(size).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) {
            Text(name.take(1).uppercase(), style = MaterialTheme.typography.titleLarge)
        }
    }
}

private class LinkDraft(url: String, label: String) {
    var url by mutableStateOf(url)
    var label by mutableStateOf(label)
}

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

@Composable
fun PageEditorScreen(nav: NavController) {
    val center = LocalVoiciCenter.current ?: return
    val page by center.page.collectAsState()
    val working = page.working ?: return
    val scope = rememberCoroutineScope()
    val toasts = LocalToastCenter.current
    val context = LocalContext.current

    var name by remember(working.profile) { mutableStateOf(working.profile.displayName) }
    var bio by remember(working.profile) { mutableStateOf(working.profile.bio) }
    var theme by remember(working.profile) { mutableStateOf(working.profile.theme) }
    var avatar by remember(working.profile) { mutableStateOf(working.profile.avatar) }
    val links = remember(working.profile) { mutableStateListOf(*working.profile.links.map { LinkDraft(it.url, it.label) }.toTypedArray()) }
    var photoError by remember { mutableStateOf(false) }
    val flow = rememberPagePublicFlow(center)
    /** Records the fields as one profile draft (it replaces this device's earlier one); assigned below. */
    var commitProfile: () -> Unit = {}

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        scope.launch {
            val sha = withContext(Dispatchers.IO) {
                runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
                    ?.let(VoiciJpeg::avatar)?.let(center::putImage)
            }
            photoError = sha == null
            if (sha != null) {
                avatar = sha
                commitProfile()
            }
        }
    }

    fun buildProfile(): VoiciProfile? {
        val n = VoiciText.prepareVoiciText(VoiciTextField.displayName, name.trim()).valueOrNull() ?: return null
        val b = VoiciText.prepareVoiciText(VoiciTextField.bio, bio.trim()).valueOrNull() ?: return null
        val out = ArrayList<VoiciProfileLink>()
        var mail = 0
        for (l in links) {
            val url = l.url.trim()
            if (VoiciText.checkVoiciLinkUrl(url, true) != null) return null
            if (url.startsWith("mailto:") && ++mail > 1) return null
            val label = VoiciText.prepareVoiciText(VoiciTextField.linkLabel, l.label.trim().ifEmpty { VoiciText.voiciUrlHost(url) ?: url }.take(40)).valueOrNull() ?: return null
            out += VoiciProfileLink(url, label, if (url.startsWith("https://")) VoiciText.voiciLinkSite(url) else null)
        }
        return VoiciProfile(n, b, avatar, theme, out)
    }
    commitProfile = {
        val p = buildProfile()
        if (p != null && p != center.page.value.working?.profile) center.scope.launch { center.edit("profile", profile = p) }
    }
    val draftProfile = buildProfile()
    val profileChanged = draftProfile != null && draftProfile != working.profile
    val unpublished = page.pendingCount + if (profileChanged && !page.pendingProfile) 1 else 0
    // Leaving the editor keeps what was typed, as a draft.
    val latestCommit by androidx.compose.runtime.rememberUpdatedState({ commitProfile() })
    androidx.compose.runtime.DisposableEffect(Unit) { onDispose { latestCommit() } }
    PagePublicDialogs(flow)

    FSScreen(
        title = stringResource(R.string.voici_editor_title), onBack = { nav.popBackStack() }, titleTag = "page-editor-title",
        bottomBar = { PagePublishBar(page, unpublished) { commitProfile(); flow.publishAll() } },
    ) {
        FSCard(Modifier.testTag("page-public-row")) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.voici_public), style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold), modifier = Modifier.weight(1f))
                PagePublicSwitch(page, flow)
            }
            if (!page.canPublish) Text(stringResource(R.string.voici_admin_only_publish), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        FSCard(Modifier.testTag("page-warning")) {
            Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
                Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = FS.colors.warning)
                Text(stringResource(R.string.voici_warning), style = MaterialTheme.typography.bodyMedium)
            }
        }
        if (page.takenDown) FSNote(VoiciCopy.publishError("taken-down"), Modifier.testTag("page-taken-down"))
        if (!page.canPublish && page.pendingCount > 0) FSNote(stringResource(R.string.voici_waiting_for_admin), Modifier.testTag("page-waiting-admin"))

        FSSectionHeader(stringResource(R.string.voici_photo))
        FSCard {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s4)) {
                VoiciAvatar(center.image(avatar), 72.dp, name)
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    FSSecondaryButton(stringResource(R.string.voici_choose_photo), {
                        picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    }, modifier = Modifier.testTag("page-choose-photo"))
                    if (avatar != null) FSGhostButton(stringResource(R.string.voici_remove_photo), { avatar = null; commitProfile() })
                }
            }
            if (photoError) Text(stringResource(R.string.voici_photo_failed), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }

        OutlinedTextField(
            value = name, onValueChange = { if (cps(it) <= 64) name = it },
            label = { Text(stringResource(R.string.voici_display_name)) }, singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("page-display-name").onFocusChanged { if (!it.isFocused) commitProfile() },
        )
        OutlinedTextField(
            value = bio, onValueChange = { if (cps(it) <= 280) bio = it },
            label = { Text(stringResource(R.string.voici_bio)) }, minLines = 3,
            supportingText = { Text(stringResource(R.string.voici_counter, cps(bio), 280)) },
            modifier = Modifier.fillMaxWidth().testTag("page-bio").onFocusChanged { if (!it.isFocused) commitProfile() },
        )

        FSSectionHeader(stringResource(R.string.voici_links))
        links.forEachIndexed { i, l ->
            FSCard(Modifier.testTag("page-link-$i")) {
                Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    val site = if (l.url.startsWith("https://")) VoiciText.voiciLinkSite(l.url.trim()) else null
                    val bad = l.url.isNotBlank() && VoiciText.checkVoiciLinkUrl(l.url.trim(), true) != null
                    OutlinedTextField(
                        value = l.url, onValueChange = { if (it.length <= 512) l.url = it },
                        label = { Text(stringResource(R.string.voici_link_url)) }, singleLine = true, isError = bad,
                        supportingText = { Text(if (bad) stringResource(R.string.voici_link_invalid) else listOfNotNull(site, VoiciText.voiciUrlHost(l.url.trim())).joinToString(" · ")) },
                        modifier = Modifier.fillMaxWidth().testTag("page-link-url-$i").onFocusChanged { if (!it.isFocused) commitProfile() },
                    )
                    OutlinedTextField(
                        value = l.label, onValueChange = { if (cps(it) <= 40) l.label = it },
                        label = { Text(stringResource(R.string.voici_link_label)) }, singleLine = true,
                        modifier = Modifier.fillMaxWidth().testTag("page-link-label-$i").onFocusChanged { if (!it.isFocused) commitProfile() },
                    )
                    Row {
                        if (i > 0) FSGhostButton(stringResource(R.string.voici_move_up), { links.add(i - 1, links.removeAt(i)); commitProfile() })
                        if (i < links.size - 1) FSGhostButton(stringResource(R.string.voici_move_down), { links.add(i + 1, links.removeAt(i)); commitProfile() })
                        FSGhostButton(stringResource(R.string.voici_remove), { links.removeAt(i); commitProfile() })
                    }
                }
            }
        }
        if (links.size < 12) FSSecondaryButton(stringResource(R.string.voici_add_link), { links.add(LinkDraft("https://", "")) }, modifier = Modifier.testTag("page-add-link"))

        FSSectionHeader(stringResource(R.string.voici_theme))
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            listOf("classic" to R.string.voici_theme_classic, "ink" to R.string.voici_theme_ink, "sea" to R.string.voici_theme_sea).forEach { (id, label) ->
                FilterChip(selected = theme == id, onClick = { theme = id; commitProfile() }, label = { Text(stringResource(label)) }, modifier = Modifier.testTag("page-theme-$id"))
            }
        }
        if (page.pendingProfile) Text(stringResource(R.string.voici_not_published_yet), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("page-profile-pending"))

        FSCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.voici_accept_messages), style = MaterialTheme.typography.bodyLarge)
                    Text(stringResource(R.string.voici_accept_messages_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (page.pendingAccepts) Text(stringResource(R.string.voici_not_published_yet), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Switch(
                    checked = working.acceptsMessages == 1,
                    onCheckedChange = { on -> scope.launch { center.edit("accept-messages", accepts = if (on) 1 else 0) } },
                    modifier = Modifier.testTag("page-accept-messages"),
                )
            }
        }

        FSSectionHeader(stringResource(R.string.voici_posts))
        FSSecondaryButton(stringResource(R.string.voici_new_post), { nav.navigate("post/new") }, modifier = Modifier.testTag("page-new-post"))
        val posts = working.chunks.flatten().sortedByDescending { it.createdAt }
        posts.forEach { p ->
            val pending = p.id in page.pendingPostIds
            FSCard(Modifier.alpha(if (pending) 0.55f else 1f).clickable { nav.navigate("post/${p.id}") }.testTag("page-post-${p.id.take(8)}")) {
                Text(p.text, maxLines = 3, style = MaterialTheme.typography.bodyMedium)
                Text(
                    if (pending) stringResource(R.string.voici_not_published_yet) else DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(p.createdAt)),
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            FSSecondaryButton(stringResource(R.string.voici_preview), { nav.navigate("page-preview") }, modifier = Modifier.testTag("page-preview"))
            if (page.isPublic) {
                FSGhostButton(stringResource(R.string.voici_copy_link), {
                    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("voi.ci", "https://voi.ci/${page.username}"))
                    toasts.success(FSStrings.get(R.string.voici_link_copied))
                })
                FSGhostButton(stringResource(R.string.voici_share), {
                    context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "https://voi.ci/${page.username}"), null))
                })
            }
        }
        page.error?.let { Text(VoiciCopy.publishError(it), color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("page-error")) }
    }

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

private data class VoiciThemeColors(val bg: Color, val ink: Color, val muted: Color, val accent: Color, val button: Color)

@Composable
private fun themeColors(theme: String): VoiciThemeColors {
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    return when {
        theme == "ink" -> VoiciThemeColors(Color(0xFF14161A), Color(0xFFF2F0EA), Color(0xFFA9A69E), Color(0xFF7DD3C7), Color(0xFF23262C))
        theme == "sea" && !dark -> VoiciThemeColors(Color(0xFFF2F7F9), Color(0xFF13232B), Color(0xFF52656E), Color(0xFF1C7C9C), Color(0xFFE1ECF1))
        theme == "sea" -> VoiciThemeColors(Color(0xFF0E1A20), Color(0xFFE6F0F3), Color(0xFF8FA5AE), Color(0xFF5BB8D6), Color(0xFF1A2A31))
        dark -> VoiciThemeColors(Color(0xFF1A1917), Color(0xFFF1EEE6), Color(0xFFA8A398), Color(0xFF2DD4BF), Color(0xFF26241F))
        else -> VoiciThemeColors(Color(0xFFFAF7F0), Color(0xFF1C1B18), Color(0xFF6B675E), Color(0xFF0F766E), Color(0xFFEFEAE0))
    }
}

/** The page as voi.ci draws it (§2.1), from the working state; unpublished parts grayed. */
@Composable
fun PagePreviewScreen(nav: NavController) {
    val center = LocalVoiciCenter.current ?: return
    val page by center.page.collectAsState()
    val state: VoiciPageState = page.working ?: return
    val colors = themeColors(state.profile.theme)
    var shown by remember { mutableStateOf(1) }
    var link by remember { mutableStateOf<Pair<String, String>?>(null) }
    val chunksNewestFirst = state.chunks.reversed()
    FSScreen(title = stringResource(R.string.voici_preview_title), onBack = { nav.popBackStack() }, titleTag = "page-preview-title") {
        if (page.pendingCount > 0) FSNote(stringResource(R.string.voici_preview_note))
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(colors.bg).padding(FS.space.s5).testTag("page-preview-body"),
            verticalArrangement = Arrangement.spacedBy(FS.space.s3),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.alpha(if (page.pendingProfile) 0.55f else 1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                VoiciAvatar(center.image(state.profile.avatar), 96.dp, state.profile.displayName)
                Text(state.profile.displayName, color = colors.ink, style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Medium))
                if (state.profile.bio.isNotEmpty()) Text(state.profile.bio, color = colors.muted, style = MaterialTheme.typography.bodyMedium)
                state.profile.links.forEach { l ->
                    val host = VoiciText.voiciUrlHost(l.url) ?: l.url.removePrefix("mailto:")
                    Column(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.button).clickable { link = l.url to host }.padding(FS.space.s3),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(l.label, color = colors.ink, style = MaterialTheme.typography.bodyLarge)
                        Text(host, color = colors.muted, style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
            if (state.acceptsMessages == 1) {
                Box(
                    Modifier.fillMaxWidth().alpha(if (page.pendingAccepts) 0.55f else 1f).clip(RoundedCornerShape(12.dp)).background(colors.accent).padding(FS.space.s3),
                    contentAlignment = Alignment.Center,
                ) { Text(stringResource(R.string.voici_send_me_a_message), color = colors.bg, style = MaterialTheme.typography.titleSmall) }
            }
            chunksNewestFirst.take(shown).flatMap { c -> c.sortedByDescending { it.createdAt } }.forEach { p ->
                Column(Modifier.fillMaxWidth().alpha(if (p.id in page.pendingPostIds) 0.55f else 1f), verticalArrangement = Arrangement.spacedBy(FS.space.s1)) {
                    Text(DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(p.createdAt)), color = colors.muted, style = MaterialTheme.typography.labelSmall)
                    VoiciLinkedText(p.text, colors.ink, { u, h -> link = u to h })
                    p.links.forEach { l ->
                        val c = l.card ?: return@forEach
                        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.button).clickable { link = l.url to (VoiciText.voiciUrlHost(l.url) ?: "") }) {
                            center.image(c.image)?.let { b ->
                                val bmp = remember(b) { BitmapFactory.decodeByteArray(b, 0, b.size)?.asImageBitmap() }
                                if (bmp != null) Image(bmp, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().size(height = 120.dp, width = 400.dp))
                            }
                            Column(Modifier.padding(FS.space.s3)) {
                                Text(c.title, color = colors.ink, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium))
                                if (c.description.isNotEmpty()) Text(c.description, color = colors.muted, style = MaterialTheme.typography.bodySmall, maxLines = 3)
                                Text(c.site, color = colors.muted, style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                }
            }
            if (shown < chunksNewestFirst.size) FSGhostButton(stringResource(R.string.voici_show_older), { shown++ })
        }
    }
    link?.let { (u, h) -> VoiciOpenLinkDialog(u, h) { link = null } }
}
