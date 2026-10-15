// Which shared servers this phone asked `.com` to wake it for
// (docs/share-a-server.md §5.4): the platform and token hash it registered,
// so turning the notices off names the same token.

package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences

class SharePushPrefs(private val prefs: SharedPreferences) : SharePushStore {
    override fun get(shareId: String): SharePushRegistration? {
        val raw = prefs.getString(PREFIX + shareId, null) ?: return null
        val platform = raw.substringBefore('|', "")
        val sha = raw.substringAfter('|', "")
        return if (platform.isNotEmpty() && sha.length == 64) SharePushRegistration(platform, sha) else null
    }

    override fun put(shareId: String, registration: SharePushRegistration) {
        prefs.edit().putString(PREFIX + shareId, "${registration.platform}|${registration.tokenSha256}").apply()
    }

    override fun remove(shareId: String) {
        prefs.edit().remove(PREFIX + shareId).apply()
    }

    companion object {
        private const val PREFS = "flagship.sharePush"
        private const val PREFIX = "share."

        fun from(context: Context): SharePushPrefs = SharePushPrefs(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
    }
}
