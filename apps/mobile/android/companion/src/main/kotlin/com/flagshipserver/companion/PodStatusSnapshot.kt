// Kotlin twin of iOS PodStatusSnapshot (apps/mobile/ios/App/Shared). What the
// app hands its glanceable surfaces (the home-screen widget, the watch): per
// server only its name, address, online state and whether it leads. Nothing a
// widget or watch shows comes from anywhere else, and neither fetches.

package com.flagshipserver.companion

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class PodStatusSnapshot(
    val username: String? = null,
    val pods: List<Pod> = emptyList(),
    /** Epoch ms the app wrote this snapshot. */
    val updatedAt: Long = 0,
    /** The control host the app talks to (a gym build's differs from prod), so
     *  a tap reaches the app's in-app link router. */
    val controlHost: String? = null,
) {
    @Serializable
    data class Pod(
        val podId: String,
        val name: String,
        val fqdn: String,
        /** "online" | "offline" | "pending" | "unknown". */
        val statusRaw: String,
        val isLeader: Boolean,
    )

    /** The server a small surface shows: the leader, else the first. */
    val headline: Pod? get() = pods.firstOrNull { it.isLeader } ?: pods.firstOrNull()

    /** The servers a list surface shows, in the owner's order. */
    fun listed(max: Int = LIST_MAX): List<Pod> = pods.take(max)

    /** `https://<controlHost>/app/<route>?<query>`, the in-app link the app's
     *  DeepLink router takes. */
    fun appRouteUrl(route: String, query: Map<String, String> = emptyMap()): String {
        val q = query.entries.joinToString("&") {
            "${encode(it.key)}=${encode(it.value)}"
        }
        return "https://${controlHost ?: DEFAULT_HOST}/app/$route" + if (q.isEmpty()) "" else "?$q"
    }

    /** The link that opens [pod]'s page in the app. */
    fun serverUrl(pod: Pod): String = appRouteUrl("server", mapOf("podId" to pod.podId))

    fun encode(): String = JSON.encodeToString(serializer(), this)

    companion object {
        const val LIST_MAX = 4
        const val DEFAULT_HOST = "flagshipserver.com"
        val EMPTY = PodStatusSnapshot()

        private val JSON = Json { ignoreUnknownKeys = true; encodeDefaults = true }

        /** The stored snapshot, or [EMPTY] when there is none or it can't be read. */
        fun decode(text: String?): PodStatusSnapshot =
            text?.let { runCatching { JSON.decodeFromString(serializer(), it) }.getOrNull() } ?: EMPTY

        private fun encode(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")
    }
}

/** Labels and tones shared by every surface that shows a server's state. */
object PodStatusText {
    enum class Tone { GOOD, BAD, WAITING, NEUTRAL }

    fun label(statusRaw: String): String = when (statusRaw) {
        "online" -> "Online"
        "offline" -> "Offline"
        "pending" -> "Pending"
        else -> "Unknown"
    }

    fun tone(statusRaw: String): Tone = when (statusRaw) {
        "online" -> Tone.GOOD
        "offline" -> Tone.BAD
        "pending" -> Tone.WAITING
        else -> Tone.NEUTRAL
    }

    /** One line for every server, as iOS's "Pod status" intent reads it out. */
    fun summary(snapshot: PodStatusSnapshot): String {
        val total = snapshot.pods.size
        if (total == 0) return "You don't have any servers yet."
        val online = snapshot.pods.count { it.statusRaw == "online" }
        val offline = snapshot.pods.count { it.statusRaw == "offline" }
        val noun = if (total == 1) "server is" else "servers are"
        return when {
            offline == 0 && online == total -> if (total == 1) "Your server is online." else "All $total $noun online."
            online == 0 && offline == total -> if (total == 1) "Your server is offline." else "All $total $noun offline."
            else -> "$online of $total online" + if (offline > 0) ", $offline offline." else "."
        }
    }
}
