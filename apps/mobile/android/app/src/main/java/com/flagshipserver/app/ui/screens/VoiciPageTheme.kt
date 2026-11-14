// The voi.ci page's colours (apps/voici-site/src/style.css), so the Social tab shows the page as visitors see it.
// `classic` and `sea` follow light/dark like the site; `ink` is always dark. Mirrors iOS VoiciPageTheme.swift.

package com.flagshipserver.app.ui.screens

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import com.flagshipserver.app.R
import com.flagshipserver.app.core.FSStrings

data class VoiciPageTheme(
    val canvas: Color,
    val surface: Color,
    val ink: Color,
    val inkSoft: Color,
    val muted: Color,
    val rule: Color,
    val ruleStrong: Color,
    val fill: Color,
    val onFill: Color,
    val link: Color,
    val err: Color,
    /** The page itself is drawn dark (ink is dark even on a light phone). */
    val dark: Boolean,
) {
    companion object {
        val ids = listOf("classic", "ink", "sea")

        fun label(id: String): String = when (id) {
            "ink" -> FSStrings.get(R.string.voici_theme_ink)
            "sea" -> FSStrings.get(R.string.voici_theme_sea)
            else -> FSStrings.get(R.string.voici_theme_classic)
        }

        private fun h(v: Long) = Color(0xFF000000 or v)

        fun of(id: String, dark: Boolean): VoiciPageTheme = when {
            id == "ink" -> VoiciPageTheme(
                h(0x0a0a09), h(0x171612), h(0xece7d6), h(0xc8c2b0), h(0xa39d8f), h(0x26241d), h(0x3a372f),
                h(0xece7d6), h(0x0a0a09), h(0x2dd4bf), h(0xf87171), true,
            )
            id == "sea" && dark -> VoiciPageTheme(
                h(0x061015), h(0x0f2028), h(0xe2eef2), h(0xc3d3d9), h(0x8fa6ae), h(0x1a2e36), h(0x2a434d),
                h(0x38bdf8), h(0x06141a), h(0x7dd3fc), h(0xf87171), true,
            )
            id == "sea" -> VoiciPageTheme(
                h(0xf3f6f7), h(0xffffff), h(0x0e1a1f), h(0x23343b), h(0x4c5f67), h(0xdce5e8), h(0xb9c8ce),
                h(0x38bdf8), h(0x06141a), h(0x0369a1), h(0xb91c1c), false,
            )
            dark -> VoiciPageTheme(
                h(0x0a0a09), h(0x161512), h(0xece7d6), h(0xc8c2b0), h(0xa39d8f), h(0x25231c), h(0x3a372f),
                h(0x14b8a6), h(0x0a0a09), h(0x2dd4bf), h(0xf87171), true,
            )
            else -> VoiciPageTheme(
                h(0xf7f6f2), h(0xffffff), h(0x14140f), h(0x2a2924), h(0x555149), h(0xe5e3dc), h(0xc8c5bb),
                h(0x14b8a6), h(0x0a0a09), h(0x0f766e), h(0xb91c1c), false,
            )
        }
    }
}

/** The app is drawn dark right now (its own setting, not only the system's). */
@Composable
fun appIsDark(): Boolean = MaterialTheme.colorScheme.background.luminance() < 0.5f
