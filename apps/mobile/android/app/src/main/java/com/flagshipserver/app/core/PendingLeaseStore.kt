package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences
import com.flagshipserver.app.api.BoxSealedLeaseWire
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * An auto-unlock lease the boot worker has not accepted yet.
 *
 * The lease body and its IRK signature are complete before the PUT, so a
 * deposit that failed for a passing reason (no connection, a 5xx) is kept as
 * it was built and sent again the next time the Activity tab opens, with a
 * fresh owner header. Nothing here is secret: the key inside is sealed for the
 * box's own STK, exactly what the worker would have stored.
 */
@Serializable
data class PendingLease(val lease: BoxSealedLeaseWire, val signatureHex: String)

interface PendingLeases {
    fun put(serverDomain: String, pending: PendingLease)
    fun clear(serverDomain: String)
    fun all(): Map<String, PendingLease>
}

class PendingLeaseStore(private val prefs: SharedPreferences) : PendingLeases {
    private val json = Json { ignoreUnknownKeys = true }

    override fun put(serverDomain: String, pending: PendingLease) {
        prefs.edit().putString(key(serverDomain), json.encodeToString(pending)).apply()
    }

    override fun clear(serverDomain: String) {
        prefs.edit().remove(key(serverDomain)).apply()
    }

    override fun all(): Map<String, PendingLease> = prefs.all.mapNotNull { (k, v) ->
        if (!k.startsWith(PREFIX) || v !is String) return@mapNotNull null
        runCatching { k.removePrefix(PREFIX) to json.decodeFromString<PendingLease>(v) }.getOrNull()
    }.toMap()

    private fun key(serverDomain: String) = PREFIX + serverDomain.lowercase()

    companion object {
        private const val PREFS = "flagship.pendingLeases"
        private const val PREFIX = "lease."
        fun from(context: Context): PendingLeaseStore =
            PendingLeaseStore(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
    }
}
