// An app's disk use and limits (docs/app-runtimes.md 5.3), as the box sends
// them on app-detail and server-detail (`storage`): one line per store, and
// the sentences shown while new data is refused. MIRRORS the webapp's
// lib/appStorage.js, word for word.

package com.flagshipserver.app.core

import com.flagshipserver.app.api.AppStorage
import com.flagshipserver.app.api.ServerStorage
import com.flagshipserver.app.api.StoreUsage

object AppStorageText {
    const val FULL_SENTENCE = "Full: new data is refused until you free space or raise the limit."
    const val STOPPED_SENTENCE = "Its database is closed until it is under its limit again."
    const val ALERT = "An app on this server is full"

    /** One line on the app's page: `Files  2.0 GB of 5.0 GB`, with the sentence when it is full. */
    data class Line(val label: String, val text: String, val full: Boolean, val note: String)

    private fun size(n: Long): String = when {
        n >= 1024L * 1024 * 1024 -> BackupsText.gb(n)
        n >= 1024L * 1024 -> "${Math.round(n / (1024.0 * 1024))} MB"
        else -> "${maxOf(0L, Math.round(n / 1024.0))} KB"
    }

    private fun line(label: String, s: StoreUsage?): Line? {
        if (s == null) return null
        val of = s.limitBytes?.let { " of ${size(it)}" }.orEmpty()
        val full = s.full || s.writesBlocked
        return Line(label, "${size(s.usedBytes)}$of", full, if (s.stopped) STOPPED_SENTENCE else if (full) FULL_SENTENCE else "")
    }

    /** The app page's lines, files then database. */
    fun appLines(storage: AppStorage?): List<Line> =
        listOfNotNull(line("Files", storage?.files), line("Database", storage?.postgres))

    /** The server page's notes about full apps and the disk brake. */
    fun serverNotes(storage: ServerStorage?, nameOf: (String) -> String = { it }): List<String> {
        if (storage == null) return emptyList()
        val out = mutableListOf<String>()
        when (storage.brake) {
            "hard" -> out += "The server's disk is full: apps' folders are read-only until there's room."
            "on" -> out += "The server's disk is nearly full: apps can't save more until there's room."
        }
        for (a in storage.apps) {
            val full = a.files?.full == true || a.postgres?.let { it.full || it.writesBlocked } == true
            if (full) out += "${nameOf(a.serviceId)} is full: new data is refused until you free space or raise the limit."
        }
        return out
    }
}
