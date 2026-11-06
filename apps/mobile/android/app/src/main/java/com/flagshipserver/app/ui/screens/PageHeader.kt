// The page's own controls at the top of the Messages tab (docs/voici-and-messages.md §3.3, §11.1): the photo, the
// display name (the account name until changed), voi.ci/<username> with a copy button, the Public switch and the way
// into the editor; a slim bar once the conversations scroll it away. Mirrors iOS PageHeader.swift.

package com.flagshipserver.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.core.LocalToastCenter
import com.flagshipserver.app.core.voici.PagePublicStep
import com.flagshipserver.app.core.voici.VoiciCenter
import com.flagshipserver.app.core.voici.VoiciCopy
import com.flagshipserver.app.core.voici.VoiciJpeg
import com.flagshipserver.app.core.voici.VoiciPageUi
import com.flagshipserver.app.ui.components.FSCard
import com.flagshipserver.app.ui.components.FSGhostButton
import com.flagshipserver.app.ui.components.FSPrimaryButton
import com.flagshipserver.app.ui.components.Switch
import com.flagshipserver.app.ui.theme.FS
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Turning the page public or taking it down: the rules once per device, then the one-time public warning per
 * account, then the signature. Nothing is signed before "Make it public"; a device that can't sign never gets past the
 * first step. One per screen; [PagePublicDialogs] draws its dialogs.
 */
class PagePublicFlow(private val center: VoiciCenter, private val scope: CoroutineScope, private val onError: (String) -> Unit) {
    private enum class Action { GoPublic, PublishAll }

    var showRules by mutableStateOf(false)
    var showWarning by mutableStateOf(false)
    var confirmRemove by mutableStateOf(false)
    private var action: Action? = null

    fun setPublic(on: Boolean) {
        val p = center.page.value
        if (!p.canPublish || p.publishing) return
        if (on && !p.isPublic) begin(Action.GoPublic) else if (!on && p.isPublic) confirmRemove = true
    }

    /** The editor's Publish bar: while the page is not public, publishing makes it public, so the same steps apply. */
    fun publishAll() {
        val p = center.page.value
        if (!p.canPublish) return
        if (p.isPublic) scope.launch { if (!center.publish(FSStrings.get(R.string.voici_publish_reason))) center.page.value.error?.let { onError(VoiciCopy.publishError(it)) } }
        else begin(Action.PublishAll)
    }

    private fun begin(a: Action) {
        action = a
        advance()
    }

    private fun advance() {
        when (center.publicStep()) {
            PagePublicStep.Refuse -> action = null
            PagePublicStep.Rules -> showRules = true
            PagePublicStep.Warning -> showWarning = true
            PagePublicStep.Publish -> run()
        }
    }

    fun rulesAgreed() {
        showRules = false
        scope.launch {
            center.acceptRules()
            advance()
        }
    }

    fun makePublic() {
        showWarning = false
        scope.launch {
            center.acknowledgePublicWarning()
            run()
        }
    }

    fun cancel() {
        showRules = false
        showWarning = false
        action = null
    }

    fun remove() {
        confirmRemove = false
        scope.launch {
            if (!center.removePage(FSStrings.get(R.string.voici_remove_reason))) center.page.value.error?.let { onError(VoiciCopy.removeError(it)) }
        }
    }

    private fun run() {
        val a = action ?: return
        action = null
        scope.launch {
            val reason = FSStrings.get(R.string.voici_publish_reason)
            val ok = if (a == Action.GoPublic) center.goPublic(reason) else center.publish(reason)
            if (!ok) center.page.value.error?.let { onError(VoiciCopy.publishError(it)) }
        }
    }
}

@Composable
fun rememberPagePublicFlow(center: VoiciCenter): PagePublicFlow {
    val scope = rememberCoroutineScope()
    val toasts = LocalToastCenter.current
    return remember(center) { PagePublicFlow(center, scope) { toasts.error(it) } }
}

@Composable
fun PagePublicDialogs(flow: PagePublicFlow) {
    if (flow.showRules) VoiciRulesDialog(onAgree = { flow.rulesAgreed() }, onDismiss = { flow.cancel() })
    if (flow.showWarning) AlertDialog(
        onDismissRequest = { flow.cancel() },
        title = { Text(stringResource(R.string.voici_public_warning_title)) },
        text = { Text(stringResource(R.string.voici_public_warning_body)) },
        confirmButton = { FSGhostButton(stringResource(R.string.voici_make_it_public), { flow.makePublic() }, modifier = Modifier.testTag("page-make-public")) },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), { flow.cancel() }) },
        modifier = Modifier.testTag("page-public-warning"),
    )
    if (flow.confirmRemove) AlertDialog(
        onDismissRequest = { flow.confirmRemove = false },
        title = { Text(stringResource(R.string.voici_remove_title)) },
        text = { Text(stringResource(R.string.voici_remove_body)) },
        confirmButton = {
            FSGhostButton(stringResource(R.string.voici_remove), { flow.remove() }, modifier = Modifier.testTag("page-remove-confirm"))
        },
        dismissButton = { FSGhostButton(stringResource(R.string.voici_cancel), { flow.confirmRemove = false }) },
        modifier = Modifier.testTag("page-remove-dialog"),
    )
}

