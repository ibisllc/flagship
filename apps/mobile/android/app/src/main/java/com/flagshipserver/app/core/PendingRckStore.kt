package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences

/**
 * The routing key (RCK) a pending order for a name was minted with.
 *
 * `.com` pins a name to the first RCK registered for it. Every mint made a new
 * random key, so a retry, a reconnect after the builder's socket dropped or a
 * second tap on the same order was refused with "subdomain already controlled
 * by a different RCK" and left the first registration orphaned. A mint for a
 * name that still has a recent pending key reuses that key, so registering it
 * again is the same claim.
 *
 * Only the public key is kept: nothing here is a secret, and a stale entry can
 * never block a name (a released name accepts any key).
 */
class PendingRckStore(
    private val prefs: SharedPreferences,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    /** The key to mint with for [serverDomain]: the pending one when it is
     *  still fresh, otherwise [fresh], which is then remembered. */
    fun reuseOrRecord(serverDomain: String, fresh: String): String {
        val k = key(serverDomain)
        val saved = prefs.getString(k, null)?.split('|')
        val savedPub = saved?.getOrNull(0)
        val savedAt = saved?.getOrNull(1)?.toLongOrNull()
        if (savedPub != null && savedAt != null && now() - savedAt in 0..TTL_MS) return savedPub
        prefs.edit().putString(k, "$fresh|${now()}").apply()
        return fresh
    }

    /** The order was cancelled or its server registered: forget the key. */
    fun clear(serverDomain: String) {
        prefs.edit().remove(key(serverDomain)).apply()
    }

    private fun key(serverDomain: String) = PREFIX + serverDomain.lowercase()

    companion object {
        private const val PREFS = "flagship.pendingRck"
        private const val PREFIX = "rck."
        /** A recipe lives at most 24 hours (the longest TTL the wizard offers). */
        const val TTL_MS = 24L * 60L * 60L * 1000L

        fun from(context: Context): PendingRckStore =
            PendingRckStore(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
    }
}
