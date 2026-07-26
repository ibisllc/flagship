package com.flagshipserver.app.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.fsInitials
import com.flagshipserver.app.ui.theme.softTint

/**
 * WhatsApp-inspired list / settings / chip primitives, built on FS tokens
 * (`/docs/design-system.md`). These compose Home / Services / Settings into one
 * calm grouped-card language. Byte-for-semantics mirror of iOS
 * `FlagshipUI/Components/ComponentsList.swift`.
 *
 *   - FSChipRow / FSChip          — horizontal scrollable filter pills
 *   - FSSearchField               — rounded sunken search field
 *   - FSMonogram                  — circular teal initials avatar (fsInitials)
 *   - FSProfileCard               — account hero (monogram + title + chevron)
 *   - FSAnnouncementCard          — dismissible tinted nudge card
 *   - FSSettingsGroup / FSSettingsRow — grouped rounded settings sections
 *   - FSListRow                   — clean list row (status icon/monogram + meta)
 *
 * All are presentation-only: they take data + callbacks, never app state.
 * Selected = teal-filled; everything else sits on the warm-neutral axis.
 */

// ── Chips ──────────────────────────────────────────────────────

/** Item descriptor for an [FSChipRow] pill. */
data class FSChipItem<T>(val value: T, val label: String, val count: Int? = null)

/**
 * A single filter pill. Selected → teal-filled with white text; unselected →
 * subtle surface with a hairline border. Optional muted count badge. Tap selects.
 */
@Composable
fun FSChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    count: Int? = null,
) {
    val bg by animateColorAsState(
        if (selected) FS.colors.primary else FS.colors.surface,
        tween(durationMillis = 200), label = "chip-bg",
    )
    val border = if (selected) Color.Transparent else FS.colors.border
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        modifier = modifier
            .clip(RoundedCornerShape(FS.radius.pill))
            .background(bg)
            .border(1.dp, border, RoundedCornerShape(FS.radius.pill))
            .clickable(onClick = onClick)
            .padding(horizontal = FS.space.s4)
            .heightIn(min = 34.dp),
    ) {
        Text(
            text = label,
            color = if (selected) FS.colors.onAccent else FS.colors.text,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
        )
        if (count != null) {
            Text(
                text = count.toString(),
                color = if (selected) FS.colors.onAccent.copy(alpha = 0.9f) else FS.colors.textMuted,
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
            )
        }
    }
}

/**
 * A horizontal, scrollable row of [FSChip] filter pills. `selection` is the
 * currently-selected value; tapping a chip invokes [onSelect] with its value.
 */
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
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 1.dp, vertical = 2.dp),
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

/**
 * A rounded sunken search field: a leading magnifier glyph, a placeholder, and
 * a trailing clear ("×") affordance that appears once there's text.
 */
@Composable
fun FSSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "Search",
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s2),
        modifier = modifier
            .fillMaxWidth()
            .height(40.dp)
            .clip(RoundedCornerShape(FS.radius.md))
            .background(FS.colors.surfaceSunken)
            .padding(horizontal = 14.dp),
    ) {
        Text("🔍", color = FS.colors.textMuted, style = TextStyle(fontSize = 15.sp))
        Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                cursorBrush = SolidColor(FS.colors.primary),
                textStyle = TextStyle(color = FS.colors.text, fontSize = 16.sp),
                modifier = Modifier.fillMaxWidth(),
            ) { inner ->
                if (value.isEmpty()) {
                    Text(placeholder, color = FS.colors.textMuted, style = TextStyle(fontSize = 16.sp))
                }
                inner()
            }
        }
        if (value.isNotEmpty()) {
            Box(
                modifier = Modifier
                    .size(18.dp)
                    .clip(CircleShape)
                    .clickable { onValueChange("") },
                contentAlignment = Alignment.Center,
            ) {
                Text("✕", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
            }
        }
    }
}

// ── Monogram ───────────────────────────────────────────────────

