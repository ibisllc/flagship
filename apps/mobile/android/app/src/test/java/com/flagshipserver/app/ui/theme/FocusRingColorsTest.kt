package com.flagshipserver.app.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import com.flagshipserver.app.ui.components.FocusRing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.max
import kotlin.math.min

/** The keyboard focus ring is the brand teal (2 dp) with a 2 dp ink ring inside it
 *  (cream in dark), as on the web. */
class FocusRingColorsTest {
    private fun ratio(a: Color, b: Color): Double {
        val l1 = max(a.luminance(), b.luminance()).toDouble()
        val l2 = min(a.luminance(), b.luminance()).toDouble()
        return (l1 + 0.05) / (l2 + 0.05)
    }

    @Test fun lightRingIsTealOverInk() {
        assertEquals(Color(0xFF14B8A6), FocusRing.outer(LightColors))
        assertEquals(Color(0xFF14140F), FocusRing.inner(LightColors))
    }

    @Test fun darkRingIsBrightTealOverCream() {
        assertEquals(Color(0xFF2DD4BF), FocusRing.outer(DarkColors))
        assertEquals(Color(0xFFECE7D6), FocusRing.inner(DarkColors))
    }

    @Test fun theInnerRingReadsOnEverySurface() {
        for (c in listOf(LightColors, DarkColors)) {
            for (surface in listOf(c.bg, c.surface)) {
                assertTrue("inner ring on $surface ${ratio(FocusRing.inner(c), surface)}", ratio(FocusRing.inner(c), surface) >= 4.5)
            }
        }
    }
}
