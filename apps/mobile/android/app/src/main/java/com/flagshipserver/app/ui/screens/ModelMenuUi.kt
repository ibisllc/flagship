// The model menu (build chat header, grouped by provider, and Settings → AI
// keys), the effort picker beside it, attachment chips and the vision-switch
// alert. Logic lives in core/AiModelMenu.kt, core/ModelGroups.kt and
// core/ChatAttachments.kt.

package com.flagshipserver.app.ui.screens

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.api.VibeCodeAttachment
import com.flagshipserver.app.core.AttachKind
import com.flagshipserver.app.core.ChatAttachments
import com.flagshipserver.app.core.ModelChoice
import com.flagshipserver.app.core.ModelGroup
import com.flagshipserver.app.core.ModelGroups
import com.flagshipserver.app.core.ModelMenu
import com.flagshipserver.app.core.ModelMenus
import com.flagshipserver.app.core.VisionCheck
import com.flagshipserver.app.ui.theme.FS

/** A pill showing the current model; tapping opens the menu. */
@Composable
fun ModelMenuChip(
    menu: ModelMenu,
    choice: ModelChoice?,
    onChoice: (ModelChoice?) -> Unit,
    modifier: Modifier = Modifier,
    tag: String = "model-menu",
) {
    var open by remember { mutableStateOf(false) }
    val opens = menu !is ModelMenu.Unknown && !(menu is ModelMenu.Flagship && menu.catalog == null)
    Box(modifier) {
        Pill(
            label = ModelMenus.title(menu, choice),
            trailing = if (opens) Icons.Outlined.ExpandMore else null,
            onClick = if (opens) ({ open = true }) else null,
            modifier = Modifier.testTag(tag),
        )
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            modifier = Modifier.widthIn(min = 240.dp, max = 320.dp),
            containerColor = FS.colors.surface,
        ) {
            ModelMenuItems(menu, choice, onChoice = onChoice, onClose = { open = false })
        }
    }
}

/** The menu's rows: one per model (label + descriptor), or a model field
 *  when the provider gave no list. [tagPrefix] keeps rows of two groups apart. */
@Composable
fun ModelMenuItems(
    menu: ModelMenu,
    choice: ModelChoice?,
    onChoice: (ModelChoice?) -> Unit,
    onClose: () -> Unit,
    tagPrefix: String = "model-item-",
) {
    when (menu) {
        is ModelMenu.Flagship -> menu.catalog?.models?.forEach { m ->
            MenuRow(
                title = m.label,
                subtitle = m.descriptor.takeIf { it.isNotBlank() },
                selected = m.id == choice?.model,
                tag = "$tagPrefix${m.id}",
                onClick = {
                    onChoice(ModelMenus.select(menu, m.id))
                    onClose()
                },
            )
        }
        is ModelMenu.Own -> {
            if (menu.listed) {
                menu.options.forEach { o ->
                    MenuRow(
                        title = o.label,
                        subtitle = if (!o.known) ModelMenus.UNKNOWN_CAPS else null,
                        selected = o.id == choice?.model,
                        tag = "$tagPrefix${o.id}",
                        onClick = {
                            onChoice(ModelMenus.select(menu, o.id))
                            onClose()
                        },
                    )
                }
            } else {
                Column(Modifier.padding(horizontal = FS.space.s4, vertical = FS.space.s2)) {
                    OutlinedTextField(
                        value = choice?.model.orEmpty(),
                        onValueChange = { v -> onChoice(v.trim().takeIf { it.isNotEmpty() }?.let { ModelChoice(it) }) },
                        label = { Text(ModelMenus.MODEL_FIELD) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().testTag("model-free-text"),
                    )
                    if (menu.reason == "rejected") {
                        Spacer(Modifier.height(FS.space.s1))
                        Text(ModelMenus.KEY_REFUSED, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp))
                    }
                }
            }
        }
        ModelMenu.Unknown -> Unit
    }
}

@Composable
private fun MenuRow(title: String, subtitle: String?, selected: Boolean, tag: String, onClick: () -> Unit) {
    DropdownMenuItem(
        text = {
            Column(Modifier.padding(vertical = FS.space.s1)) {
                Text(
                    title,
                    color = FS.colors.text,
                    style = TextStyle(fontSize = 14.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal),
                )
                if (subtitle != null) {
                    Text(subtitle, color = FS.colors.textMuted, style = TextStyle(fontSize = 12.sp, lineHeight = 16.sp))
                }
            }
        },
        trailingIcon = {
            if (selected) Icon(Icons.Outlined.Check, contentDescription = "Selected", tint = FS.colors.primary, modifier = Modifier.size(18.dp))
        },
        onClick = onClick,
        modifier = Modifier.testTag(tag),
    )
}

