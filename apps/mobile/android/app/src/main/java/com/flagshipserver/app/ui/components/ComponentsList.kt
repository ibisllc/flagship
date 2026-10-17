package com.flagshipserver.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FSType
import com.flagshipserver.app.ui.theme.fsInitials
import com.flagshipserver.app.ui.theme.softTint

/**
 * List / settings / chip primitives on Material 3 components, in the
 * organisation iOS uses (`FlagshipUI/Components/ComponentsList.swift`):
 *
 *   - FSChipRow / FSChip          — horizontal scrollable filter chips
 *   - FSSearchField               — a rounded search field
 *   - FSMonogram                  — circular teal initials avatar (fsInitials)
 *   - FSProfileCard               — account hero (monogram + title)
 *   - FSAnnouncementCard          — a dismissible tinted callout
 *   - FSSettingsGroup / FSSettingsRow — a titled group of list items
 *   - FSListRow                   — a card row (status icon/monogram + meta)
 *
 * All are presentation-only: they take data + callbacks, never app state.
 */

// ── Chips ──────────────────────────────────────────────────────

/** Item descriptor for an [FSChipRow] chip. */
data class FSChipItem<T>(val value: T, val label: String, val count: Int? = null)

/** A Material filter chip with an optional count after the label. */
@Composable
fun FSChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    count: Int? = null,
) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        modifier = modifier,
        label = {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label)
                if (count != null) Text(count.toString(), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        leadingIcon = if (selected) {
            { Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(FilterChipDefaults.IconSize)) }
        } else null,
        shape = MaterialTheme.shapes.small,
    )
}

/** A horizontal, scrollable row of [FSChip]s. */
@Composable
fun <T> FSChipRow(
    items: List<FSChipItem<T>>,
    selection: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
    ) {
        for (item in items) {
            FSChip(
                label = item.label,
                selected = item.value == selection,
                count = item.count,
                onClick = { onSelect(item.value) },
            )
        }
    }
}

// ── Search ─────────────────────────────────────────────────────

/** A rounded search field: a search icon, a placeholder, and a clear button
 *  once there's text. */
@Composable
fun FSSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "Search",
) {
    TextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        placeholder = { Text(placeholder) },
        leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
        trailingIcon = if (value.isNotEmpty()) {
            {
                IconButton(onClick = { onValueChange("") }) {
                    Icon(Icons.Outlined.Close, contentDescription = "Clear search")
                }
            }
        } else null,
        shape = CircleShape,
        colors = TextFieldDefaults.colors(
            focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
        ),
        modifier = modifier.fillMaxWidth().heightIn(min = 52.dp),
    )
}

// ── Monogram ───────────────────────────────────────────────────

/** A circular teal monogram avatar — [fsInitials] of a name on a soft-teal fill. */
@Composable
fun FSMonogram(name: String, modifier: Modifier = Modifier, size: Dp = 52.dp) {
    Box(
        modifier = modifier
            .size(size)
            .clip(CircleShape)
            .background(FS.colors.softTint()),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = fsInitials(name),
            color = FS.colors.primary,
            style = MaterialTheme.typography.titleMedium.copy(fontSize = (size.value * 0.38f).sp, fontWeight = FontWeight.Medium),
        )
    }
}

// ── Profile hero ───────────────────────────────────────────────

/** The account hero: a teal monogram, the account name and a subtitle. Tappable. */
@Composable
fun FSProfileCard(
    name: String,
    subtitle: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        onClick = onClick,
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLowest,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(FS.space.s4),
            modifier = Modifier.padding(FS.space.s4),
        ) {
            FSMonogram(name = name)
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = name.ifEmpty { "Your account" },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.titleLarge,
                )
                Text(
                    text = subtitle,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

// ── Announcement ───────────────────────────────────────────────

/**
 * A dismissible callout: the tone's soft tint and hairline, a bare icon, a
 * title, a body, an optional filled action, and an optional close button
 * (docs/design-system.md §8.4). [tint] null = brand teal.
 */
@Composable
fun FSAnnouncementCard(
    icon: ImageVector,
    title: String,
    message: String,
    modifier: Modifier = Modifier,
    ctaLabel: String? = null,
    tint: Color? = null,
    onCta: () -> Unit = {},
    onDismiss: (() -> Unit)? = null,
) {
    val accent = tint ?: FS.colors.primary
    val fill = tint ?: FS.colors.fill
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        color = accent.copy(alpha = 0.08f),
        border = BorderStroke(1.dp, accent.copy(alpha = 0.24f)),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
            modifier = Modifier.padding(start = FS.space.s4, top = FS.space.s4, bottom = FS.space.s4, end = if (onDismiss != null) FS.space.s1 else FS.space.s4),
        ) {
            Icon(icon, contentDescription = null, tint = accent, modifier = Modifier.padding(top = 2.dp).size(24.dp))
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                if (ctaLabel != null) {
                    Spacer(Modifier.height(FS.space.s2))
                    Button(
                        onClick = onCta,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = fill,
                            contentColor = if (tint == null) FS.colors.onAccent else MaterialTheme.colorScheme.onError,
                        ),
                    ) { Text(ctaLabel, style = MaterialTheme.typography.labelLarge) }
                }
            }
            if (onDismiss != null) {
                IconButton(onClick = onDismiss, modifier = Modifier.padding(top = 0.dp).size(40.dp)) {
                    Icon(Icons.Outlined.Close, contentDescription = "Dismiss", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

// ── Settings group + row ───────────────────────────────────────

/** Descriptor for one [FSSettingsRow] inside an [FSSettingsGroup]. */
data class FSSettingsRowData(
    val icon: ImageVector,
    val title: String,
    val iconTint: Color? = null,
    val subtitle: String? = null,
    val value: String? = null,
    val badge: Int? = null,
    /** Kept for call-site parity with iOS; Android rows carry no chevron. */
    val showsChevron: Boolean = true,
    val onClick: () -> Unit = {},
    /** Optional stable element handle for the UI gym. */
    val testTag: String? = null,
)

/** A section header above a group: Material's list subheader, in the accent
 *  colour, sentence case. */
@Composable
fun FSSectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        color = MaterialTheme.colorScheme.primary,
        style = MaterialTheme.typography.titleSmall,
        modifier = modifier.padding(start = FS.space.s4, top = FS.space.s2),
    )
}

/** A titled group of rows in one card, with hairlines between rows. */
@Composable
fun FSSettingsGroup(
    rows: List<FSSettingsRowData>,
    modifier: Modifier = Modifier,
    header: String? = null,
) {
    FSGroup(modifier = modifier, header = header) {
        rows.forEachIndexed { idx, row ->
            FSSettingsRow(row)
            if (idx < rows.size - 1) FSDivider()
        }
    }
}

/** A titled card holding list rows; the generic form of [FSSettingsGroup]. */
@Composable
fun FSGroup(
    modifier: Modifier = Modifier,
    header: String? = null,
    content: @Composable () -> Unit,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(FS.space.s2),
        modifier = modifier.fillMaxWidth(),
    ) {
        if (header != null) FSSectionHeader(header)
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surfaceContainerLowest,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Column { content() }
        }
    }
}

