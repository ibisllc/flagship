// Every catch that turns an error into a sentence for a person logs what the
// sentence hides, so a report ("it said Something went wrong") can be traced.
// Logged: where, a short code, and each exception's class and message along
// the cause chain. Never keys, secrets or passphrases: callers pass the
// throwable only, and messages are cut short and kept on one line.

package com.flagshipserver.app.core

object ErrorLog {
    const val TAG = "Flagship"
    private const val MAX_MESSAGE = 200
    private const val MAX_CAUSES = 4

    /** The line [caught] logs, without touching android.util.Log (testable). */
    fun line(where: String, t: Throwable, code: String): String {
        val chain = generateSequence(t) { it.cause }.take(MAX_CAUSES).joinToString(" <- ") { e ->
            val msg = e.message?.replace(Regex("\\s+"), " ")?.take(MAX_MESSAGE)
            if (msg.isNullOrEmpty()) e.javaClass.name else "${e.javaClass.name}: $msg"
        }
        return "[$code] $where: $chain"
    }

    /** A breadcrumb for one step of an action (never key material). */
    fun step(where: String, what: String) {
        runCatching { android.util.Log.i(TAG, "$where: $what") }
    }

    fun caught(where: String, t: Throwable, code: String) {
        val line = line(where, t, code)
        runCatching { android.util.Log.w(TAG, line) }
    }
}