/**
 * A circular teal monogram avatar — [fsInitials] of a name on a soft-teal fill.
 * Used by [FSProfileCard] and any row wanting an account glyph.
 */
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
            style = TextStyle(fontSize = (size.value * 0.40f).sp, fontWeight = FontWeight.SemiBold),
        )
    }
}

// ── Profile hero ───────────────────────────────────────────────

/**
 * A prominent account hero card: a teal monogram, the username (bold), a
 * subtitle (tier / status), and a trailing chevron. Tappable; radius-lg card.
 */
@Composable
fun FSProfileCard(
    name: String,
    subtitle: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s4),
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FS.radius.lg))
            .background(FS.colors.surface)
            .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.lg))
            .clickable(onClick = onClick)
            .padding(FS.space.s4),
    ) {
        FSMonogram(name = name)
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = name.ifEmpty { "Your account" },
                color = FS.colors.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
            )
            Text(
                text = subtitle,
                color = FS.colors.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = TextStyle(fontSize = 13.sp),
            )
        }
        Text("›", color = FS.colors.textMuted, style = TextStyle(fontSize = 20.sp))
    }
}

// ── Announcement ───────────────────────────────────────────────

/**
 * A dismissible, tinted rounded card: a leading tinted icon square, a title, a
 * body, an optional CTA button, and an optional "×" to dismiss. [tint] lets a
 * danger-class announcement reuse the same shape; null = brand teal.
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
    Column(
        verticalArrangement = Arrangement.spacedBy(FS.space.s3),
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FS.radius.lg))
            .background(accent.copy(alpha = 0.06f))
            .border(1.dp, accent.copy(alpha = 0.22f), RoundedCornerShape(FS.radius.lg))
            .padding(FS.space.s4),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(FS.space.s3)) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(RoundedCornerShape(FS.radius.sm))
                    .background(accent.copy(alpha = 0.16f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null, tint = accent, modifier = Modifier.size(18.dp))
            }
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, color = FS.colors.text, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold))
                Text(message, color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp))
            }
            if (onDismiss != null) {
                Box(
                    modifier = Modifier
                        .clip(CircleShape)
                        .clickable(onClick = onDismiss)
                        .padding(6.dp),
                ) {
                    Text("✕", color = FS.colors.textMuted, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold))
                }
            }
        }
        if (ctaLabel != null) {
            Box(
                modifier = Modifier
                    .heightIn(min = 44.dp)
                    .clip(RoundedCornerShape(FS.radius.md))
                    .background(accent)
                    .clickable(onClick = onCta)
                    .padding(horizontal = FS.space.s5),
                contentAlignment = Alignment.Center,
            ) {
                Text(ctaLabel, color = FS.colors.onAccent, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold))
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
    val showsChevron: Boolean = true,
    val onClick: () -> Unit = {},
    /** Optional stable element handle for the UI gym (§10 Phase-5). When set,
     *  the rendered row carries `Modifier.testTag(testTag)` so an instrumentation
     *  test can tap/assert this row deterministically. Null ⇒ untagged. */
    val testTag: String? = null,
)

/**
 * A grouped, rounded settings section: an optional small-caps header, then the
 * [rows] stitched into one rounded card with inset hairline dividers between
 * them (inset clears the leading icon so dividers align under the text).
 */
@Composable
fun FSSettingsGroup(
    rows: List<FSSettingsRowData>,
    modifier: Modifier = Modifier,
    header: String? = null,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(FS.space.s2),
        modifier = modifier.fillMaxWidth(),
    ) {
        if (header != null) {
            Text(
                text = header,
                color = FS.colors.textMuted,
                modifier = Modifier.padding(start = FS.space.s1),
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp),
            )
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(FS.radius.lg))
                .background(FS.colors.surface)
                .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.lg)),
        ) {
            rows.forEachIndexed { idx, row ->
                FSSettingsRow(
                    row,
                    modifier = if (row.testTag != null) Modifier.testTag(row.testTag) else Modifier,
                )
                if (idx < rows.size - 1) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(1.dp)
                            .padding(start = 60.dp)
                            .background(FS.colors.border),
                    )
                }
            }
        }
    }
}

