package com.flagshipserver.app.ui.components

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import com.flagshipserver.app.ui.components.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.ui.theme.FS

/**
 * Flagship's Compose primitives, drawn with Material 3's own components so
 * the app reads as Android: the site's palette and squarer corners are the
 * brand's touch (docs/design-system.md §8).
 *
 *   - FSPrimaryButton   — filled (the one main action on a screen or card)
 *   - FSSecondaryButton — outlined (a second action beside or under it)
 *   - FSGhostButton     — text button (dialogs, app bars, a quiet inline link)
 *   - FSDangerButton    — outlined in the error colour
 *   - FSCard            — a full-width outlined surface
 *   - FSField           — an outlined text field with label, helper and error
 *   - FSPill            — a status tag
 */

private val ButtonHeight = 40.dp
private val ButtonHeightLarge = 48.dp

private fun Modifier.buttonSize(block: Boolean, large: Boolean): Modifier =
    this
        .then(if (block) Modifier.fillMaxWidth() else Modifier)
        .heightIn(min = if (large || block) ButtonHeightLarge else ButtonHeight)

private val ButtonPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp)

@Composable
private fun ButtonLabel(label: String) {
    // A label change ("Save" -> "Working...") fades instead of jumping.
    androidx.compose.animation.Crossfade(targetState = label, animationSpec = androidx.compose.animation.core.tween(150), label = "button-label") {
        Text(it, style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
    }
}

/** [onClick] with a short confirming tick (or a firmer one for a destructive action). */
@Composable
private fun withHaptic(destructive: Boolean, onClick: () -> Unit): () -> Unit {
    val view = androidx.compose.ui.platform.LocalView.current
    return {
        val kind = if (destructive) android.view.HapticFeedbackConstants.LONG_PRESS else android.view.HapticFeedbackConstants.CONFIRM
        view.performHapticFeedback(kind)
        onClick()
    }
}

// ── Button ─────────────────────────────────────────────────────

/** The teal fill with dark ink (the site's primary button), as a Material
 *  filled button. */
@Composable
fun FSPrimaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    block: Boolean = false,
    large: Boolean = false,
) {
    Button(
        onClick = withHaptic(false, onClick),
        enabled = enabled,
        modifier = modifier.buttonSize(block, large).fsFocusRing(20.dp),
        contentPadding = ButtonPadding,
        colors = ButtonDefaults.buttonColors(
            containerColor = FS.colors.fill,
            contentColor = FS.colors.onAccent,
        ),
    ) { ButtonLabel(label) }
}

@Composable
fun FSSecondaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    block: Boolean = false,
    large: Boolean = false,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.buttonSize(block, large).fsFocusRing(20.dp),
        contentPadding = ButtonPadding,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = if (enabled) 1f else 0.4f)),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    ) { ButtonLabel(label) }
}

/** A Material text button in the accent colour. For dialogs, app bars and
 *  quiet inline links; a card's main action is [FSPrimaryButton] or
 *  [FSSecondaryButton]. */
@Composable
fun FSGhostButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    block: Boolean = false,
    large: Boolean = false,
) {
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.buttonSize(block, large).fsFocusRing(20.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
    ) { ButtonLabel(label) }
}

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
) {
    val fg = if (muted) FS.colors.textMuted else MaterialTheme.colorScheme.error
    OutlinedButton(
        onClick = withHaptic(true, onClick),
        enabled = enabled,
        modifier = modifier.buttonSize(block, large).fsFocusRing(20.dp),
        contentPadding = ButtonPadding,
        border = BorderStroke(1.dp, fg.copy(alpha = if (enabled) 1f else 0.4f)),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = fg),
    ) { ButtonLabel(label) }
}

// ── Card ───────────────────────────────────────────────────────

/** A full-width outlined card: separation by a hairline, never a shadow
 *  (docs/design-system.md §8.3). Every card spans the column, so edges line up. */
