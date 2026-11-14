// The Social tab (docs/social-tab.md): the account's voi.ci page, drawn as visitors see it and edited in place, and
// the conversations people started from it. Title row: "Your page", the Public switch, Page options. Under it,
// Profile / Messages. Changes wait in one bar that shows only while something is unpublished. Mirrors iOS
// SocialTab.swift and PageEditorScreen.swift.

package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.Reply
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.NorthEast
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.voici.StoredVoiciConversation
import com.flagshipserver.app.core.voici.VoiciCard
import com.flagshipserver.app.core.voici.VoiciCenter
import com.flagshipserver.app.core.voici.VoiciCopy
import com.flagshipserver.app.core.voici.VoiciJpeg
import com.flagshipserver.app.core.voici.VoiciOutcome
import com.flagshipserver.app.core.voici.VoiciPage
import com.flagshipserver.app.core.voici.VoiciPageUi
import com.flagshipserver.app.core.voici.VoiciPost
import com.flagshipserver.app.core.voici.VoiciPostLink
import com.flagshipserver.app.core.voici.VoiciProfile
import com.flagshipserver.app.core.voici.VoiciProfileLink
import com.flagshipserver.app.core.voici.VoiciText
import com.flagshipserver.app.core.voici.VoiciTextField
import com.flagshipserver.app.ui.components.FSEmptyState
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSGroup
import com.flagshipserver.app.ui.components.FSNote
import com.flagshipserver.app.ui.components.FSRow
import com.flagshipserver.app.ui.components.FSScreen
import com.flagshipserver.app.ui.components.FSDivider
import com.flagshipserver.app.ui.components.OutlinedTextField
import com.flagshipserver.app.ui.components.Switch
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date

/** Which side of the Social tab shows; deep links set it (`messages` → Messages, `page-editor` → Profile). */
object SocialSection {
    const val PROFILE = "profile"
    const val MESSAGES = "messages"
    val current = MutableStateFlow(PROFILE)
}

private enum class PageField { Name, Bio }

private fun cps(s: String) = s.codePointCount(0, s.length)

@Composable
fun SocialScreen(nav: NavController) {
    val center = LocalVoiciCenter.current ?: return FSScreen(title = stringResource(R.string.voici_your_page), titleTag = "social-title") {
        FSNote(stringResource(R.string.voici_messages_paused))
    }
    val app = com.flagshipserver.app.core.LocalAppState.current
    val profiles by app.profiles.collectAsState()
    val activeCloud by app.activeCloudName.collectAsState()
    val pods by app.pods.collectAsState()
    if (com.flagshipserver.app.core.AppState.isDemoAccount(profiles.firstOrNull { it.cloudName == activeCloud }, pods)) {
        return DemoSocialScreen(center, app.currentUser.collectAsState().value.orEmpty())
    }
    val page by center.page.collectAsState()
    val ui by center.messages.collectAsState()
    val section by SocialSection.current.collectAsState()
    val scope = rememberCoroutineScope()
    val toasts = LocalToastCenter.current
    LaunchedEffect(center) { center.start() }
    val flow = rememberPagePublicFlow(center)
    val editor = remember(center) { PageEditState(center) }
    var showOptions by rememberSaveable { mutableStateOf(false) }
    PagePublicDialogs(flow)

    val profileSide = section == SocialSection.PROFILE
    FSScreen(
        title = stringResource(if (profileSide) R.string.voici_your_page else R.string.voici_segment_messages),
        titleTag = "social-title",
        subtitle = "voi.ci/${page.username}",
        subtitleTag = "social-address",
        onRefresh = { scope.launch { center.refresh() } },
        refreshing = ui.loading,
        actions = {
            Text(
                stringResource(if (page.isPublic) R.string.voici_public else R.string.voici_not_public),
                style = MaterialTheme.typography.labelLarge,
                color = if (page.isPublic) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                modifier = Modifier.padding(end = FS.space.s2).testTag("messages-page-status"),
            )
            PagePublicSwitch(page, flow)
            IconButton(onClick = { showOptions = true }, modifier = Modifier.testTag("page-options")) {
                Icon(Icons.Outlined.MoreHoriz, contentDescription = stringResource(R.string.voici_page_options))
            }
        },
        topPinned = { SectionSwitch(section, ui.requests.size) },
        bottomBar = {
            PagePublishBar(page, editor.unpublished(page)) {
                scope.launch { if (editor.commit()) flow.publishAll() }
            }
        },
    ) {
        if (!page.canPublish) {
            Text(stringResource(R.string.voici_admin_only_publish), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("page-admin-only"))
        }
        if (page.takenDown) FSNote(VoiciCopy.publishError("taken-down"), Modifier.testTag("page-taken-down"))
        page.error?.let { Text(VoiciCopy.publishError(it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("page-publish-error")) }
        if (profileSide) {
            PageProfile(center, page, editor, nav)
        } else {
            SocialMessages(center, ui, nav)
        }
    }
    if (showOptions) PageOptionsSheet(center, page, flow, editor, nav, onDismiss = { showOptions = false }, onError = { toasts.error(it) })
}

/** Profile / Messages under the title row; Messages carries the number of waiting requests. */
@Composable
private fun SectionSwitch(section: String, requests: Int) {
    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxWidth()) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = FS.space.s4, vertical = FS.space.s2)) {
            SegmentedButton(
                selected = section == SocialSection.PROFILE,
                onClick = { SocialSection.current.value = SocialSection.PROFILE },
                shape = SegmentedButtonDefaults.itemShape(0, 2),
                modifier = Modifier.testTag("social-tab-profile"),
            ) { Text(stringResource(R.string.voici_profile)) }
            SegmentedButton(
                selected = section == SocialSection.MESSAGES,
                onClick = { SocialSection.current.value = SocialSection.MESSAGES },
                shape = SegmentedButtonDefaults.itemShape(1, 2),
                modifier = Modifier.testTag("social-tab-messages"),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    Text(stringResource(R.string.voici_segment_messages))
                    if (requests > 0) Badge(containerColor = FS.colors.fill, contentColor = FS.colors.onAccent) { Text(requests.toString()) }
                }
            }
        }
    }
}