/** A small rounded control in the app's chip style. */
@Composable
fun Pill(
    label: String,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    leading: ImageVector? = null,
    trailing: ImageVector? = null,
    onClick: (() -> Unit)? = null,
) {
    val shape = RoundedCornerShape(FS.radius.pill)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        modifier = modifier
            .clip(shape)
            .background(if (selected) FS.colors.primary.copy(alpha = 0.14f) else FS.colors.surfaceSunken)
            .border(1.dp, if (selected) FS.colors.primary else FS.colors.border, shape)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        val tint = if (selected) FS.colors.primary else FS.colors.textMuted
        if (leading != null) Icon(leading, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
        Text(
            label,
            color = if (selected) FS.colors.primary else FS.colors.text,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (trailing != null) Icon(trailing, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
    }
}

/** The effort beside the menu, for a model that lists efforts. */
@Composable
fun EffortChip(efforts: List<String>, effort: String?, onEffort: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Pill(
            label = effort?.let(ModelMenus::effortLabel) ?: ModelMenus.EFFORT,
            trailing = Icons.Outlined.ExpandMore,
            onClick = { open = true },
            modifier = Modifier.testTag("model-effort"),
        )
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            containerColor = FS.colors.surface,
        ) {
            EffortItems(efforts, effort) {
                onEffort(it)
                open = false
            }
        }
    }
}

/** The effort rows: one per level the model lists. */
@Composable
fun EffortItems(efforts: List<String>, effort: String?, onEffort: (String) -> Unit) {
    efforts.forEach { e ->
        MenuRow(
            title = ModelMenus.effortLabel(e),
            subtitle = null,
            selected = e == effort,
            tag = "model-effort-$e",
            onClick = { onEffort(e) },
        )
    }
}

/**
 * The build chat's menu: Flagship Inference and each saved key as a group
 * of its models. [menus] holds each loaded group's models; [onOpen] loads the
 * rest when the menu opens.
 */
@Composable
fun GroupedModelMenuChip(
    groups: List<ModelGroup>,
    menus: Map<String, ModelMenu>,
    groupId: String?,
    choice: ModelChoice?,
    onOpen: () -> Unit,
    onPick: (String, ModelChoice?) -> Unit,
    modifier: Modifier = Modifier,
) {
    var open by remember { mutableStateOf(false) }
    val group = ModelGroups.byId(groups, groupId)
    Box(modifier) {
        Pill(
            label = ModelGroups.triggerText(group, group?.let { menus[it.id] }, choice),
            trailing = if (groups.isNotEmpty()) Icons.Outlined.ExpandMore else null,
            onClick = if (groups.isNotEmpty()) ({
                open = true
                onOpen()
            }) else null,
            modifier = Modifier.testTag("model-menu"),
        )
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            modifier = Modifier.widthIn(min = 240.dp, max = 320.dp),
            containerColor = FS.colors.surface,
        ) {
            GroupedModelMenuItems(groups, menus, groupId, choice, onPick, onClose = { open = false })
        }
    }
}

/** Every group's title and its models, in menu order. */
@Composable
fun GroupedModelMenuItems(
    groups: List<ModelGroup>,
    menus: Map<String, ModelMenu>,
    groupId: String?,
    choice: ModelChoice?,
    onPick: (String, ModelChoice?) -> Unit,
    onClose: () -> Unit,
) {
    groups.forEachIndexed { i, g ->
        if (i > 0) HorizontalDivider(color = FS.colors.border)
        Text(
            g.title,
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .padding(horizontal = FS.space.s4, vertical = FS.space.s2)
                .testTag("model-group-${g.id}"),
        )
        val m = menus[g.id]
        val note = when {
            m == null -> MODELS_LOADING
            m is ModelMenu.Flagship && m.catalog == null -> MODELS_UNAVAILABLE
            else -> null
        }
        if (m == null || note != null) {
            Text(
                note.orEmpty(),
                color = FS.colors.textMuted,
                style = TextStyle(fontSize = 13.sp),
                modifier = Modifier.padding(horizontal = FS.space.s4, vertical = FS.space.s2),
            )
        } else {
            ModelMenuItems(m, choice.takeIf { g.id == groupId }, { onPick(g.id, it) }, onClose, "model-item-${g.id}-")
        }
    }
}

internal const val MODELS_LOADING = "Loading models…"
internal const val MODELS_UNAVAILABLE = "The models couldn't be listed right now."

private fun iconFor(kind: AttachKind): ImageVector = when (kind) {
    AttachKind.IMAGE -> Icons.Outlined.Image
    AttachKind.TEXT -> Icons.Outlined.Description
    AttachKind.DATA -> Icons.Outlined.TableChart
    AttachKind.DOCUMENT -> Icons.Outlined.PictureAsPdf
}

