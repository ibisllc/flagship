package com.flagshipserver.app.core

import android.content.Context
import android.content.SharedPreferences

/**
 * The account and device names Home's header shows ("Elated Iris > Pixel"),
 * kept on the phone. They were only held in memory and re-learned when the
 * Trusted devices page happened to be opened, so after a relaunch the header
 * fell back to the bare account handle ("elated-iris").
 *
 * Not secret: they are the names the person chose, already shown in the app.
 */
class PresentationNameStore(private val prefs: SharedPreferences) {

    data class Names(val account: String?, val device: String?)

    fun get(cloudName: String): Names {
        val k = key(cloudName)
        return Names(
            account = prefs.getString("$k.account", null)?.takeIf { it.isNotEmpty() },
            device = prefs.getString("$k.device", null)?.takeIf { it.isNotEmpty() },
        )
    }

    /** Remember the names given; a null one leaves what is saved. */
    fun put(cloudName: String, account: String?, device: String?) {
        val k = key(cloudName)
        prefs.edit().apply {
            account?.takeIf { it.isNotEmpty() }?.let { putString("$k.account", it) }
            device?.takeIf { it.isNotEmpty() }?.let { putString("$k.device", it) }
        }.apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    private fun key(cloudName: String) = "names." + cloudName.lowercase()

    companion object {
        private const val PREFS = "flagship.presentationNames"

        fun from(context: Context): PresentationNameStore =
            PresentationNameStore(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
    }
}
