package com.flagshipserver.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * Flagship design tokens for Compose. Mirrors `tokens.css`.
 *
 * Source of truth: `/docs/design-system.md`.
 *
 * Usage:
 *
 *   FlagshipTheme {
 *       // your composable content; reads colors via FlagshipColors.current
 *   }
 */

// ── Colors ─────────────────────────────────────────────────────

data class FlagshipColors(
    val bg: Color,
    val surface: Color,
    val surfaceSunken: Color,
    val border: Color,
    val text: Color,
    val textMuted: Color,
    /** Small teal TEXT and links (webapp `--accent`): deepened in light so it
     *  passes 4.5:1. Same value as [accentText]; kept as `primary` for the
     *  Material roles that draw text (text buttons, links). */
    val primary: Color,
    /** The teal for GRAPHICS and large bold headers: icons beside labels,
     *  section markers, switches, progress. Lighter than [accentText]
     *  (3:1 is enough off text); bright teal in dark. */
    val accent: Color,
    /** Small teal text and links; token name shared with iOS `accentText`. */
    val accentText: Color,
    /** Pressed / hovered [primary] (`--accent-press`). */
    val primaryHover: Color,
    /** The Flagship teal as a filled surface: primary buttons, the selected
     *  segment, progress, the operations bar (`--teal`, `--accent-fill`). */
    val fill: Color,
    /** The readable foreground ON [fill] (`--accent-on`): dark ink in both
     *  themes, never white or cream (design-system §2.1). */
    val onAccent: Color,
    val success: Color,
    val warning: Color,
    val danger: Color,
    /** Soft status washes behind status text (web `--ok-soft` etc.). */
    val okWash: Color,
    val warnWash: Color,
    val dangerWash: Color,
)

// The website's palette (apps/web/public/tokens.css), as the webapp carries it
// (apps/web/public/webapp/style.css; docs/design-system.md §2): warm paper in
// light, warm near-black in dark, cream ink, one teal. No pure #000 / #FFF as
// a page or text colour.
val LightColors = FlagshipColors(
    bg              = Color(0xFFF7F6F2), // --canvas
    surface         = Color(0xFFFFFFFF), // --surface (cards)
    surfaceSunken   = Color(0xFFEFEDE7), // --surface-sunken
    border          = Color(0xFFDEDBD3), // --border
    text            = Color(0xFF14140F), // --ink
    textMuted       = Color(0xFF555149), // --ink-muted
    primary         = Color(0xFF0F766E), // --accent
    accent          = Color(0xFF0E9488), // graphics, large bold
    accentText      = Color(0xFF0F766E), // small text, links
    primaryHover    = Color(0xFF0B5F58), // --accent-press
    fill            = Color(0xFF14B8A6), // --teal
    onAccent        = Color(0xFF0A0A09), // --accent-on
    success         = Color(0xFF166534), // --ok
    warning         = Color(0xFF944D05), // --warn
    danger          = Color(0xFFB91C1C), // --err
    okWash          = Color(0x14166534), // rgba(22,101,52,.08)
    warnWash        = Color(0x14944D05), // rgba(148,77,5,.08)
    dangerWash      = Color(0x0FB91C1C), // rgba(185,28,28,.06)
)

val DarkColors = FlagshipColors(
    bg              = Color(0xFF0A0A09), // --canvas
    surface         = Color(0xFF161512), // --surface
    surfaceSunken   = Color(0xFF121110), // --surface-sunken
    border          = Color(0xFF2D2B24), // --border
    text            = Color(0xFFECE7D6), // --ink (warm cream)
    textMuted       = Color(0xFFA39D8F), // --ink-muted
    primary         = Color(0xFF2DD4BF), // --accent (--teal-bright)
    accent          = Color(0xFF2DD4BF), // graphics, large bold
    accentText      = Color(0xFF2DD4BF), // small text, links
    primaryHover    = Color(0xFF5EEAD4), // --accent-press
    fill            = Color(0xFF14B8A6), // --teal
    onAccent        = Color(0xFF0A0A09), // --accent-on
    success         = Color(0xFF4ADE80), // --ok
    warning         = Color(0xFFFBBF24), // --warn
    danger          = Color(0xFFF87171), // --err
    okWash          = Color(0x144ADE80), // rgba(74,222,128,.08)
    warnWash        = Color(0x14FBBF24), // rgba(251,191,36,.08)
    dangerWash      = Color(0x14F87171), // rgba(248,113,113,.08)
)