/** A hairline between rows of a group, inset to the text. */
@Composable
fun FSDivider(inset: Dp = 56.dp) {
    HorizontalDivider(
        modifier = Modifier.padding(start = inset),
        thickness = 1.dp,
        color = MaterialTheme.colorScheme.outlineVariant,
    )
}

/** One settings row: a Material list item with a bare leading icon, a title,
 *  an optional subtitle, and a trailing value or badge. */
@Composable
fun FSSettingsRow(data: FSSettingsRowData, modifier: Modifier = Modifier) {
    FSRow(
        title = data.title,
        subtitle = data.subtitle,
        icon = data.icon,
        iconTint = data.iconTint,
        onClick = data.onClick,
        modifier = modifier.then(if (data.testTag != null) Modifier.testTag(data.testTag) else Modifier),
        trailing = if (data.value != null || (data.badge != null && data.badge > 0)) {
            {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(FS.space.s2)) {
                    if (data.value != null) {
                        Text(
                            data.value,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                    if (data.badge != null && data.badge > 0) {
                        Badge(containerColor = MaterialTheme.colorScheme.error) { Text(data.badge.toString()) }
                    }
                }
            }
        } else null,
    )
}

/** A Material list item inside a group: optional bare leading icon, title,
 *  subtitle, trailing slot. Clickable when [onClick] is set. */
@Composable
fun FSRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    icon: ImageVector? = null,
    iconTint: Color? = null,
    titleColor: Color? = null,
    onClick: (() -> Unit)? = null,
    enabled: Boolean = true,
    trailing: (@Composable () -> Unit)? = null,
) {
    val alpha = if (enabled) 1f else 0.5f
    ListItem(
        headlineContent = {
            Text(
                title,
                color = (titleColor ?: MaterialTheme.colorScheme.onSurface).copy(alpha = alpha),
                style = MaterialTheme.typography.bodyLarge,
            )
        },
        supportingContent = if (!subtitle.isNullOrEmpty()) ({
            Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha), style = MaterialTheme.typography.bodyMedium)
        }) else null,
        leadingContent = if (icon != null) ({
            Icon(icon, contentDescription = null, tint = (iconTint ?: MaterialTheme.colorScheme.onSurfaceVariant).copy(alpha = alpha))
        }) else null,
        trailingContent = trailing,
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(enabled = enabled, onClick = onClick) else Modifier),
    )
}

// ── Card list row ──────────────────────────────────────────────

/** Leading slot for an [FSListRow]: a tinted status icon, or a monogram. */
sealed interface FSListLeading {
    data class Icon(val icon: ImageVector, val color: Color) : FSListLeading
    data class Monogram(val name: String) : FSListLeading
}

/**
 * A full-width card row: a leading status icon (or a monogram), a title, a
 * muted subtitle, an optional monospaced detail line, an optional line under
 * the text (status tags), and a trailing slot. The title always gets the room
 * first: tags go [below], never beside it.
 */
@Composable
fun FSListRow(
    leading: FSListLeading,
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    detail: String? = null,
    onClick: (() -> Unit)? = null,
    below: (@Composable () -> Unit)? = null,
    trailing: @Composable () -> Unit = {},
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLowest,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(FS.space.s4),
            modifier = Modifier
                .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
                .padding(horizontal = FS.space.s4, vertical = FS.space.s3)
                .heightIn(min = 48.dp),
        ) {
            when (leading) {
                is FSListLeading.Icon -> Box(
                    modifier = Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(leading.color.copy(alpha = 0.12f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(leading.icon, contentDescription = null, tint = leading.color, modifier = Modifier.size(22.dp))
                }
                is FSListLeading.Monogram -> FSMonogram(name = leading.name, size = 40.dp)
            }
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                if (!subtitle.isNullOrEmpty()) {
                    Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                }
                if (!detail.isNullOrEmpty()) {
                    Text(
                        detail,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FSType.mono),
                    )
                }
                if (below != null) {
                    Spacer(Modifier.height(FS.space.s1))
                    below()
                }
            }
            trailing()
        }
    }
}