/**
 * The profile fields while one is edited. Every change is a draft op until Publish on an admin device signs a new
 * index; the page, Page options (theme) and the publish bar count and record the same fields.
 */
private class PageEditState(private val center: VoiciCenter) {
    var editing by mutableStateOf<PageField?>(null)
    var name by mutableStateOf("")
    var bio by mutableStateOf("")
    var note by mutableStateOf<String?>(null)

    private fun base(): VoiciProfile? = center.page.value.working?.profile

    /** The profile as shown: the field being edited applied to the working profile. */
    fun current(): VoiciProfile? {
        val b = base() ?: return null
        return when (editing) {
            PageField.Name -> b.copy(displayName = name.trim())
            PageField.Bio -> b.copy(bio = bio.trim())
            null -> b
        }
    }

    fun changed(): Boolean = editing != null && current() != base()

    fun unpublished(p: VoiciPageUi): Int = p.pendingCount + if (changed() && !p.pendingProfile) 1 else 0

    fun begin(f: PageField) {
        val b = base() ?: return
        name = b.displayName
        bio = b.bio
        note = null
        editing = f
    }

    /** Records the open field (and [patch]) as one profile draft. False when a field is refused; the field stays open. */
    suspend fun commit(patch: (VoiciProfile) -> VoiciProfile = { it }): Boolean {
        val b = base() ?: return true
        val p = patch(current() ?: return true)
        val n = VoiciText.prepareVoiciText(VoiciTextField.displayName, p.displayName)
        if (n !is VoiciOutcome.Ok) {
            note = if (p.displayName.isEmpty()) FSStrings.get(R.string.voici_add_display_name) else VoiciCopy.sendError(n.code)
            return false
        }
        val bi = VoiciText.prepareVoiciText(VoiciTextField.bio, p.bio)
        if (bi !is VoiciOutcome.Ok) {
            note = VoiciCopy.sendError(bi.code)
            return false
        }
        note = null
        val q = p.copy(displayName = n.value, bio = bi.value)
        if (q != b) center.edit("profile", profile = q)
        editing = null
        return true
    }
}

// ── Profile ───────────────────────────────────────────────────────────────