/**
 * One settings row: a leading icon in a soft-tinted rounded square, a label, an
 * optional subtitle / trailing value / numeric badge, and a chevron. Full-width
 * tappable. Lives inside an [FSSettingsGroup].
 */
@Composable
fun FSSettingsRow(data: FSSettingsRowData, modifier: Modifier = Modifier) {
    val tint = data.iconTint ?: FS.colors.primary
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .clickable(onClick = data.onClick)
            .padding(horizontal = FS.space.s4, vertical = FS.space.s2),
    ) {
        Box(
            modifier = Modifier
                .size(30.dp)
                .clip(RoundedCornerShape(FS.radius.sm))
                .background(tint.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(data.icon, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
        }
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(data.title, color = FS.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, style = TextStyle(fontSize = 16.sp))
            if (data.subtitle != null) {
                Text(data.subtitle, color = FS.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, style = TextStyle(fontSize = 13.sp))
            }
        }
        if (data.value != null) {
            Text(
                data.value,
                color = FS.colors.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = TextStyle(fontSize = 13.sp),
            )
        }
        if (data.badge != null && data.badge > 0) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(FS.radius.pill))
                    .background(FS.colors.danger)
                    .padding(horizontal = 8.dp, vertical = 2.dp),
            ) {
                Text(data.badge.toString(), color = Color.White, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold))
            }
        }
        if (data.showsChevron) {
            Text("›", color = FS.colors.textMuted.copy(alpha = 0.7f), style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
        }
    }
}

// ── Clean list row ─────────────────────────────────────────────

/** Leading slot for an [FSListRow]: a tinted status icon, or a monogram. */
sealed interface FSListLeading {
    data class Icon(val icon: ImageVector, val color: Color) : FSListLeading
    data class Monogram(val name: String) : FSListLeading
}

/**
 * A clean, full-width tappable list row: a leading status-tinted rounded-square
 * icon (or a monogram), a bold title, a muted subtitle, an optional monospaced
 * detail line, and a trailing composable slot. Used for servers (Home) and apps
 * (Services).
 */
@Composable
fun FSListRow(
    leading: FSListLeading,
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    detail: String? = null,
    onClick: (() -> Unit)? = null,
    // Optional content stacked UNDER the text lines, left-aligned, on its own
    // row — for a status pill whose label ("Never came online") would be
    // crushed in the right-floated `trailing` slot. The chevron / navigation
    // accessory stays in `trailing`; the pill goes here. Null ⇒ no extra row.
    below: (@Composable () -> Unit)? = null,
    trailing: @Composable () -> Unit = {},
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(FS.space.s3),
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(FS.radius.md))
            .background(FS.colors.surface)
            .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.md))
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(FS.space.s4),
    ) {
        when (leading) {
            is FSListLeading.Icon -> Box(
                modifier = Modifier
                    .size(42.dp)
                    .clip(RoundedCornerShape(FS.radius.sm))
                    .background(leading.color.copy(alpha = 0.14f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(leading.icon, contentDescription = null, tint = leading.color, modifier = Modifier.size(22.dp))
            }
            is FSListLeading.Monogram -> FSMonogram(name = leading.name, size = 42.dp)
        }
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = FS.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold))
            if (!subtitle.isNullOrEmpty()) {
                Text(subtitle, color = FS.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, style = TextStyle(fontSize = 13.sp))
            }
            if (!detail.isNullOrEmpty()) {
                Text(
                    detail,
                    color = FS.colors.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = TextStyle(fontSize = 12.sp, fontFamily = FontFamily.Monospace),
                )
            }
            if (below != null) {
                Spacer(Modifier.height(FS.space.s1))
                below()
            }
        }
        Spacer(Modifier.width(FS.space.s2))
        trailing()
    }
}
