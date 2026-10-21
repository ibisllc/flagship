// The model menu (build chat header, grouped by provider, and Settings → AI
// keys), the effort picker beside it, attachment chips and the vision-switch
// alert. Logic lives in core/AiModelMenu.kt, core/ModelGroups.kt and
// core/ChatAttachments.kt.

package com.flagshipserver.app.ui.screens

import androidx.compose.ui.res.stringResource
import com.flagshipserver.app.core.fsString
import com.flagshipserver.app.core.FSStrings
import com.flagshipserver.app.R
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material.icons.outlined.Visibility
import com.flagshipserver.app.ui.components.AlertDialog
import com.flagshipserver.app.ui.components.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import com.flagshipserver.app.ui.components.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
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
                        Text(ModelMenus.KEY_REFUSED, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
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
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.bodyLarge.copy(fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal),
                )
                if (subtitle != null) {
                    Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        trailingIcon = {
            if (selected) Icon(Icons.Outlined.Check, contentDescription = stringResource(R.string.selected), tint = FS.colors.accent, modifier = Modifier.size(18.dp))
        },
        onClick = onClick,
        modifier = Modifier.testTag(tag),
    )
}

/** A small control in Material's chip style (8 dp corners, 32 dp tall,
 *  an outline, a tonal fill when selected). */
@Composable
fun Pill(
    label: String,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    leading: ImageVector? = null,
    trailing: ImageVector? = null,
    onClick: (() -> Unit)? = null,
) {
    val scheme = MaterialTheme.colorScheme
    val shape = MaterialTheme.shapes.small
    val container = if (selected) scheme.secondaryContainer else Color.Transparent
    val content = if (selected) scheme.onSecondaryContainer else scheme.onSurfaceVariant
    val border = BorderStroke(1.dp, if (selected) Color.Transparent else scheme.outline)
    val body: @Composable () -> Unit = {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
            modifier = Modifier
                .heightIn(min = 32.dp)
                .padding(start = if (leading != null) 8.dp else 12.dp, end = if (trailing != null) 8.dp else 12.dp),
        ) {
            if (leading != null) Icon(leading, contentDescription = null, tint = if (selected) content else scheme.primary, modifier = Modifier.size(18.dp))
            Text(
                label,
                color = if (selected) content else scheme.onSurface,
                style = MaterialTheme.typography.labelLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (trailing != null) Icon(trailing, contentDescription = null, tint = content, modifier = Modifier.size(18.dp))
        }
    }
    if (onClick != null) {
        Surface(onClick = onClick, modifier = modifier, shape = shape, color = container, contentColor = content, border = border) { body() }
    } else {
        Surface(modifier = modifier, shape = shape, color = container, contentColor = content, border = border) { body() }
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
        if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Text(
            g.title,
            color = FS.colors.accentText,
            style = MaterialTheme.typography.titleSmall,
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
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = FS.space.s4, vertical = FS.space.s2),
            )
        } else {
            ModelMenuItems(m, choice.takeIf { g.id == groupId }, { onPick(g.id, it) }, onClose, "model-item-${g.id}-")
        }
    }
}

internal val MODELS_LOADING get() = FSStrings.get(R.string.loading_models)
internal val MODELS_UNAVAILABLE get() = FSStrings.get(R.string.the_models_couldnt_be_listed_right)

private fun iconFor(kind: AttachKind): ImageVector = when (kind) {
    AttachKind.IMAGE -> Icons.Outlined.Image
    AttachKind.TEXT -> Icons.Outlined.Description
    AttachKind.DATA -> Icons.Outlined.TableChart
    AttachKind.DOCUMENT -> Icons.Outlined.PictureAsPdf
}

/** A staged or sent attachment: its name and an icon by kind (Material's
 *  input-chip look). */
@Composable
fun AttachmentChip(a: VibeCodeAttachment, onRemove: (() -> Unit)? = null) {
    val scheme = MaterialTheme.colorScheme
    Surface(
        shape = MaterialTheme.shapes.small,
        color = scheme.surfaceContainerLow,
        border = BorderStroke(1.dp, scheme.outlineVariant),
        modifier = Modifier.widthIn(max = 240.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
            modifier = Modifier
                .heightIn(min = 32.dp)
                .padding(start = 8.dp, end = if (onRemove != null) 2.dp else 12.dp),
        ) {
            Icon(iconFor(ChatAttachments.kindOf(a)), contentDescription = null, tint = scheme.primary, modifier = Modifier.size(18.dp))
            Text(
                ChatAttachments.displayName(a),
                color = scheme.onSurface,
                style = MaterialTheme.typography.labelLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (onRemove != null) {
                Icon(
                    Icons.Outlined.Close,
                    contentDescription = fsString(R.string.remove, ChatAttachments.displayName(a)),
                    tint = scheme.onSurfaceVariant,
                    modifier = Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .clickable(onClick = onRemove)
                        .padding(5.dp)
                        .testTag("attachment-remove"),
                )
            }
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
        Icon(Icons.Outlined.Visibility, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp).padding(top = 1.dp))
        Text(
            ChatAttachments.NOTICE +
                if (ChatAttachments.hasSampleData(staged)) " " + ChatAttachments.SAMPLE_DATA_NOTE else "",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.testTag("attachment-notice"),
        )
    }
}

/** The muted cost line under a Flagship Inference reply. */
@Composable
fun CreditsLine(credits: Double) {
    Text(
        ModelMenus.creditsLine(credits),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.labelSmall,
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
                TextButton(onClick = { onSwitch(check.to) }, modifier = Modifier.testTag("vision-switch")) { Text(stringResource(R.string.switch_label)) }
            },
            dismissButton = { TextButton(onClick = onDismiss, modifier = Modifier.testTag("vision-cancel")) { Text(stringResource(R.string.cancel)) } },
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
    } ?: return null to FSStrings.get(R.string.couldnt_be_read, name)
    ChatAttachments.problem(kind, name, bytes.size.toLong(), staged)?.let { return null to it }
    return ChatAttachments.build(kind, name, mime, bytes) to null
}