/** The page drawn as voi.ci draws it, in its theme, minus voi.ci's footer; photo, name and bio edit behind a pencil. */
@Composable
private fun PageProfile(center: VoiciCenter, page: VoiciPageUi, editor: PageEditState, nav: NavController) {
    val working = page.working ?: return
    val t = VoiciPageTheme.of(working.profile.theme, appIsDark())
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var photoMenu by remember { mutableStateOf(false) }
    var editingLinks by remember { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        scope.launch {
            val sha = withContext(Dispatchers.IO) {
                runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()?.let(VoiciJpeg::avatar)?.let(center::putImage)
            }
            if (sha == null) editor.note = FSStrings.get(R.string.voici_photo_failed) else editor.commit { it.copy(avatar = sha) }
        }
    }
    val pending = if (page.canPublish) stringResource(R.string.voici_not_published_yet) else stringResource(R.string.voici_waiting_for_admin)
    CompositionLocalProvider(LocalContentColor provides t.ink) {
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(t.canvas)
                .border(1.dp, t.rule, RoundedCornerShape(16.dp))
                .testTag("social-profile"),
        ) {
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(FS.space.s3),
            ) {
                // Photo with its round pencil.
                Box {
                    Box(Modifier.clip(CircleShape).background(t.surface).border(1.dp, t.rule, CircleShape).padding(4.dp)) {
                        PageAvatar(center.image(working.profile.avatar), 96.dp)
                    }
                    val photoLabel = stringResource(if (working.profile.avatar == null) R.string.voici_add_photo else R.string.voici_change_photo)
                    Box(Modifier.align(Alignment.BottomEnd).offset(x = 6.dp, y = 4.dp)) {
                        IconButton(onClick = { photoMenu = true }, modifier = Modifier.testTag("page-edit-photo").semantics { contentDescription = photoLabel }) {
                            Box(Modifier.size(32.dp).clip(CircleShape).background(t.surface).border(1.dp, t.ruleStrong, CircleShape), contentAlignment = Alignment.Center) {
                                Icon(Icons.Outlined.Edit, contentDescription = null, tint = t.ink, modifier = Modifier.size(16.dp))
                            }
                        }
                        DropdownMenu(expanded = photoMenu, onDismissRequest = { photoMenu = false }) {
                            DropdownMenuItem(
                                text = { Text(photoLabel) },
                                onClick = { photoMenu = false; picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                                modifier = Modifier.testTag("page-photo"),
                            )
                            if (working.profile.avatar != null) DropdownMenuItem(
                                text = { Text(stringResource(R.string.voici_remove_photo), color = MaterialTheme.colorScheme.error) },
                                onClick = { photoMenu = false; scope.launch { editor.commit { it.copy(avatar = null) } } },
                                modifier = Modifier.testTag("page-remove-photo"),
                            )
                        }
                    }
                }
                NameRow(page, editor, t)
                BioRow(page, editor, t)
                editor.note?.let { Text(it, color = t.err, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, modifier = Modifier.testTag("page-profile-note")) }
                if (page.pendingProfile || (editor.changed() && editor.editing == null)) {
                    Text(pending, color = t.muted, style = MaterialTheme.typography.labelMedium, modifier = Modifier.testTag("page-pending-note"))
                }
                // Links as the page shows them, then Edit links.
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    working.profile.links.forEach { l -> LinkRow(l, t) }
                }
                Row(
                    Modifier.heightIn(min = 48.dp).clip(RoundedCornerShape(8.dp)).clickable { editingLinks = true }.padding(horizontal = FS.space.s3).testTag("page-edit-links"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
                ) {
                    Icon(Icons.Outlined.Edit, contentDescription = null, tint = t.muted, modifier = Modifier.size(16.dp))
                    Text(stringResource(if (working.profile.links.isEmpty()) R.string.voici_add_link else R.string.voici_edit_links), color = t.muted, style = MaterialTheme.typography.labelLarge)
                }
            }
            PostsBlock(center, page, t, nav)
        }
    }
    if (editingLinks) EditLinksSheet(working.profile.links, onDismiss = { links ->
        editingLinks = false
        scope.launch { editor.commit { it.copy(links = links) } }
    })
}

@Composable
private fun pencil(t: VoiciPageTheme, label: String, tag: String, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.testTag(tag).semantics { contentDescription = label }) {
        Icon(Icons.Outlined.Edit, contentDescription = null, tint = t.muted, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun themedFieldColors(t: VoiciPageTheme) = OutlinedTextFieldDefaults.colors(
    focusedTextColor = t.ink, unfocusedTextColor = t.ink, cursorColor = t.link,
    focusedBorderColor = t.link, unfocusedBorderColor = t.ruleStrong,
    focusedContainerColor = t.surface, unfocusedContainerColor = t.surface,
    focusedLabelColor = t.muted, unfocusedLabelColor = t.muted,
    focusedSupportingTextColor = t.muted, unfocusedSupportingTextColor = t.muted,
)

@Composable
private fun DoneButton(t: VoiciPageTheme, editor: PageEditState) {
    val scope = rememberCoroutineScope()
    Box(
        Modifier.heightIn(min = 48.dp).clip(RoundedCornerShape(10.dp)).background(t.fill)
            .clickable { scope.launch { editor.commit() } }.padding(horizontal = 16.dp).testTag("page-edit-done"),
        contentAlignment = Alignment.Center,
    ) { Text(stringResource(R.string.voici_done), color = t.onFill, fontWeight = FontWeight.SemiBold) }
}

@Composable
private fun NameRow(page: VoiciPageUi, editor: PageEditState, t: VoiciPageTheme) {
    val scope = rememberCoroutineScope()
    val shown = page.working?.profile?.displayName?.ifEmpty { null } ?: page.username
    if (editor.editing == PageField.Name) {
        val focus = remember { FocusRequester() }
        LaunchedEffect(Unit) { focus.requestFocus() }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            OutlinedTextField(
                value = editor.name,
                onValueChange = { if (cps(it) <= 64) editor.name = it },
                label = { Text(stringResource(R.string.voici_display_name)) },
                placeholder = { Text(page.username) },
                singleLine = true,
                textStyle = MaterialTheme.typography.titleMedium,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { scope.launch { editor.commit() } }),
                colors = themedFieldColors(t),
                modifier = Modifier.weight(1f).focusRequester(focus).testTag("page-display-name"),
            )
            DoneButton(t, editor)
        }
    } else {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                shown,
                style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Medium),
                textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f, fill = false).testTag("page-name-text"),
            )
            if (editor.editing == null) pencil(t, stringResource(R.string.voici_edit_name), "page-edit-name") { editor.begin(PageField.Name) }
        }
    }
}

