package com.flagshipserver.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.googlefonts.Font
import androidx.compose.ui.text.googlefonts.GoogleFont
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.flagshipserver.app.R

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
    /** The teal as a foreground: text, links, icons, outlines, the cursor
     *  (the webapp's `--accent`: deepened in light so it passes AA as text). */
    val primary: Color,
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
    primaryHover    = Color(0xFF0B5F58), // --accent-press
    fill            = Color(0xFF14B8A6), // --teal
    onAccent        = Color(0xFF0A0A09), // --accent-on
    success         = Color(0xFF15803D), // --ok
    warning         = Color(0xFFA15C07), // --warn
    danger          = Color(0xFFB91C1C), // --err
)

val DarkColors = FlagshipColors(
    bg              = Color(0xFF0A0A09), // --canvas
    surface         = Color(0xFF161512), // --surface
    surfaceSunken   = Color(0xFF121110), // --surface-sunken
    border          = Color(0xFF2D2B24), // --border
    text            = Color(0xFFECE7D6), // --ink (warm cream)
    textMuted       = Color(0xFFA39D8F), // --ink-muted
    primary         = Color(0xFF2DD4BF), // --accent (--teal-bright)
    primaryHover    = Color(0xFF5EEAD4), // --accent-press
    fill            = Color(0xFF14B8A6), // --teal
    onAccent        = Color(0xFF0A0A09), // --accent-on
    success         = Color(0xFF4ADE80), // --ok
    warning         = Color(0xFFFBBF24), // --warn
    danger          = Color(0xFFF87171), // --err
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

private val provider = GoogleFont.Provider(
    providerAuthority = "com.google.android.gms.fonts",
    providerPackage = "com.google.android.gms",
    certificates = R.array.com_google_android_gms_fonts_certs,
)

private val SpaceGrotesk = FontFamily(
    Font(googleFont = GoogleFont("Space Grotesk"), fontProvider = provider, weight = FontWeight.Medium),
    Font(googleFont = GoogleFont("Space Grotesk"), fontProvider = provider, weight = FontWeight.SemiBold),
)
private val Inter = FontFamily(
    Font(googleFont = GoogleFont("Inter"), fontProvider = provider, weight = FontWeight.Normal),
    Font(googleFont = GoogleFont("Inter"), fontProvider = provider, weight = FontWeight.Medium),
    Font(googleFont = GoogleFont("Inter"), fontProvider = provider, weight = FontWeight.SemiBold),
)
private val JetBrainsMono = FontFamily(
    Font(googleFont = GoogleFont("JetBrains Mono"), fontProvider = provider, weight = FontWeight.Normal),
    Font(googleFont = GoogleFont("JetBrains Mono"), fontProvider = provider, weight = FontWeight.Medium),
)

val FlagshipTypography = Typography(
    displayLarge = TextStyle(fontFamily = SpaceGrotesk, fontWeight = FontWeight.Medium, fontSize = 56.sp, lineHeight = 60.sp, letterSpacing = (-0.5).sp),
    headlineLarge = TextStyle(fontFamily = SpaceGrotesk, fontWeight = FontWeight.Medium, fontSize = 40.sp, lineHeight = 48.sp, letterSpacing = (-0.3).sp),
    headlineMedium = TextStyle(fontFamily = SpaceGrotesk, fontWeight = FontWeight.Medium, fontSize = 28.sp, lineHeight = 36.sp),
    headlineSmall = TextStyle(fontFamily = SpaceGrotesk, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 30.sp),
    titleLarge = TextStyle(fontFamily = SpaceGrotesk, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, lineHeight = 24.sp),
    bodyLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 26.sp),
    bodyMedium = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 22.sp),
    bodySmall = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 16.sp),
    labelMedium = TextStyle(fontFamily = JetBrainsMono, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 22.sp),
)

// ── Theme wrapper ──────────────────────────────────────────────

@Composable
fun FlagshipTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) DarkColors else LightColors
    // Bottom NavigationBar / NavigationRail read MaterialTheme's
    // secondaryContainer (the selected-item pill) + onSecondaryContainer
    // (the selected icon/label). Pin both to the teal axis so the selected
    // tab reads brand-teal instead of the Material default purple. The soft
    // teal pill matches the §8.6 status-pill background weight.
    val materialColors = if (darkTheme) {
        darkColorScheme(
            background = colors.bg,
            surface = colors.surface,
            surfaceVariant = colors.surfaceSunken,
            primary = colors.primary,
            onPrimary = colors.onAccent,
            secondaryContainer = colors.primary.copy(alpha = 0.20f),
            onSecondaryContainer = colors.primary,
            onBackground = colors.text,
            onSurface = colors.text,
            onSurfaceVariant = colors.textMuted,
            outline = colors.border,
            error = colors.danger,
        )
    } else {
        lightColorScheme(
            background = colors.bg,
            surface = colors.surface,
            surfaceVariant = colors.surfaceSunken,
            primary = colors.primary,
            // Paper on the deepened light-theme teal (AA); never pure white.
            onPrimary = colors.bg,
            secondaryContainer = colors.primary.copy(alpha = 0.14f),
            onSecondaryContainer = colors.primaryHover,
            onBackground = colors.text,
            onSurface = colors.text,
            onSurfaceVariant = colors.textMuted,
            outline = colors.border,
            error = colors.danger,
        )
    }
    CompositionLocalProvider(LocalFlagshipColors provides colors) {
        MaterialTheme(
            colorScheme = materialColors,
            typography = FlagshipTypography,
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
fun FlagshipColors.softTint(color: Color? = null): Color =
    (color ?: primary).copy(alpha = 0.12f)

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
