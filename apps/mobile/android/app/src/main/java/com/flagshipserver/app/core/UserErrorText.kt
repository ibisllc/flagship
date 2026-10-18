package com.flagshipserver.app.core

import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The one place a failure becomes a sentence a person reads.
 *
 * Every screen that shows an error from `.com` or a box goes through [of] (a
 * throwable) or [ofRaw] (text a view model already stored). Nothing here lets
 * a transport string ("connection closed", "unable to resolve host"), an HTTP
 * status line ("HTTP 503: error code: 1102"), a stack class or a shell line
 * number reach the screen; the real text is still written to [ErrorLog] under
 * a short code so a report can be matched to it.
 *
 * A message someone wrote for people (a box's own sentence, a view model's
 * "Pick a name first.") passes through unchanged.
 */
object UserErrorText {

    const val OFFLINE = "Can't reach the server. Check your connection and try again."
    const val DROPPED = "The connection dropped. Try again."
    const val TIMEOUT = "That took too long. Check your connection and try again."
    const val SERVER_PROBLEM = "The server had a temporary problem. Try again in a moment."
    const val REFUSED = "We couldn't complete that. Try again."
    const val GENERIC = "Something went wrong. Try again."

    private val json = Json { ignoreUnknownKeys = true }

    /** `.com` reasons written for developers, and what to say instead. */
    private val knownReasons: List<Pair<Regex, String>> = listOf(
        Regex("subdomain already controlled by a different rck", RegexOption.IGNORE_CASE) to
            "That name is still held by an earlier, unfinished order. Cancel that order from Home, or choose another name.",
        Regex("^stale request", RegexOption.IGNORE_CASE) to
            "This phone's clock looks off. Check the date and time, then try again.",
        Regex("^invalid signature", RegexOption.IGNORE_CASE) to
            "Your account key didn't match. Try again, or sign in again.",
        Regex("^not authorized", RegexOption.IGNORE_CASE) to
            "This device isn't allowed to do that.",
    )

    /** Text that is a runtime artefact rather than a sentence. */
    private val rawMarkers = Regex(
        "(?i)(^HTTP\\s*\\d{3}|\\bexception\\b|\\bjava\\.|\\bkotlin|\\bokhttp|\\bokio|\\bjavax|\\bssl\\b|" +
            "handshake|\\berrno|\\beconn|\\bsocket\\b|unexpected end of stream|\\bEOF\\b|broken pipe|" +
            "software caused|error code:? ?\\d+|^[\\[{<]|unexpected json|could not parse|stacktrace|\\bnull\\b|" +
            "standalonecoroutine|jobcancellation|no value passed|illegalargument|illegalstate)",
    )

    private val lineNumber = Regex("\\s*[(\\[]?\\b(at )?lines? ?\\d+[)\\]]?", RegexOption.IGNORE_CASE)

    /** [message] without a shell or source line number ("... (line 66)"). */
    fun stripInternals(message: String): String =
        lineNumber.replace(message, "").replace(Regex("\\s{2,}"), " ").trim().trimEnd(',', ':', ';')

    /** The sentence for [t]. [fallback] replaces the generic one when nothing
     *  better is known; [where] tags the log line that keeps the real error. */
    fun of(t: Throwable, fallback: String? = null, where: String = "error"): String {
        ErrorLog.caught(where, t, NetworkErrorHumanizer.errorCode(t))
        val classified = NetworkErrorHumanizer.classify(t)
        when (classified.kind) {
            NetworkErrorHumanizer.Kind.CERT_PIN_MISMATCH,
            NetworkErrorHumanizer.Kind.RATE_LIMITED,
            NetworkErrorHumanizer.Kind.PASSKEY,
            NetworkErrorHumanizer.Kind.BIOMETRIC -> return classified.message
            else -> Unit
        }
        if (t is AddServerRefused || AddServerGate.isServerRefusal(t)) return classified.message
        val status = statusOf(t)
        if (status != null) return forStatus(status, bodyOf(t), fallback)
        val chain = generateSequence(t) { it.cause }.take(8).toList()
        for (c in chain) {
            val m = c.message.orEmpty()
            if (looksAuthored(m) && m[0].isUpperCase() && m.last() in ".!?") continue
            when {
                c is SocketTimeoutException || m.contains("timed out", true) || m.contains("timeout", true) -> return TIMEOUT
                c is java.io.EOFException || c is java.net.SocketException && m.isEmpty() -> return DROPPED
                c is UnknownHostException || m.contains("unable to resolve", true) ||
                    m.contains("no address associated", true) || m.contains("failed to connect", true) -> return OFFLINE
                m.contains("closed", true) || m.contains("reset", true) || m.contains("unexpected end of stream", true) ||
                    m.contains("broken pipe", true) || m.contains("software caused", true) || m == "EOF" -> return DROPPED
            }
        }
        if (chain.any { it is IOException }) return OFFLINE
        // An exception's text is shown only when it was written as a sentence
        // for people; anything else is the fallback, or the generic sentence
        // that carries the logged code.
        val msg = t.message?.trim().orEmpty()
        if (looksAuthored(msg) && msg[0].isUpperCase() && msg.last() in ".!?") return stripInternals(msg)
        return fallback ?: classified.message
    }

