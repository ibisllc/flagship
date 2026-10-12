// The owner's "Make leader" choice, remembered on this device per account so a
// cold launch doesn't fall back to the oldest server (docs/app-placement.md §1).
// Mirror of iOS FlagshipCore/LeaderMemory.swift; the webapp keeps the same
// choice in localStorage. A pod id is derived from the server's fqdn, so it is
// stable across launches.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences

interface LeaderMemory {
    fun leaderPodId(account: String): String?
    fun setLeaderPodId(account: String, podId: String?)
}

private const val LEADER_PREFS = "flagship.leader"
private const val KEY_PREFIX = "leaderPodId.v1."

class PrefsLeaderMemory(private val prefs: SharedPreferences) : LeaderMemory {
    private fun key(account: String) = KEY_PREFIX + account.lowercase()

    override fun leaderPodId(account: String): String? {
        if (account.isEmpty()) return null
        return prefs.getString(key(account), null)
    }

    override fun setLeaderPodId(account: String, podId: String?) {
        if (account.isEmpty()) return
        prefs.edit().apply {
            if (podId.isNullOrEmpty()) remove(key(account)) else putString(key(account), podId)
        }.apply()
    }

    companion object {
        fun fromContext(ctx: Context): PrefsLeaderMemory =
            PrefsLeaderMemory(ctx.getSharedPreferences(LEADER_PREFS, Context.MODE_PRIVATE))
    }
}