/** The Public switch: on = visitors see the page on voi.ci. Off on a device that can't sign the page. */
@Composable
fun PagePublicSwitch(page: VoiciPageUi, flow: PagePublicFlow, modifier: Modifier = Modifier) {
    val label = stringResource(R.string.voici_public)
    Switch(
        checked = page.isPublic,
        onCheckedChange = { flow.setPublic(it) },
        enabled = page.canPublish && !page.publishing,
        modifier = modifier.testTag("page-public-switch").semantics { contentDescription = label },
    )
}

/** A round avatar: the page photo, or an empty person silhouette until one is set. */
@Composable
fun PageAvatar(bytes: ByteArray?, size: Dp, modifier: Modifier = Modifier) {
    val bmp = remember(bytes) { bytes?.let { runCatching { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }.getOrNull() } }
    val ring = MaterialTheme.colorScheme.outlineVariant
    if (bmp != null) {
        Image(bmp, contentDescription = null, contentScale = ContentScale.Crop, modifier = modifier.size(size).clip(CircleShape).border(1.dp, ring, CircleShape))
    } else {
        Box(
            modifier.size(size).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerHigh).border(1.dp, ring, CircleShape),
            contentAlignment = Alignment.BottomCenter,
        ) {
            Icon(Icons.Filled.Person, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f), modifier = Modifier.size(size * 0.82f))
        }
    }
}

private fun pageStatus(page: VoiciPageUi): String = when {
    !page.isPublic -> FSStrings.get(R.string.voici_not_public)
    page.pendingCount == 1 -> FSStrings.get(R.string.voici_one_change_not_published)
    page.pendingCount > 1 -> FSStrings.get(R.string.voici_changes_not_published, page.pendingCount)
    else -> FSStrings.get(R.string.voici_published)
}

/** voi.ci/<username> with a copy button. It writes only the page's address. */
@Composable
fun PageAddressRow(username: String) {
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(2000); copied = false } }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            "voi.ci/$username",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        val copyLabel = stringResource(if (copied) R.string.voici_link_copied else R.string.voici_copy_link)
        IconButton(
            onClick = {
                (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("voi.ci", "https://voi.ci/$username"))
                copied = true
            },
            modifier = Modifier.testTag("page-copy-link").semantics { liveRegion = LiveRegionMode.Polite },
        ) {
            Icon(if (copied) Icons.Filled.Check else Icons.Outlined.ContentCopy, contentDescription = copyLabel, tint = if (copied) FS.colors.success else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
        }
    }
}

/**
 * The header. While the page is public an admin device publishes a name or photo change at once; otherwise it is a
 * draft. [onEdit] opens the full editor.
 */