/** A staged or sent attachment: its name and an icon by kind. */
@Composable
fun AttachmentChip(a: VibeCodeAttachment, onRemove: (() -> Unit)? = null) {
    val shape = RoundedCornerShape(FS.radius.sm)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier
            .clip(shape)
            .background(FS.colors.surfaceSunken)
            .border(1.dp, FS.colors.border, shape)
            .padding(start = 10.dp, end = if (onRemove != null) 4.dp else 10.dp, top = 6.dp, bottom = 6.dp)
            .widthIn(max = 220.dp),
    ) {
        Icon(iconFor(ChatAttachments.kindOf(a)), contentDescription = null, tint = FS.colors.primary, modifier = Modifier.size(16.dp))
        Text(
            ChatAttachments.displayName(a),
            color = FS.colors.text,
            style = TextStyle(fontSize = 13.sp),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (onRemove != null) {
            Icon(
                Icons.Outlined.Close,
                contentDescription = "Remove ${ChatAttachments.displayName(a)}",
                tint = FS.colors.textMuted,
                modifier = Modifier
                    .size(24.dp)
                    .clip(RoundedCornerShape(FS.radius.pill))
                    .clickable(onClick = onRemove)
                    .padding(4.dp)
                    .testTag("attachment-remove"),
            )
        }
    }
}

/** Chips for a list of attachments. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AttachmentChips(list: List<VibeCodeAttachment>, onRemove: ((Int) -> Unit)? = null) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
        verticalArrangement = Arrangement.spacedBy(FS.space.s2),
    ) {
        list.forEachIndexed { i, a -> AttachmentChip(a, onRemove?.let { r -> { r(i) } }) }
    }
}

/** "The AI will see what you attach." (+ the sample-data line). */
@Composable
fun AttachmentNotice(staged: List<VibeCodeAttachment>) {
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(Icons.Outlined.Visibility, contentDescription = null, tint = FS.colors.textMuted, modifier = Modifier.size(16.dp).padding(top = 1.dp))
        Text(
            ChatAttachments.NOTICE +
                if (ChatAttachments.hasSampleData(staged)) " " + ChatAttachments.SAMPLE_DATA_NOTE else "",
            color = FS.colors.textMuted,
            style = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
            modifier = Modifier.testTag("attachment-notice"),
        )
    }
}

/** The muted cost line under a Flagship Inference reply. */
@Composable
fun CreditsLine(credits: Double) {
    Text(
        ModelMenus.creditsLine(credits),
        color = FS.colors.textMuted,
        style = TextStyle(fontSize = 11.sp),
        modifier = Modifier.testTag("message-credits"),
    )
}

/** The alert before sending images to a model that can't see them. */
@Composable
fun VisionDialog(check: VisionCheck, onSwitch: (ModelChoice) -> Unit, onDismiss: () -> Unit) {
    when (check) {
        is VisionCheck.Switch -> AlertDialog(
            onDismissRequest = onDismiss,
            text = { Text(check.message, modifier = Modifier.testTag("vision-message")) },
            confirmButton = {
                TextButton(onClick = { onSwitch(check.to) }, modifier = Modifier.testTag("vision-switch")) { Text("Switch") }
            },
            dismissButton = { TextButton(onClick = onDismiss, modifier = Modifier.testTag("vision-cancel")) { Text("Cancel") } },
        )
        is VisionCheck.Blocked -> AlertDialog(
            onDismissRequest = onDismiss,
            text = { Text(check.message, modifier = Modifier.testTag("vision-message")) },
            confirmButton = { TextButton(onClick = onDismiss) { Text("OK") } },
        )
        VisionCheck.Send -> Unit
    }
}

/** Read a picked file into an attachment, or the line saying why not. */
fun readAttachment(context: Context, uri: Uri, staged: Int): Pair<VibeCodeAttachment?, String?> {
    val resolver = context.contentResolver
    var name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
    var size = -1L
    runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { i -> c.getString(i)?.let { name = it } }
                c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let { i -> size = c.getLong(i) }
            }
        }
    }
    val mime = resolver.getType(uri)
    val kind = ChatAttachments.kindFor(name, mime)
    ChatAttachments.problem(kind, name, size.coerceAtLeast(0), staged)?.let { return null to it }
    kind!!
    val limit = ChatAttachments.maxBytes(kind)
    val bytes = try {
        resolver.openInputStream(uri)?.use { input ->
            val buf = java.io.ByteArrayOutputStream()
            val chunk = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(chunk)
                if (n < 0) break
                buf.write(chunk, 0, n)
                if (buf.size() > limit) break
            }
            buf.toByteArray()
        }
    } catch (_: Throwable) {
        null
    } ?: return null to "$name couldn't be read."
    ChatAttachments.problem(kind, name, bytes.size.toLong(), staged)?.let { return null to it }
    return ChatAttachments.build(kind, name, mime, bytes) to null
}
