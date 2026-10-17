package com.flagshipserver.app.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import com.flagshipserver.app.ui.theme.FS
import com.flagshipserver.app.ui.theme.FlagshipColors

/** The keyboard / D-pad focus indicator (mirrors the web's focus-visible ring):
 *  a 2 dp bright-teal ring, with a 2 dp ring of ink (cream in dark) just inside
 *  it, so the indicator reads on any fill. */
object FocusRing {
    fun outer(c: FlagshipColors): Color = c.accent
    fun inner(c: FlagshipColors): Color = c.text
}

/** Draws [FocusRing] around this element while it, or a control inside it, holds
 *  focus. Touch never focuses a control, so this shows for keyboards, D-pads and
 *  switch access only. */
@Composable
fun Modifier.fsFocusRing(cornerRadius: androidx.compose.ui.unit.Dp = 8.dp): Modifier {
    var focused by remember { mutableStateOf(false) }
    val outer = FocusRing.outer(FS.colors)
    val inner = FocusRing.inner(FS.colors)
    return this
        .onFocusChanged { focused = it.hasFocus || it.isFocused }
        .then(
            if (!focused) Modifier else Modifier.drawWithContent {
                drawContent()
                val w = 2.dp.toPx()
                val r = cornerRadius.toPx()
                // Inner ring just inside the edge, outer ring just outside it.
                drawRoundRect(
                    color = inner, topLeft = Offset(w / 2, w / 2),
                    size = Size(size.width - w, size.height - w),
                    cornerRadius = CornerRadius((r - w / 2).coerceAtLeast(0f)), style = Stroke(w),
                )
                drawRoundRect(
                    color = outer, topLeft = Offset(-w / 2, -w / 2),
                    size = Size(size.width + w, size.height + w),
                    cornerRadius = CornerRadius(r + w / 2), style = Stroke(w),
                )
            },
        )
}