@Composable
fun PageHeaderCard(center: VoiciCenter, page: VoiciPageUi, flow: PagePublicFlow, onEdit: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    val working = page.working
    val shownName = working?.profile?.displayName ?: page.username
    val avatarSha = working?.profile?.avatar
    var name by remember(shownName) { mutableStateOf(shownName) }
    var note by remember { mutableStateOf<String?>(null) }
    var focused by remember { mutableStateOf(false) }
    val big = LocalDensity.current.fontScale >= 1.6f

    fun commitName() {
        if (name.trim() == shownName) return
        scope.launch {
            val code = center.setQuickProfile(name, avatarSha, FSStrings.get(R.string.voici_publish_reason))
            note = code?.let { VoiciCopy.publishError(it) }
            if (code != null) name = shownName
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        scope.launch {
            val sha = withContext(Dispatchers.IO) {
                runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()?.let(VoiciJpeg::avatar)?.let(center::putImage)
            }
            if (sha == null) {
                note = FSStrings.get(R.string.voici_photo_failed)
                return@launch
            }
            val code = center.setQuickProfile(name.ifBlank { shownName }, sha, FSStrings.get(R.string.voici_publish_reason))
            note = code?.let { VoiciCopy.publishError(it) }
        }
    }

    FSCard(Modifier.testTag("messages-your-page")) {
        Column(verticalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            val photoLabel = stringResource(R.string.voici_choose_photo)
            val avatar: @Composable () -> Unit = {
                Box(
                    Modifier
                        .clickable(onClickLabel = photoLabel) { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
                        .semantics { contentDescription = photoLabel }
                        .testTag("page-header-photo"),
                ) {
                    PageAvatar(center.image(avatarSha), 72.dp)
                    Box(
                        Modifier.align(Alignment.BottomEnd).size(24.dp).clip(CircleShape).background(FS.colors.fill)
                            .border(2.dp, MaterialTheme.colorScheme.surfaceContainerLowest, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Filled.PhotoCamera, contentDescription = null, tint = FS.colors.onAccent, modifier = Modifier.size(13.dp)) }
                }
            }
            val fields: @Composable (Modifier) -> Unit = { m ->
                Column(m) {
                    TextField(
                        value = name,
                        onValueChange = { if (it.codePointCount(0, it.length) <= 64) name = it },
                        placeholder = { Text(page.username) },
                        label = { Text(stringResource(R.string.voici_display_name)) },
                        singleLine = true,
                        textStyle = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                        colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent, disabledContainerColor = Color.Transparent),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
                        modifier = Modifier.fillMaxWidth().testTag("page-header-name").onFocusChanged { s ->
                            if (focused && !s.isFocused) commitName()
                            focused = s.isFocused
                        },
                    )
                    PageAddressRow(page.username)
                }
            }
            if (big) {
                avatar()
                fields(Modifier.fillMaxWidth())
            } else {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s4)) {
                    avatar()
                    fields(Modifier.weight(1f))
                }
            }
            HorizontalDivider(thickness = 1.dp, color = MaterialTheme.colorScheme.outlineVariant)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.voici_public), style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
                    Text(pageStatus(page), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("messages-page-status"))
                }
                PagePublicSwitch(page, flow)
            }
            if (page.publishing) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (!page.canPublish) Text(stringResource(R.string.voici_admin_only_publish), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("page-admin-only"))
            note?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("page-header-error")) }
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClick = onEdit).testTag("messages-edit-page"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(if (page.publishedSeq == 0L && page.pendingCount == 0) R.string.voici_set_up_your_page else R.string.voici_edit_page),
                    color = FS.colors.accentText,
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.weight(1f),
                )
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** The editor's one bar: "<N> changes not published · Publish" (on another device: waiting for an admin device). */
@Composable
fun PagePublishBar(page: VoiciPageUi, unpublished: Int, onPublish: () -> Unit) {
    if (unpublished <= 0 && !page.publishing) return
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth().testTag("page-publish-bar")) {
        Column {
            HorizontalDivider(thickness = 1.dp, color = MaterialTheme.colorScheme.outlineVariant)
            Row(
                Modifier.padding(horizontal = FS.space.s4, vertical = FS.space.s3),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        pluralStringResource(R.plurals.voici_changes_pending, unpublished, unpublished),
                        style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
                        modifier = Modifier.testTag("page-pending-count"),
                    )
                    if (!page.canPublish) {
                        Text(
                            stringResource(R.string.voici_waiting_for_admin),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.testTag("page-waiting-admin"),
                        )
                    }
                }
                if (page.canPublish) {
                    FSPrimaryButton(
                        stringResource(if (page.publishing) R.string.voici_publishing else R.string.voici_publish),
                        onPublish,
                        enabled = !page.publishing,
                        modifier = Modifier.testTag("page-publish"),
                    )
                }
            }
        }
    }
}

/** The header once the conversations scrolled it away: the photo, the name and the switch (or the status). */
@Composable
fun PageHeaderBar(center: VoiciCenter, page: VoiciPageUi, flow: PagePublicFlow, onTap: () -> Unit) {
    val name = page.working?.profile?.displayName?.ifBlank { null } ?: page.username
    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxWidth().testTag("page-header-bar")) {
        Column {
            Row(Modifier.padding(horizontal = FS.space.s4, vertical = FS.space.s2), verticalAlignment = Alignment.CenterVertically) {
                Row(
                    Modifier.weight(1f).clip(MaterialTheme.shapes.small).clickable(onClickLabel = stringResource(R.string.voici_your_page), onClick = onTap).heightIn(min = 48.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    PageAvatar(center.image(page.working?.profile?.avatar), 32.dp)
                    Spacer(Modifier.width(FS.space.s3))
                    Text(name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (page.canPublish) PagePublicSwitch(page, flow)
                else Text(stringResource(if (page.isPublic) R.string.voici_public else R.string.voici_not_public), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            HorizontalDivider(thickness = 1.dp, color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}
