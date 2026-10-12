// The update order this phone sent and the box hasn't reported on yet, kept
// per server FQDN so closing the update sheet (or leaving the page) doesn't
// forget it and invite a duplicate order. Device-local and non-secret (the
// signed order itself lives on `.com`), so plain SharedPreferences. Mirror of
// the iOS / webapp pending-update record.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences
import com.flagshipserver.app.api.LastUpdate
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class PendingUpdate(
    val targetCommit: String,
    val targetTag: String? = null,
    val fromCommit: String,
    val orderedAt: Long,
) {
    /** The release tag when the order came from the release list, else the
     *  short commit. */
    val label: String
        get() = targetTag?.trim()?.takeIf { it.isNotEmpty() } ?: targetCommit.take(8)

    /** True once the box shows the outcome: it runs the target, or its
     *  `lastUpdate` verdict (applied / rolled back / refused) names this target
     *  and is no older than the order. A daemon without `lastUpdate` settles on
     *  `currentCommit` alone. */
    fun isSettled(currentCommit: String?, lastUpdate: LastUpdate?): Boolean {
        val target = targetCommit.lowercase()
        if (currentCommit?.lowercase() == target) return true
        val last = lastUpdate ?: return false
        if (last.at < orderedAt) return false
        // A refusal names no target (the box records only why), so any refusal
        // after the order is the answer to it.
        if (last.outcome == "refused" && last.targetCommit == null) return true
        return last.targetCommit?.lowercase() == target
    }

    fun isStale(nowMs: Long): Boolean = nowMs - orderedAt >= STALE_AFTER_MS

    fun sentLine(nowMs: Long): String =
        "Update to $label sent ${FlagshipDateFormat.format(orderedAt, nowMs, includeTime = true)}. " +
            "The server picks it up within about five minutes, restarts, and goes back on its own if the new version doesn't start."

    companion object {
        const val STALE_AFTER_MS = 30 * 60_000L
        const val REFRESH_EVERY_MS = 15_000L
        const val STALE_COPY = "The server hasn't applied this update yet. It may be offline."
    }
}

interface PendingUpdateStore {
    fun get(serverFqdn: String): PendingUpdate?
    fun set(serverFqdn: String, pending: PendingUpdate)
    fun clear(serverFqdn: String)
}

/** Storage failures never break the update flow: a failed read is "nothing
 *  pending", a failed write just isn't remembered past this screen. */
class SharedPrefsPendingUpdateStore(private val prefs: SharedPreferences) : PendingUpdateStore {
    override fun get(serverFqdn: String): PendingUpdate? = runCatching {
        prefs.getString(key(serverFqdn), null)?.let { json.decodeFromString(PendingUpdate.serializer(), it) }
    }.getOrNull()

    override fun set(serverFqdn: String, pending: PendingUpdate) {
        runCatching {
            prefs.edit().putString(key(serverFqdn), json.encodeToString(PendingUpdate.serializer(), pending)).apply()
        }
    }

    override fun clear(serverFqdn: String) {
        runCatching { prefs.edit().remove(key(serverFqdn)).apply() }
    }

    companion object {
        private const val PREFS = "flagship.pendingUpdate"
        private val json = Json { ignoreUnknownKeys = true }
        private fun key(serverFqdn: String) = "pending.${serverFqdn.lowercase()}"

        fun from(context: Context): SharedPrefsPendingUpdateStore =
            SharedPrefsPendingUpdateStore(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
    }
}

class InMemoryPendingUpdateStore : PendingUpdateStore {
    private val map = mutableMapOf<String, PendingUpdate>()
    override fun get(serverFqdn: String) = map[serverFqdn.lowercase()]
    override fun set(serverFqdn: String, pending: PendingUpdate) { map[serverFqdn.lowercase()] = pending }
    override fun clear(serverFqdn: String) { map.remove(serverFqdn.lowercase()) }
}