@Composable
fun FSCard(
    modifier: Modifier = Modifier,
    padding: PaddingValues = PaddingValues(FS.space.s4),
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLowest,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Column(Modifier.animateContentSize().padding(padding)) { content() }
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
    // Optional testTag applied to the editable text field itself (where the
    // RequestFocus / SetText semantics live). Inert in release.
    fieldTag: String? = null,
) {
    val sub = error ?: helper
    // The caller's modifier (and any testTag on it) sits on a wrapper, so
    // the editable node is its descendant, as gym tests expect.
    Box(modifier.fillMaxWidth()) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        placeholder = if (placeholder.isNotEmpty()) ({ Text(placeholder) }) else null,
        colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(focusedLabelColor = FS.colors.accentText),
        supportingText = if (sub != null) ({ Text(sub) }) else null,
        isError = error != null,
        singleLine = true,
        enabled = enabled,
        // A masked field must tell the keyboard so: as plain text the IME
        // autocorrects or appends a space to a passphrase, so the two
        // entries differ and the backup stays disabled (M14).
        keyboardOptions = if (visualTransformation is androidx.compose.ui.text.input.PasswordVisualTransformation) {
            KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false)
        } else {
            KeyboardOptions(keyboardType = keyboardType)
        },
        visualTransformation = visualTransformation,
        shape = MaterialTheme.shapes.small,
        modifier = Modifier
            .fillMaxWidth()
            .fsFocusRing(8.dp)
            .then(if (fieldTag != null) Modifier.testTag(fieldTag) else Modifier),
    )
    }
}

// ── Pill ───────────────────────────────────────────────────────

enum class FSPillKind { Online, Renewing, Offline, Provisioning, Pending, Idle }

/** An app status pill's tone (docs/app-placement.md §6) as a pill kind. */
fun com.flagshipserver.app.core.AppStatus.Tone.pillKind(): FSPillKind = when (this) {
    com.flagshipserver.app.core.AppStatus.Tone.Online -> FSPillKind.Online
    com.flagshipserver.app.core.AppStatus.Tone.Accent -> FSPillKind.Provisioning
    com.flagshipserver.app.core.AppStatus.Tone.Idle -> FSPillKind.Idle
    com.flagshipserver.app.core.AppStatus.Tone.Warning -> FSPillKind.Pending
}

/** A status tag: a dot and a short label on the tone's soft tint, small
 *  corners (docs/design-system.md §8.7). Never truncates its label; callers
 *  give the row's title the room first. */
@Composable
fun FSPill(
    label: String,
    kind: FSPillKind,
    modifier: Modifier = Modifier,
    /** An icon after the label, in gray (the services list's "2" and Home's server icon). */
    trailingIcon: androidx.compose.ui.graphics.vector.ImageVector? = null,
) {
    val (fg, bg) = when (kind) {
        FSPillKind.Online -> FS.colors.success to FS.colors.success.copy(alpha = 0.12f)
        FSPillKind.Renewing -> FS.colors.warning to FS.colors.warning.copy(alpha = 0.12f)
        FSPillKind.Offline -> FS.colors.danger to FS.colors.danger.copy(alpha = 0.12f)
        FSPillKind.Provisioning -> FS.colors.accentText to FS.colors.accent.copy(alpha = 0.12f)
        FSPillKind.Pending -> FS.colors.warning to FS.colors.warning.copy(alpha = 0.12f)
        FSPillKind.Idle -> FS.colors.textMuted to FS.colors.textMuted.copy(alpha = 0.10f)
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        modifier = modifier
            .clip(MaterialTheme.shapes.extraSmall)
            .background(bg)
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .defaultMinSize(minHeight = 20.dp),
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
            maxLines = 1,
            softWrap = false,
            style = MaterialTheme.typography.labelMedium,
        )
        if (trailingIcon != null) {
            androidx.compose.material3.Icon(
                trailingIcon,
                contentDescription = null,
                tint = FS.colors.textMuted,
                modifier = Modifier.size(12.dp),
            )
        }
    }
}

// ── Stack helpers ──────────────────────────────────────────────

@Composable
fun FSStackVertical(spacing: Dp = FS.space.s4, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(spacing)) { content() }
}


/** A text button: its label is small teal text, so it draws in [FlagshipColors.accentText]
 *  (4.5:1), not the bright graphic teal. Same signature as Material's, so the
 *  app's dialogs, bars and rows read the same. */
@Composable
fun TextButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    colors: androidx.compose.material3.ButtonColors = ButtonDefaults.textButtonColors(contentColor = FS.colors.accentText),
    contentPadding: PaddingValues = ButtonDefaults.TextButtonContentPadding,
    content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit,
) = androidx.compose.material3.TextButton(
    onClick = onClick,
    modifier = modifier.fsFocusRing(20.dp),
    enabled = enabled,
    colors = colors,
    contentPadding = contentPadding,
    content = content,
)
