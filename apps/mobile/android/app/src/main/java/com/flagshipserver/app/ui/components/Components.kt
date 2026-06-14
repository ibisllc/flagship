package com.flagshipserver.app.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.ripple
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.ui.theme.FS

/**
 * Compose primitives mirroring the web `components.css` set.
 *
 * Available:
 *   - FSPrimaryButton / FSSecondaryButton / FSGhostButton / FSDangerButton
 *   - FSCard
 *   - FSField (text input with label + helper + error)
 *   - FSPill (status indicator)
 *   - FSStack (spacing helpers)
 *   - FSTopAppBar
 */

// ── Button ─────────────────────────────────────────────────────

@Composable
fun FSPrimaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    block: Boolean = false,
    large: Boolean = false,
) = FSButtonBase(
    label = label,
    onClick = onClick,
    modifier = modifier,
    enabled = enabled,
    block = block,
    large = large,
    bg = FS.colors.primary,
    fg = Color.White,
    border = null,
)

@Composable
fun FSSecondaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    block: Boolean = false,
    large: Boolean = false,
) = FSButtonBase(
    label = label,
    onClick = onClick,
    modifier = modifier,
    enabled = enabled,
    block = block,
    large = large,
    bg = FS.colors.surface,
    fg = FS.colors.text,
    border = FS.colors.border,
)

@Composable
fun FSGhostButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    block: Boolean = false,
    large: Boolean = false,
) = FSButtonBase(
    label = label,
    onClick = onClick,
    modifier = modifier,
    enabled = enabled,
    block = block,
    large = large,
    bg = Color.Transparent,
    fg = FS.colors.text,
    border = null,
)

@Composable
fun FSDangerButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    // Greys the button (muted foreground + border) while leaving it
    // TAPPABLE — used for a recovery-gated action so a tap can surface a
    // "set up recovery first" toast instead of running the destructive
    // path. Distinct from `enabled = false`, which would swallow taps.
    muted: Boolean = false,
    block: Boolean = false,
    large: Boolean = false,
) = FSButtonBase(
    label = label,
    onClick = onClick,
    modifier = modifier,
    enabled = enabled,
    block = block,
    large = large,
    bg = Color.Transparent,
    fg = if (muted) FS.colors.textMuted else FS.colors.danger,
    border = if (muted) FS.colors.textMuted else FS.colors.danger,
)

@Composable
private fun FSButtonBase(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier,
    enabled: Boolean,
    block: Boolean,
    large: Boolean,
    bg: Color,
    fg: Color,
    border: Color?,
) {
    val height = if (large) 48.dp else 40.dp
    val padH = if (large) 28.dp else 20.dp
    val interaction = remember { MutableInteractionSource() }
    val alpha by animateFloatAsState(if (enabled) 1f else 0.4f, tween(durationMillis = 200), label = "btn-alpha")
    Box(
        modifier = modifier
            .then(if (block) Modifier.fillMaxWidth() else Modifier)
            .heightIn(min = height)
            .clip(RoundedCornerShape(FS.radius.md))
            .background(bg.copy(alpha = bg.alpha * alpha))
            .let { if (border != null) it.border(BorderStroke(1.dp, border.copy(alpha = border.alpha * alpha)), RoundedCornerShape(FS.radius.md)) else it }
            .clickable(
                interactionSource = interaction,
                indication = ripple(bounded = true, color = fg),
                enabled = enabled,
                onClick = onClick,
            )
            .padding(horizontal = padH, vertical = 0.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = fg.copy(alpha = fg.alpha * alpha),
            style = TextStyle(
                fontWeight = FontWeight.SemiBold,
                fontSize = if (large) 16.sp else 14.sp,
            ),
        )
    }
}

// ── Card ───────────────────────────────────────────────────────

@Composable
fun FSCard(
    modifier: Modifier = Modifier,
    padding: PaddingValues = PaddingValues(FS.space.s4),
    content: @Composable () -> Unit,
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(FS.radius.md))
            .background(FS.colors.surface)
            .border(1.dp, FS.colors.border, RoundedCornerShape(FS.radius.md))
            .padding(padding),
    ) {
        Column { content() }
    }
}

// ── Field ──────────────────────────────────────────────────────

@Composable
fun FSField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    helper: String? = null,
    error: String? = null,
    keyboardType: KeyboardType = KeyboardType.Text,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    enabled: Boolean = true,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text = label,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
            color = FS.colors.text,
        )
        Spacer(Modifier.height(FS.space.s2))
        val borderColor = if (error != null) FS.colors.danger else FS.colors.border
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(40.dp)
                .clip(RoundedCornerShape(FS.radius.sm))
                .background(FS.colors.surfaceSunken)
                .border(1.dp, borderColor, RoundedCornerShape(FS.radius.sm))
                .padding(horizontal = 14.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                enabled = enabled,
                cursorBrush = SolidColor(FS.colors.primary),
                textStyle = TextStyle(color = FS.colors.text, fontSize = 16.sp),
                visualTransformation = visualTransformation,
                modifier = Modifier.fillMaxWidth(),
            ) { inner ->
                if (value.isEmpty() && placeholder.isNotEmpty()) {
                    Text(placeholder, color = FS.colors.textMuted, style = TextStyle(fontSize = 16.sp))
                }
                inner()
            }
        }
        val sub = error ?: helper
        if (sub != null) {
            Spacer(Modifier.height(FS.space.s2))
            Text(
                text = sub,
                color = if (error != null) FS.colors.danger else FS.colors.textMuted,
                style = TextStyle(fontSize = 14.sp),
            )
        }
    }
}

// ── Pill ───────────────────────────────────────────────────────

enum class FSPillKind { Online, Renewing, Offline, Provisioning, Idle }

@Composable
fun FSPill(label: String, kind: FSPillKind, modifier: Modifier = Modifier) {
    val (fg, bg) = when (kind) {
        FSPillKind.Online -> FS.colors.success to FS.colors.success.copy(alpha = 0.12f)
        FSPillKind.Renewing -> FS.colors.warning to FS.colors.warning.copy(alpha = 0.12f)
        FSPillKind.Offline -> FS.colors.danger to FS.colors.danger.copy(alpha = 0.12f)
        FSPillKind.Provisioning -> FS.colors.primary to FS.colors.primary.copy(alpha = 0.12f)
        FSPillKind.Idle -> FS.colors.textMuted to FS.colors.surfaceSunken
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        modifier = modifier
            .clip(RoundedCornerShape(FS.radius.pill))
            .background(bg)
            .padding(horizontal = 10.dp, vertical = 2.dp)
            .defaultMinSize(minHeight = 22.dp),
    ) {
        Box(
            modifier = Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(fg),
        )
        Text(
            text = label,
            color = fg,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
        )
    }
}

// ── Stack helpers ──────────────────────────────────────────────

@Composable
fun FSStackVertical(spacing: Dp = FS.space.s4, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(spacing)) { content() }
}