val LocalFlagshipColors = staticCompositionLocalOf { LightColors }

// ── Spacing ────────────────────────────────────────────────────

object FSSpace {
    val s1  = 4.dp
    val s2  = 8.dp
    val s3  = 12.dp
    val s4  = 16.dp
    val s5  = 20.dp
    val s6  = 24.dp
    val s8  = 32.dp
    val s10 = 40.dp
    val s12 = 48.dp
    val s16 = 64.dp
}

// ── Radii ──────────────────────────────────────────────────────

object FSRadius {
    val sm = 6.dp
    val md = 10.dp
    val lg = 16.dp
    val pill = 999.dp
}

// ── Layout ─────────────────────────────────────────────────────

object FSLayout {
    /** Max width of a hero-screen reading column. On an expanded (tablet /
     *  foldable) pane the WhatsApp-style list rows / cards / chip row would
     *  stretch edge-to-edge and read absurdly wide; clamping to this and
     *  centering keeps a comfortable measure. On a phone (compact) the pane is
     *  already narrower, so the clamp is a no-op. Mirrors iOS
     *  `FSLayout.readingMaxWidth`. */
    val readingMaxWidth = 640.dp
}

// ── Typography ─────────────────────────────────────────────────
//
// The platform's own type (Roboto on Pixel, the maker's system face
// elsewhere) at Material 3's scale, like every native app; the site's mono
// voice survives only where a value is shown (addresses, keys, codes),
// through [FSType.mono]. docs/design-system.md §3: "the phone apps use their
// platform's system font with the same roles".

object FSType {
    val mono: FontFamily = FontFamily.Monospace
}

val FlagshipTypography = Typography().let { t ->
    t.copy(
        // Titles a touch firmer than Material's regular weight: the site's
        // headings are weight 500.
        displaySmall = t.displaySmall.copy(fontWeight = FontWeight.Medium),
        headlineLarge = t.headlineLarge.copy(fontWeight = FontWeight.Medium),
        headlineMedium = t.headlineMedium.copy(fontWeight = FontWeight.Medium),
        headlineSmall = t.headlineSmall.copy(fontWeight = FontWeight.Medium),
        titleLarge = t.titleLarge.copy(fontWeight = FontWeight.Medium),
    )
}

// ── Shapes ─────────────────────────────────────────────────────
//
// Squarer than Material's defaults (the site's corners are 4–6 px), still
// soft enough to read as Android: chips and fields 8, cards and groups 12,
// sheets 16, dialogs 24.

val FlagshipShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(24.dp),
)

// ── Material colour schemes ────────────────────────────────────
//
// Every Material role filled from the site's palette, so stock components
// (top app bars, navigation bar, dialogs, menus, sheets, switches, chips,
// text fields) draw in Flagship's colours with no per-screen overrides. No
// dynamic colour: the brand stays. Surfaces step on the warm-neutral axis;
// cards sit on surfaceContainerLowest (white on paper, a lifted near-black
// in dark).

