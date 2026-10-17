package com.flagshipserver.app.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.max
import kotlin.math.min

/** The teal's three roles hold their contrast (WCAG 2.x): fills carry dark ink
 *  and small teal text passes 4.5:1; graphics and large bold headers pass 3:1.
 *  Token names match iOS Theme.swift (accent, accentText, fill). */
class TealContrastTest {
    private fun ratio(a: Color, b: Color): Double {
        val l1 = max(a.luminance(), b.luminance()).toDouble()
        val l2 = min(a.luminance(), b.luminance()).toDouble()
        return (l1 + 0.05) / (l2 + 0.05)
    }

    private fun check(name: String, c: FlagshipColors) {
        for ((surfaceName, surface) in listOf("bg" to c.bg, "surface" to c.surface, "sunken" to c.surfaceSunken)) {
            assertTrue("$name accentText on $surfaceName ${ratio(c.accentText, surface)}", ratio(c.accentText, surface) >= 4.5)
            assertTrue("$name primary (text) on $surfaceName ${ratio(c.primary, surface)}", ratio(c.primary, surface) >= 4.5)
            assertTrue("$name accent on $surfaceName ${ratio(c.accent, surface)}", ratio(c.accent, surface) >= 3.0)
        }
        assertTrue("$name onAccent on fill ${ratio(c.onAccent, c.fill)}", ratio(c.onAccent, c.fill) >= 4.5)
        assertTrue("$name text on bg", ratio(c.text, c.bg) >= 4.5)
        assertTrue("$name muted text on bg", ratio(c.textMuted, c.bg) >= 4.5)
    }

    private fun over(top: Color, base: Color): Color = top.compositeOver(base)

    private fun checkStatus(name: String, c: FlagshipColors, canvas2: Color) {
        val surfaces = listOf("bg" to c.bg, "canvas-2" to canvas2, "surface" to c.surface, "sunken" to c.surfaceSunken)
        val tones = listOf(
            Triple("ok", c.success, c.okWash), Triple("warn", c.warning, c.warnWash), Triple("err", c.danger, c.dangerWash),
        )
        for ((tn, fg, wash) in tones) for ((sn, surface) in surfaces) {
            assertTrue("$name $tn on $sn ${ratio(fg, surface)}", ratio(fg, surface) >= 4.5)
            val washed = over(wash, surface)
            assertTrue("$name $tn on its wash over $sn ${ratio(fg, washed)}", ratio(fg, washed) >= 4.5)
        }
    }

    @Test fun lightStatusTextHoldsItsContrast() = checkStatus("light", LightColors, Color(0xFFF0EEE8))
    @Test fun darkStatusTextHoldsItsContrast() = checkStatus("dark", DarkColors, Color(0xFF14130F))

    @Test fun lightTealRolesHoldTheirContrast() = check("light", LightColors)
    @Test fun darkTealRolesHoldTheirContrast() = check("dark", DarkColors)
}
