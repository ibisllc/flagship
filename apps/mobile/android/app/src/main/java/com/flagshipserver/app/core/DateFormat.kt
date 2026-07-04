package com.flagshipserver.app.core

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * The single date/time formatter for every Android UI string. Twin of the iOS
 * `Date+FlagshipFormat` and the webapp `lib/dateFormat.js` so all three surfaces
 * render timestamps identically. Route every ad-hoc `SimpleDateFormat` /
 * relative-time call in a screen through this — the UI must never show a raw
 * ISO string or a bare formatter default.
 *
 * Rules (v1 UX spec S2):
 *   - < 60s      → "just now"
 *   - < 60m      → "{n}m ago"
 *   - < 24h      → "{n}h ago"
 *   - same year  → "MMM d"  (or "MMM d, h:mm a" when [includeTime])
 *   - older      → "MMM d, yyyy"
 * Month names are locale-aware via the locale-bound [SimpleDateFormat].
 */
object FlagshipDateFormat {
    fun format(
        epochMs: Long,
        nowMs: Long = System.currentTimeMillis(),
        includeTime: Boolean = false,
        locale: Locale = Locale.getDefault(),
        timeZone: TimeZone = TimeZone.getDefault(),
    ): String {
        val deltaMs = nowMs - epochMs
        if (deltaMs >= 0) {
            if (deltaMs < 60_000L) return "just now"
            if (deltaMs < 3_600_000L) return "${deltaMs / 60_000L}m ago"
            if (deltaMs < 86_400_000L) return "${deltaMs / 3_600_000L}h ago"
        }

        val cal = Calendar.getInstance(timeZone, locale)
        cal.timeInMillis = epochMs
        val year = cal.get(Calendar.YEAR)
        cal.timeInMillis = nowMs
        val nowYear = cal.get(Calendar.YEAR)

        val pattern = when {
            year == nowYear && includeTime -> "MMM d, h:mm a"
            year == nowYear -> "MMM d"
            includeTime -> "MMM d, yyyy, h:mm a"
            else -> "MMM d, yyyy"
        }
        val fmt = SimpleDateFormat(pattern, locale)
        fmt.timeZone = timeZone
        return fmt.format(Date(epochMs))
    }
}