@Composable
private fun BioRow(page: VoiciPageUi, editor: PageEditState, t: VoiciPageTheme) {
    val bio = page.working?.profile?.bio.orEmpty()
    if (editor.editing == PageField.Bio) {
        val focus = remember { FocusRequester() }
        LaunchedEffect(Unit) { focus.requestFocus() }
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            OutlinedTextField(
                value = editor.bio,
                onValueChange = { if (cps(it) <= 280) editor.bio = it },
                label = { Text(stringResource(R.string.voici_bio)) },
                minLines = 2,
                maxLines = 6,
                supportingText = { Text(stringResource(R.string.voici_counter, cps(editor.bio), 280)) },
                colors = themedFieldColors(t),
                modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("page-bio"),
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { DoneButton(t, editor) }
        }
    } else {
        Row(Modifier.widthIn(max = 420.dp), verticalAlignment = Alignment.CenterVertically) {
            if (bio.isEmpty()) {
                Text(stringResource(R.string.voici_add_bio), color = t.muted, modifier = Modifier.weight(1f, fill = false))
            } else {
                Text(bio, color = t.inkSoft, textAlign = TextAlign.Center, modifier = Modifier.weight(1f, fill = false).testTag("page-bio-text"))
            }
            if (editor.editing == null) pencil(t, stringResource(R.string.voici_edit_bio), "page-edit-bio") { editor.begin(PageField.Bio) }
        }
    }
}

