// The status colours the widget and the Wear OS app draw with: the app's
// Tokens.kt (the webapp's --ok / --err / --warn / --ink-muted) as ARGB, so the
// companion surfaces need no Compose theme. A JVM test pins them to Tokens.kt.

package com.flagshipserver.companion

object StatusPalette {
    // Light theme.
    const val LIGHT_OK = 0xFF15803DL
    const val LIGHT_ERR = 0xFFB91C1CL
    const val LIGHT_WARN = 0xFFA15C07L
    const val LIGHT_MUTED = 0xFF555149L

    // Dark theme (the watch is always dark).
    const val DARK_OK = 0xFF4ADE80L
    const val DARK_ERR = 0xFFF87171L
    const val DARK_WARN = 0xFFFBBF24L
    const val DARK_MUTED = 0xFFA39D8FL
    const val DARK_INK = 0xFFECE7D6L

    fun light(tone: PodStatusText.Tone): Long = when (tone) {
        PodStatusText.Tone.GOOD -> LIGHT_OK
        PodStatusText.Tone.BAD -> LIGHT_ERR
        PodStatusText.Tone.WAITING -> LIGHT_WARN
        PodStatusText.Tone.NEUTRAL -> LIGHT_MUTED
    }

    fun dark(tone: PodStatusText.Tone): Long = when (tone) {
        PodStatusText.Tone.GOOD -> DARK_OK
        PodStatusText.Tone.BAD -> DARK_ERR
        PodStatusText.Tone.WAITING -> DARK_WARN
        PodStatusText.Tone.NEUTRAL -> DARK_MUTED
    }
}
