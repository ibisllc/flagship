// A short, stable reason for a failure that the screen words calmly (UserErrorText): the same
// codes as iOS (DiagnosticCode in Diagnostics.swift), safe to copy to support. The sentence stays
// simple; the code keeps the class of failure apart (name lookup, route, trust, refusal, ...).

package com.flagshipserver.app.core

import com.flagshipserver.app.R
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLPeerUnverifiedException

object DiagnosticCode {
    const val RELAY_ROUTE_UNVERIFIED = "relay-route-unverified"
    const val RELAY_PIN_MISMATCH = "relay-pin-mismatch"

    fun of(t: Throwable): String = when (t) {
        is kotlinx.coroutines.CancellationException -> "cancelled"
        is UnknownHostException -> "net-name-lookup"
        is SocketTimeoutException -> "net-timeout"
        is ConnectException -> "net-refused"
        is SSLPeerUnverifiedException -> "tls-pin-mismatch"
        is SSLException -> "tls-failed"
        is IOException -> if (t.message?.contains("reset", ignoreCase = true) == true || t.message?.contains("closed", ignoreCase = true) == true) "net-dropped" else "net-error"
        else -> "error"
    }
}

/** The last few failures the app worded calmly, with the real class kept. Never a body, key or chosen name. */
class DiagnosticsLog(private val clock: () -> Long = { System.currentTimeMillis() }) {
    data class Entry(val at: Long, val code: String, val host: String, val detail: String)

    private val entries = ArrayDeque<Entry>()

    @Synchronized
    fun record(code: String, host: String, detail: String = "") {
        entries.addLast(Entry(clock(), code, host, detail))
        while (entries.size > CAPACITY) entries.removeFirst()
    }

    @Synchronized
    fun recent(): List<Entry> = entries.toList()

    @Synchronized
    fun clear() = entries.clear()

    /** One line per entry, newest last: `2026-10-20T10:00:00Z relay-route-unverified home.x.flagship.services net-dropped`. */
    fun text(): String = recent().joinToString("\n") {
        FSStrings.get(R.string.text, java.time.Instant.ofEpochMilli(it.at), it.code, it.host, if (it.detail.isEmpty()) "" else " ${it.detail}")
    }

    companion object {
        const val CAPACITY = 50
        val shared = DiagnosticsLog()
    }
}
