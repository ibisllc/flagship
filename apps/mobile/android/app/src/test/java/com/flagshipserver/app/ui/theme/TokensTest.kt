// The phone palette mirrors the website's (docs/design-system.md §2) and
// keeps every text role readable in both themes.

package com.flagshipserver.app.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TokensTest {
    private fun contrast(a: Color, b: Color): Double {
        val l1 = a.luminance().toDouble()
        val l2 = b.luminance().toDouble()
        return (maxOf(l1, l2) + 0.05) / (minOf(l1, l2) + 0.05)
    }

    private fun assertReadable(name: String, fg: Color, bg: Color) {
        val c = contrast(fg, bg)
        assertTrue("$name contrast ${"%.2f".format(c)} < 4.5", c >= 4.5)
    }

    @Test
    fun theWebsitesCanvasInkAndTeal() {
        assertEquals(Color(0xFFF7F6F2), LightColors.bg)
        assertEquals(Color(0xFF0A0A09), DarkColors.bg)
        assertEquals(Color(0xFFECE7D6), DarkColors.text)
        assertEquals(Color(0xFF555149), LightColors.textMuted)
        assertEquals(Color(0xFF14B8A6), LightColors.fill)
        assertEquals(Color(0xFF14B8A6), DarkColors.fill)
    }

    @Test
    fun everyTextRoleIsReadableInBothThemes() {
        for ((theme, c) in listOf("light" to LightColors, "dark" to DarkColors)) {
            for ((surfaceName, surface) in listOf("bg" to c.bg, "surface" to c.surface, "sunken" to c.surfaceSunken)) {
                assertReadable("$theme text on $surfaceName", c.text, surface)
                assertReadable("$theme textMuted on $surfaceName", c.textMuted, surface)
                assertReadable("$theme primary on $surfaceName", c.primary, surface)
            }
            // Status text sits on the page and on cards (the webapp's "AA on paper").
            for ((surfaceName, surface) in listOf("bg" to c.bg, "surface" to c.surface)) {
                assertReadable("$theme danger on $surfaceName", c.danger, surface)
                assertReadable("$theme success on $surfaceName", c.success, surface)
                assertReadable("$theme warning on $surfaceName", c.warning, surface)
            }
            assertReadable("$theme onAccent on fill", c.onAccent, c.fill)
        }
        // Material's onPrimary sits on primary (filled Material controls).
        assertReadable("light paper on primary", LightColors.bg, LightColors.primary)
        assertReadable("dark onAccent on primary", DarkColors.onAccent, DarkColors.primary)
    }

    /** The widget and the Wear OS app draw status with the same tokens. */
    @Test
    fun theCompanionStatusPaletteIsTheAppsTokens() {
        val p = com.flagshipserver.companion.StatusPalette
        val t = com.flagshipserver.companion.PodStatusText.Tone.entries
        assertEquals(LightColors.success, Color(p.light(t[0])))
        assertEquals(listOf(LightColors.success, LightColors.danger, LightColors.warning, LightColors.textMuted), t.map { Color(p.light(it)) })
        assertEquals(listOf(DarkColors.success, DarkColors.danger, DarkColors.warning, DarkColors.textMuted), t.map { Color(p.dark(it)) })
        assertEquals(DarkColors.text, Color(p.DARK_INK))
    }

    @Test
    fun noPureBlackOrWhiteAsPageOrTextColour() {
        for (c in listOf(LightColors, DarkColors)) {
            for (v in listOf(c.bg, c.text, c.textMuted, c.onAccent)) {
                assertNotEquals(Color.Black, v)
                assertNotEquals(Color.White, v)
            }
        }
    }
}