internal fun flagshipColorScheme(dark: Boolean): ColorScheme {
    val c = if (dark) DarkColors else LightColors
    return if (dark) {
        darkColorScheme(
            primary = c.primary,
            onPrimary = c.onAccent,
            primaryContainer = c.fill,
            onPrimaryContainer = c.onAccent,
            inversePrimary = Color(0xFF0F766E),
            secondary = c.primary,
            onSecondary = c.onAccent,
            // Selection (nav indicator, selected chip/segment) is the bright fill with dark ink.
            secondaryContainer = c.fill,
            onSecondaryContainer = c.onAccent,
            tertiary = c.primary,
            onTertiary = c.onAccent,
            tertiaryContainer = Color(0xFF103A34),
            onTertiaryContainer = Color(0xFF99F6E4),
            background = c.bg,
            onBackground = c.text,
            surface = c.bg,
            onSurface = c.text,
            surfaceVariant = Color(0xFF1D1C18),
            onSurfaceVariant = c.textMuted,
            surfaceTint = Color.Transparent,
            inverseSurface = c.text,
            inverseOnSurface = Color(0xFF14130F),
            error = c.danger,
            onError = c.onAccent,
            errorContainer = Color(0xFF3B1513),
            onErrorContainer = Color(0xFFFECACA),
            outline = Color(0xFF4A473E),
            outlineVariant = c.border,
            scrim = Color.Black,
            surfaceBright = Color(0xFF25231C),
            surfaceDim = c.bg,
            surfaceContainerLowest = c.surface,
            surfaceContainerLow = c.surface,
            surfaceContainer = Color(0xFF14130F),
            surfaceContainerHigh = Color(0xFF1D1C18),
            surfaceContainerHighest = Color(0xFF25231C),
        )
    } else {
        lightColorScheme(
            primary = c.primary,
            // Paper on the deepened teal (AA); never pure white.
            onPrimary = c.bg,
            primaryContainer = c.fill,
            onPrimaryContainer = c.onAccent,
            inversePrimary = Color(0xFF2DD4BF),
            secondary = c.primary,
            onSecondary = c.bg,
            secondaryContainer = c.fill,
            onSecondaryContainer = c.onAccent,
            tertiary = c.primary,
            onTertiary = c.bg,
            tertiaryContainer = Color(0xFFD3ECE6),
            onTertiaryContainer = c.primaryHover,
            background = c.bg,
            onBackground = c.text,
            surface = c.bg,
            onSurface = c.text,
            surfaceVariant = c.surfaceSunken,
            onSurfaceVariant = c.textMuted,
            surfaceTint = Color.Transparent,
            inverseSurface = Color(0xFF2A2925),
            inverseOnSurface = Color(0xFFF0EEE8),
            error = c.danger,
            onError = c.bg,
            errorContainer = Color(0xFFF7E1DD),
            onErrorContainer = Color(0xFF7F1D1D),
            outline = Color(0xFFC8C5BB),
            outlineVariant = c.border,
            scrim = Color.Black,
            surfaceBright = c.surface,
            surfaceDim = Color(0xFFE4E1D9),
            surfaceContainerLowest = c.surface,
            surfaceContainerLow = c.surface,
            surfaceContainer = Color(0xFFF0EEE8),
            surfaceContainerHigh = Color(0xFFFBFAF7),
            surfaceContainerHighest = Color(0xFFE9E7E0),
        )
    }
}

// ── Theme wrapper ──────────────────────────────────────────────

@Composable
fun FlagshipTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) DarkColors else LightColors
    CompositionLocalProvider(LocalFlagshipColors provides colors) {
        MaterialTheme(
            colorScheme = flagshipColorScheme(darkTheme),
            typography = FlagshipTypography,
            shapes = FlagshipShapes,
            content = content,
        )
    }
}

object FS {
    val colors: FlagshipColors
        @Composable get() = LocalFlagshipColors.current
    val space = FSSpace
    val radius = FSRadius
}

/**
 * The standard "icon in a soft-teal rounded square" tint — the accent at the
 * alpha §8.6 uses for a status-pill background. Mirrors the web `--teal-soft`
 * token + iOS `FSColors.softTint`. Pass a semantic color to tint other leading
 * glyphs (status icons in a list row) at the same weight.
 */
fun FlagshipColors.softTint(color: Color? = null): Color = when (color) {
    success -> okWash
    warning -> warnWash
    danger -> dangerWash
    else -> (color ?: accent).copy(alpha = 0.12f)
}

/**
 * Initials for a monogram avatar. First two alphanumeric characters of the
 * name, uppercased; falls back to "?" for an empty/symbol-only string. Shared
 * by FSProfileCard + any list-row monogram so the derivation is identical
 * everywhere. Byte-for-byte mirror of iOS `fsInitials`.
 */
fun fsInitials(name: String): String {
    val prefix = name.filter { it.isLetterOrDigit() }.take(2)
    return if (prefix.isEmpty()) "?" else prefix.uppercase()
}