    /** Why a local step failed (a key prompt, a signing step), for a sentence
     *  of the form "Couldn't X: <reason>". Typed prompt failures read in
     *  plain words; any other error keeps its own short text. */
    fun reason(t: Throwable): String {
        val c = NetworkErrorHumanizer.classify(t)
        return when (c.kind) {
            NetworkErrorHumanizer.Kind.BIOMETRIC, NetworkErrorHumanizer.Kind.PASSKEY,
            NetworkErrorHumanizer.Kind.RATE_LIMITED, NetworkErrorHumanizer.Kind.CERT_PIN_MISMATCH -> c.message
            else -> t.message?.let { stripInternals(it) }?.takeIf { it.isNotEmpty() } ?: GENERIC
        }
    }

    /** The sentence for text that was stored from a failure: authored text
     *  stays (minus any line number), anything raw becomes [fallback]. */
    fun ofRaw(raw: String?, fallback: String? = null): String {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return fallback ?: GENERIC
        statusFromText(text)?.let { return forStatus(it, text.substringAfter(':', ""), fallback) }
        if (looksAuthored(text) && text[0].isUpperCase() && text.last() in ".!?") return stripInternals(text)
        val lower = text.lowercase()
        when {
            "timed out" in lower || "timeout" in lower -> return TIMEOUT
            "unable to resolve" in lower || "unknownhost" in lower || "failed to connect" in lower ||
                "no address associated" in lower -> return OFFLINE
            "closed" in lower || "connection reset" in lower || "unexpected end of stream" in lower ||
                "broken pipe" in lower || lower == "eof" -> return DROPPED
        }
        if (looksAuthored(text)) return stripInternals(text)
        return fallback ?: GENERIC
    }

    /** True when [text] reads as a sentence written for people. */
    fun looksAuthored(text: String): Boolean =
        text.length >= 4 && text.any { it == ' ' } && !rawMarkers.containsMatchIn(text)

    private fun statusOf(t: Throwable): Int? = when (t) {
        is HttpException -> t.status
        is HasHttpStatus -> t.httpStatus
        else -> null
    }

    private fun bodyOf(t: Throwable): String = when (t) {
        is HttpException -> t.body
        is com.flagshipserver.app.api.ScreensError.Http -> t.body
        else -> ""
    }

    private fun statusFromText(text: String): Int? =
        Regex("^HTTP\\s*(\\d{3})").find(text)?.groupValues?.get(1)?.toIntOrNull()

    private fun forStatus(status: Int, body: String, fallback: String?): String {
        if (status >= 500) return SERVER_PROBLEM
        if (status == 408) return TIMEOUT
        boxSentence(body)?.let { return it }
        return fallback ?: REFUSED
    }

    /** The sentence in a refused call's `{"error": "..."}` body, when it is one
     *  a person can read (capitalised, ends like a sentence) or a known reason. */
    private fun boxSentence(body: String): String? {
        val raw = body.trim().removePrefix(":").trim()
        val text = runCatching { (json.parseToJsonElement(raw) as? JsonObject) }.getOrNull()
            ?.let { obj -> listOf("error", "message").firstNotNullOfOrNull { k -> (obj[k] as? JsonPrimitive)?.takeIf { it.isString }?.content } }
            ?: raw.takeIf { !it.startsWith("{") && !it.startsWith("<") }
        if (text.isNullOrBlank()) return null
        knownReasons.firstOrNull { it.first.containsMatchIn(text) }?.let { return it.second }
        val readable = text[0].isUpperCase() && text.last() in ".!?" && looksAuthored(text)
        return if (readable) stripInternals(text) else null
    }
}