@Composable
private fun LinkRow(l: VoiciProfileLink, t: VoiciPageTheme) {
    val mail = l.url.startsWith("mailto:")
    Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).clip(RoundedCornerShape(6.dp)).background(t.surface)
            .border(1.dp, t.rule, RoundedCornerShape(6.dp)).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(t.canvas).border(1.dp, t.rule, CircleShape), contentAlignment = Alignment.Center) {
            Icon(if (mail) Icons.Outlined.Email else Icons.Outlined.Link, contentDescription = null, tint = t.ink, modifier = Modifier.size(18.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(l.label, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(VoiciText.voiciUrlHost(l.url) ?: l.url.removePrefix("mailto:"), color = t.muted, fontFamily = FontFamily.Monospace, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Icon(Icons.Outlined.NorthEast, contentDescription = null, tint = t.muted, modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun PostsBlock(center: VoiciCenter, page: VoiciPageUi, t: VoiciPageTheme, nav: NavController) {
    val posts = page.working?.chunks?.flatten()?.sortedByDescending { it.createdAt }.orEmpty()
    HorizontalDivider(thickness = 1.dp, color = t.rule)
    Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            stringResource(R.string.voici_posts).uppercase(),
            color = t.muted,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            letterSpacing = 1.5.sp,
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        Row(
            Modifier.heightIn(min = 48.dp).padding(vertical = 6.dp).clip(RoundedCornerShape(50)).background(t.fill)
                .clickable { nav.navigate("post/new") }.padding(horizontal = 14.dp).testTag("page-new-post-open"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Outlined.Add, contentDescription = null, tint = t.onFill, modifier = Modifier.size(18.dp))
            Text(stringResource(R.string.voici_new_post), color = t.onFill, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
        }
    }
    if (posts.isEmpty()) {
        HorizontalDivider(thickness = 1.dp, color = t.rule)
        Text(stringResource(R.string.voici_no_posts), color = t.muted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 16.dp))
    }
    posts.forEach { p -> PostRow(center, page, p, t, nav) }
    Spacer(Modifier.size(6.dp))
}

@Composable
private fun PostRow(center: VoiciCenter, page: VoiciPageUi, post: VoiciPost, t: VoiciPageTheme, nav: NavController) {
    val pending = post.id in page.pendingPostIds
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    HorizontalDivider(thickness = 1.dp, color = t.rule)
    Column(
        Modifier.fillMaxWidth().alpha(if (pending) 0.55f else 1f).padding(start = 18.dp, end = 6.dp, top = 8.dp, bottom = 14.dp)
            .testTag(if (pending) "page-post-pending" else "page-post"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Text(DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(post.createdAt)), color = t.muted, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
            if (pending) {
                Text(
                    stringResource(if (page.canPublish) R.string.voici_not_published_yet else R.string.voici_waiting_for_admin),
                    color = t.muted, style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f).testTag("page-pending-note"),
                )
            } else {
                Spacer(Modifier.weight(1f))
            }
            Box {
                IconButton(onClick = { menu = true }, modifier = Modifier.testTag("page-post-menu")) {
                    Icon(Icons.Outlined.MoreHoriz, contentDescription = stringResource(R.string.voici_post_options), tint = t.muted)
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.voici_edit)) },
                        leadingIcon = { Icon(Icons.Outlined.Edit, contentDescription = null) },
                        onClick = { menu = false; nav.navigate("post/${post.id}") },
                        modifier = Modifier.testTag("page-post-edit"),
                    )
                    if (post.links.any { it.card != null }) DropdownMenuItem(
                        text = { Text(stringResource(R.string.voici_remove_link_cards)) },
                        leadingIcon = { Icon(Icons.Outlined.LinkOff, contentDescription = null) },
                        onClick = {
                            menu = false
                            scope.launch { center.edit("post-edit", post = post.copy(links = post.links.map { VoiciPostLink(it.url, null) }, editedAt = System.currentTimeMillis())) }
                        },
                        modifier = Modifier.testTag("page-post-remove-cards"),
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.voici_delete), color = MaterialTheme.colorScheme.error) },
                        leadingIcon = { Icon(Icons.Outlined.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                        onClick = { menu = false; deleting = true },
                        modifier = Modifier.testTag("page-post-delete"),
                    )
                }
            }
        }
        Text(post.text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(end = 12.dp))
        post.links.forEach { l -> l.card?.let { LinkCard(center, it, l.url, t) } }
    }
    if (deleting) AlertDialog(
        onDismissRequest = { deleting = false },
        title = { Text(stringResource(R.string.voici_delete_post_title)) },
        confirmButton = {
            FSGhostButton(stringResource(R.string.voici_delete), {
                deleting = false
                scope.launch { center.edit("post-delete", postId = post.id) }
            }, modifier = Modifier.testTag("post-delete-confirm"))
        },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), { deleting = false }) },
    )
}

