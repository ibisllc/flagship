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
    val primary: Color,
    val primaryHover: Color,
    val success: Color,
    val warning: Color,
    val danger: Color,
)

val LightColors = FlagshipColors(
    bg              = Color(0xFFFAFAF7),
    surface         = Color(0xFFFFFFFF),
    surfaceSunken   = Color(0xFFF2F1EC),
    border          = Color(0xFFE6E4DD),
    text            = Color(0xFF14140F),
    textMuted       = Color(0xFF6B6A63),
    primary         = Color(0xFF3B5BFF),
    primaryHover    = Color(0xFF2C46E0),
    success         = Color(0xFF1F8A4C),
    warning         = Color(0xFFB8651A),
    danger          = Color(0xFFC83A3A),
)

val DarkColors = FlagshipColors(
    bg              = Color(0xFF0E0F12),
    surface         = Color(0xFF16181C),
    surfaceSunken   = Color(0xFF1C1F24),
    border          = Color(0xFF2A2D33),
    text            = Color(0xFFF2F1EC),
    textMuted       = Color(0xFF9A9A93),
    primary         = Color(0xFF7E96FF),
    primaryHover    = Color(0xFFA8B8FF),
    success         = Color(0xFF4FBE7A),
    warning         = Color(0xFFE5A050),
    danger          = Color(0xFFE86464),
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
    val materialColors = if (darkTheme) {
        darkColorScheme(
            background = colors.bg,
            surface = colors.surface,
            surfaceVariant = colors.surfaceSunken,
            primary = colors.primary,
            onPrimary = Color.White,
            onBackground = colors.text,
            onSurface = colors.text,
            outline = colors.border,
            error = colors.danger,
        )
    } else {
        lightColorScheme(
            background = colors.bg,
            surface = colors.surface,
            surfaceVariant = colors.surfaceSunken,
            primary = colors.primary,
            onPrimary = Color.White,
            onBackground = colors.text,
            onSurface = colors.text,
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