@Composable
private fun LinkCard(center: VoiciCenter, card: VoiciCard, url: String, t: VoiciPageTheme) {
    Row(
        Modifier.fillMaxWidth().padding(end = 12.dp).clip(RoundedCornerShape(6.dp)).background(t.surface).border(1.dp, t.rule, RoundedCornerShape(6.dp)).padding(8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        center.image(card.image)?.let { b ->
            val bmp = remember(b) { runCatching { BitmapFactory.decodeByteArray(b, 0, b.size)?.asImageBitmap() }.getOrNull() }
            if (bmp != null) Image(bmp, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(width = 72.dp, height = 54.dp).clip(RoundedCornerShape(4.dp)))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(card.title, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (card.description.isNotEmpty()) Text(card.description, color = t.muted, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(card.site.ifEmpty { VoiciText.voiciUrlHost(url) ?: "" }, color = t.muted, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        }
    }
}

/** The page's links: reorder, remove, add (at most VOICI_PROFILE_MAX_LINKS). Recorded as a draft when it closes. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EditLinksSheet(initial: List<VoiciProfileLink>, onDismiss: (List<VoiciProfileLink>) -> Unit) {
    val links = remember { mutableStateListOf(*initial.toTypedArray()) }
    var adding by remember { mutableStateOf(false) }
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = { onDismiss(links.toList()) }, sheetState = state, modifier = Modifier.testTag("page-links-sheet")) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = FS.space.s4).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.voici_links), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
                FSGhostButton(stringResource(R.string.voici_done), { onDismiss(links.toList()) }, modifier = Modifier.testTag("page-links-done"))
            }
            links.forEachIndexed { i, l ->
                Row(Modifier.fillMaxWidth().testTag("page-link-$i"), verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (l.url.startsWith("mailto:")) Icons.Outlined.Email else Icons.Outlined.Link, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Column(Modifier.weight(1f).padding(start = FS.space.s3)) {
                        Text(l.label, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(VoiciText.voiciUrlHost(l.url) ?: l.url.removePrefix("mailto:"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    IconButton(onClick = { links.add(i - 1, links.removeAt(i)) }, enabled = i > 0) { Icon(Icons.Outlined.ArrowUpward, contentDescription = stringResource(R.string.voici_move_up)) }
                    IconButton(onClick = { links.add(i + 1, links.removeAt(i)) }, enabled = i < links.size - 1) { Icon(Icons.Outlined.ArrowDownward, contentDescription = stringResource(R.string.voici_move_down)) }
                    IconButton(onClick = { links.removeAt(i) }, modifier = Modifier.testTag("page-link-remove-$i")) { Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.voici_remove)) }
                }
            }
            if (links.size < VoiciPage.VOICI_PROFILE_MAX_LINKS) {
                FSRow(title = stringResource(R.string.voici_add_link), icon = Icons.Outlined.Add, iconTint = FS.colors.accentText, titleColor = FS.colors.accentText, onClick = { adding = true }, modifier = Modifier.testTag("page-add-link"))
            }
            Spacer(Modifier.size(FS.space.s4))
        }
    }
    if (adding) AddLinkDialog(links, onDismiss = { adding = false }) { links.add(it); adding = false }
}

@Composable
private fun AddLinkDialog(existing: List<VoiciProfileLink>, onDismiss: () -> Unit, onAdd: (VoiciProfileLink) -> Unit) {
    var label by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("https://") }
    var problem by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.voici_add_link)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                OutlinedTextField(value = label, onValueChange = { if (cps(it) <= 40) label = it }, label = { Text(stringResource(R.string.voici_link_label)) }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("link-label"))
                OutlinedTextField(
                    value = url, onValueChange = { if (it.length <= 512) url = it }, label = { Text(stringResource(R.string.voici_link_url)) }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Uri),
                    supportingText = { VoiciText.voiciUrlHost(url.trim())?.let { Text(it) } },
                    modifier = Modifier.fillMaxWidth().testTag("link-url"),
                )
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("link-problem")) }
            }
        },
        confirmButton = {
            FSGhostButton(stringResource(R.string.voici_add), {
                val u = url.trim()
                val mailto = u.startsWith("mailto:")
                val l = VoiciText.prepareVoiciText(VoiciTextField.linkLabel, label.trim().ifEmpty { VoiciText.voiciUrlHost(u) ?: "" }.take(40))
                problem = when {
                    VoiciText.checkVoiciLinkUrl(u, true) != null -> FSStrings.get(R.string.voici_link_invalid)
                    mailto && existing.any { it.url.startsWith("mailto:") } -> FSStrings.get(R.string.voici_one_email_link)
                    l !is VoiciOutcome.Ok -> FSStrings.get(R.string.voici_link_label_problem)
                    else -> null
                }
                if (problem == null && l is VoiciOutcome.Ok) onAdd(VoiciProfileLink(u, l.value, if (mailto) null else VoiciText.voiciLinkSite(u)))
            }, modifier = Modifier.testTag("link-add"))
        },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), onDismiss) },
    )
}

// ── Page options ──────────────────────────────────────────────────────────

/** Behind the title row's ⋯: the theme, the link, Accept messages, the visitor-side settings and Remove page. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PageOptionsSheet(
    center: VoiciCenter,
    page: VoiciPageUi,
    flow: PagePublicFlow,
    editor: PageEditState,
    nav: NavController,
    onDismiss: () -> Unit,
    onError: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val toasts = LocalToastCenter.current
    var confirmRotate by remember { mutableStateOf(false) }
    var rules by remember { mutableStateOf(false) }
    val url = "https://voi.ci/${page.username}"
    val working = page.working
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, modifier = Modifier.testTag("page-options-sheet")) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = FS.space.s4).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.voici_page_options), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
                FSGhostButton(stringResource(R.string.voici_done), onDismiss, modifier = Modifier.testTag("page-options-done"))
            }
            FSGroup(header = stringResource(R.string.voici_theme)) {
                Row(Modifier.fillMaxWidth().padding(FS.space.s3).testTag("page-theme"), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    VoiciPageTheme.ids.forEach { id ->
                        val t = VoiciPageTheme.of(id, appIsDark())
                        val on = working?.profile?.theme == id
                        Box(
                            Modifier.weight(1f).heightIn(min = 60.dp).clip(RoundedCornerShape(12.dp)).background(t.canvas)
                                .border(if (on) 2.5.dp else 1.dp, if (on) MaterialTheme.colorScheme.onSurface else t.ruleStrong, RoundedCornerShape(12.dp))
                                .clickable { scope.launch { editor.commit { it.copy(theme = id) } } }
                                .semantics { selected = on }
                                .testTag("page-theme-$id"),
                            contentAlignment = Alignment.Center,
                        ) { Text(VoiciPageTheme.label(id), color = t.ink, fontWeight = FontWeight.SemiBold) }
                    }
                }
            }
            if (page.isPublic) {
                FSGroup {
                    FSRow(title = stringResource(R.string.voici_copy_link), onClick = {
                        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("voi.ci", url))
                        toasts.success(FSStrings.get(R.string.voici_link_copied))
                    }, modifier = Modifier.testTag("page-copy-link"))
                    FSDivider(0.dp)
                    FSRow(title = stringResource(R.string.voici_share), onClick = {
                        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url), null))
                    }, modifier = Modifier.testTag("page-share"))
                }
                Text(url, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = FS.space.s4))
            }
            FSGroup {
                FSRow(
                    title = stringResource(R.string.voici_accept_messages),
                    subtitle = if (page.pendingAccepts) stringResource(if (page.canPublish) R.string.voici_not_published_yet else R.string.voici_waiting_for_admin) else null,
                    trailing = {
                        Switch(
                            checked = working?.acceptsMessages == 1,
                            onCheckedChange = { on -> scope.launch { center.edit("accept-messages", accepts = if (on) 1 else 0) } },
                            modifier = Modifier.testTag("page-accept-messages"),
                        )
                    },
                )
            }
            Text(stringResource(R.string.voici_accept_messages_body), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = FS.space.s4))
            val canRotate = page.canPublish && page.publishedSeq > 0
            FSGroup {
                FSRow(title = stringResource(R.string.voici_sites), onClick = { onDismiss(); nav.navigate("signed-in-sites") }, modifier = Modifier.testTag("messages-settings-sites"))
                if (canRotate) {
                    FSDivider(0.dp)
                    FSRow(title = stringResource(R.string.voici_rotate), onClick = { confirmRotate = true }, modifier = Modifier.testTag("messages-settings-rotate"))
                }
                FSDivider(0.dp)
                FSRow(title = stringResource(R.string.voici_rules_open), onClick = { rules = true }, modifier = Modifier.testTag("messages-settings-rules"))
            }
            if (canRotate) Text(stringResource(R.string.voici_rotate_footer), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = FS.space.s4))
            if (page.canPublish && page.isPublic) {
                FSGroup {
                    FSRow(
                        title = stringResource(R.string.voici_remove_page),
                        titleColor = MaterialTheme.colorScheme.error,
                        onClick = { onDismiss(); flow.confirmRemove = true },
                        modifier = Modifier.testTag("page-remove"),
                    )
                }
            }
            Spacer(Modifier.size(FS.space.s4))
        }
    }
    if (confirmRotate) AlertDialog(
        onDismissRequest = { confirmRotate = false },
        title = { Text(stringResource(R.string.voici_rotate_confirm_title)) },
        text = { Text(stringResource(R.string.voici_rotate_confirm_body)) },
        confirmButton = {
            FSGhostButton(stringResource(R.string.voici_rotate_short), {
                confirmRotate = false
                scope.launch {
                    if (center.rotateInbox(FSStrings.get(R.string.voici_publish_reason))) toasts.success(FSStrings.get(R.string.voici_rotate_done))
                    else center.page.value.error?.let { onError(VoiciCopy.publishError(it)) }
                }
            }, modifier = Modifier.testTag("messages-rotate-confirm"))
        },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), { confirmRotate = false }) },
    )
    if (rules) VoiciRulesDialog(onAgree = { rules = false; scope.launch { center.acceptRules() } }, onDismiss = { rules = false })
}

// ── the publish bar ───────────────────────────────────────────────────────

/**
 * Only while something is unpublished: "N changes not published · Publish", spinning while it publishes; on a
 * device that can't sign the page, "Waiting for an admin device to publish" and no button.
 */
@Composable
fun PagePublishBar(page: VoiciPageUi, unpublished: Int, onPublish: () -> Unit) {
    if (unpublished <= 0 && !page.publishing) return
    val bg = MaterialTheme.colorScheme.inverseSurface
    val fg = MaterialTheme.colorScheme.inverseOnSurface
    Box(Modifier.fillMaxWidth().padding(horizontal = FS.space.s4, vertical = FS.space.s2)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp).shadow(10.dp, RoundedCornerShape(50)).clip(RoundedCornerShape(50)).background(bg)
                .padding(start = 20.dp, end = 6.dp, top = 6.dp, bottom = 6.dp).testTag("page-publish-bar"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    if (page.publishing) stringResource(R.string.voici_publishing_page) else pluralStringResource(R.plurals.voici_changes_pending, unpublished, unpublished),
                    color = fg,
                    style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
                    modifier = Modifier.testTag("page-pending-count"),
                )
                if (!page.canPublish) {
                    Text(stringResource(R.string.voici_waiting_for_admin), color = fg.copy(alpha = 0.8f), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("page-waiting-admin"))
                }
            }
            if (page.canPublish) {
                Box(
                    Modifier.heightIn(min = 44.dp).widthIn(min = 104.dp).clip(RoundedCornerShape(50)).background(FS.colors.fill)
                        .clickable(enabled = !page.publishing, onClick = onPublish).padding(horizontal = 18.dp).testTag("page-publish"),
                    contentAlignment = Alignment.Center,
                ) {
                    if (page.publishing) CircularProgressIndicator(color = FS.colors.onAccent, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                    else Text(stringResource(R.string.voici_publish), color = FS.colors.onAccent, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

// ── Messages ──────────────────────────────────────────────────────────────

@Composable
private fun SocialMessages(center: VoiciCenter, ui: com.flagshipserver.app.core.voici.VoiciMessagesUi, nav: NavController) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var showRequests by rememberSaveable { mutableStateOf(false) }
    val replies by center.replyNotices.collectAsState()
    if (replies.isNotEmpty() && !showRequests) {
        FSGroup {
            replies.forEach { n ->
                FSRow(
                    title = stringResource(R.string.voici_reply_notice, n.username),
                    icon = Icons.AutoMirrored.Outlined.Reply,
                    iconTint = FS.colors.accent,
                    onClick = {
                        scope.launch { center.openedReply(n) }
                        runCatching {
                            context.startActivity(
                                Intent(Intent.ACTION_VIEW, Uri.parse("${com.flagshipserver.app.core.Endpoints.voiciOrigin}/${n.username}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                            )
                        }
                    },
                    modifier = Modifier.testTag("messages-reply-notice"),
                )
            }
        }
        Text(stringResource(R.string.voici_reply_footer), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        SegmentedButton(
            selected = !showRequests, onClick = { showRequests = false },
            shape = SegmentedButtonDefaults.itemShape(0, 2), modifier = Modifier.testTag("messages-segment-messages"),
        ) { Text(stringResource(R.string.voici_segment_conversations)) }
        SegmentedButton(
            selected = showRequests, onClick = { showRequests = true },
            shape = SegmentedButtonDefaults.itemShape(1, 2), modifier = Modifier.testTag("messages-segment-requests"),
        ) {
            Text(if (ui.requests.isEmpty()) stringResource(R.string.voici_segment_requests_none) else stringResource(R.string.voici_segment_requests, ui.requests.size))
        }
    }
    val list = if (showRequests) ui.requests else ui.accepted
    if (list.isEmpty()) {
        FSEmptyState(
            title = stringResource(if (showRequests) R.string.voici_empty_requests else R.string.voici_empty_messages_options),
            icon = Icons.Outlined.ChatBubbleOutline,
            modifier = Modifier.testTag("messages-empty"),
        )
    } else {
        FSGroup {
            list.forEachIndexed { i, c ->
                ConversationRow(c, ui.name(c, VoiciCopy::visitorName), ui.unread(c)) { nav.navigate("thread/${c.conv}") }
                if (i < list.size - 1) FSDivider(0.dp)
            }
        }
    }
    ui.error?.let { Text(VoiciCopy.sendError(it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
}

/**
 * A sample account's tab: its page is the operator's example, shown read only (VoiciDemoPage). No editor, no
 * conversations, no Page options: the device holds none of the account's keys.
 */
@Composable
private fun DemoSocialScreen(center: VoiciCenter, username: String) {
    val demo by center.demoPage.collectAsState()
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(username) { if (username.isNotEmpty()) center.refreshDemoPage(username) }
    FSScreen(
        title = stringResource(R.string.voici_your_page),
        titleTag = "social-title",
        onRefresh = {
            scope.launch {
                refreshing = true
                center.refreshDemoPage(username)
                refreshing = false
            }
        },
        refreshing = refreshing,
    ) {
        DemoPageHeaderCard(demo?.takeIf { it.username == username.lowercase() } ?: com.flagshipserver.app.core.voici.VoiciDemoPageUi(username.lowercase()))
    }
}

/** The Social tab's icon in the bottom bar (a plain outline person). */
val SocialTabIcon = Icons.Outlined.Person
